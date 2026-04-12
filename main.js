const { app, BrowserWindow, ipcMain, screen, Menu, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { spawn, exec, execFile } = require('child_process');
const autoSnap = require('./auto-snap');

// 非同期 osascript 実行。execSync だと main process が完全にブロックされ
// sidebar のドラッグ/クリックが最大数秒フリーズする (macOS Automation 権限
// チェック中に osascript がブロックするため特に顕著)。execFile はコマンドを
// そのまま渡せるのでシェル escape も不要。
function runOsascript(script, timeoutMs = 2500) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      resolve({ err, stdout });
    });
  });
}
const pkg = require('./package.json');

// Always enable remote debugging for MCP integration
app.commandLine.appendSwitch('remote-debugging-port', '9222');
// 低消費電力モード / App Nap で daemon 通信や pollTimer が throttle されるのを防止
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ── Integration protocol (docs/PROTOCOL.md) ──
// 外部ツール (AtelierX plugin 等) と連携するための状態ファイル書き出し。
// 依存関係: AtelierX 固有のコードは一切含めない — 汎用 URL scheme/ファイル IPC として公開する。
const PROTOCOL_VERSION = '1.0';
const TIN_CAPABILITIES = ['snap', 'raise', 'workspace', 'grid-terminal', 'window-list'];
const INTEGRATION_DIR = path.join(app.getPath('userData'));
const INFO_JSON = path.join(INTEGRATION_DIR, 'info.json');
const SNAPPED_JSON = path.join(INTEGRATION_DIR, 'snapped.json');
// workspace 永続化ファイル (再起動時に復帰するため)。
// info.json / snapped.json は外部ツール連携用、これは TiN 内部用。
const WORKSPACES_JSON = path.join(INTEGRATION_DIR, 'workspaces.json');
const WORKSPACES_FORMAT_VERSION = 1;
// 保存済みセッションが古すぎる場合は復元しない閾値 (24時間)
const WORKSPACES_STALE_MS = 24 * 60 * 60 * 1000;
// workspace プリセット (メモリ機能)
const PRESETS_DIR = path.join(INTEGRATION_DIR, 'presets');
const TIN_START_TIME = Date.now();

// Integration dir は起動時に1回だけ確保 (毎回 existsSync しない)
let _integrationDirReady = false;
function ensureIntegrationDir() {
  if (_integrationDirReady) return;
  try { fs.mkdirSync(INTEGRATION_DIR, { recursive: true }); } catch {}
  _integrationDirReady = true;
}

// 同期版: before-quit など非同期が使えない場面用
function atomicWriteJSONSync(filePath, obj) {
  try {
    ensureIntegrationDir();
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.warn('[integration] write failed:', filePath, e.message);
  }
}

// 非同期版: 通常時はこちらを使い event loop をブロックしない
const fsP = fs.promises;
async function atomicWriteJSON(filePath, obj) {
  try {
    ensureIntegrationDir();
    const tmp = filePath + '.tmp';
    await fsP.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    await fsP.rename(tmp, filePath);
  } catch (e) {
    console.warn('[integration] write failed:', filePath, e.message);
  }
}

async function writeInfoJson() {
  await atomicWriteJSON(INFO_JSON, {
    protocol: PROTOCOL_VERSION,
    app: 'TiN',
    version: pkg.version,
    startedAt: TIN_START_TIME,
    updatedAt: Date.now(),
    capabilities: TIN_CAPABILITIES,
    endpoints: {
      snappedFile: 'snapped.json',
      urlScheme: 'tin',
    },
  });
}

function buildSnappedPayload() {
  const snappedWindows = [];
  let activeWorkspaceId = null;
  const focused = BrowserWindow.getFocusedWindow();
  for (const [, ws] of workspaces) {
    if (!ws || !ws.win || ws.win.isDestroyed()) continue;
    if (focused && (ws.win === focused || ws.gridOverlay === focused)) {
      activeWorkspaceId = String(ws.id);
    }
    for (const [, info] of ws.snappedExternals) {
      snappedWindows.push({
        app: info.app || '',
        pid: info.pid || 0,
        windowNumber: info.windowNumber || 0,
        title: info.title || '',
        windowIndex: info.windowIndex || 0,
        slot: info.slot,
        workspaceId: String(ws.id),
        snappedAt: info.snappedAt || 0,
      });
    }
  }
  return { protocol: PROTOCOL_VERSION, updatedAt: Date.now(), activeWorkspaceId, snappedWindows };
}

async function writeSnappedJson() {
  await atomicWriteJSON(SNAPPED_JSON, buildSnappedPayload());
}

// snap-external で daemon.move の BEFORE に同期書き出しが必要な場面用
function writeSnappedJsonSync() {
  atomicWriteJSONSync(SNAPPED_JSON, buildSnappedPayload());
}

// 書き出しのデバウンス (rapid snap/unsnap/move で多重書き込みを避ける)
let _syncTimer = null;
function scheduleSyncSnapped(delay = 80) {
  if (_syncTimer) return;
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    writeSnappedJson().catch(() => {});
  }, delay);
}

// ── Workspace 永続化 ──
// 再起動時に snap / grid config / sidebar 位置を復帰するために
// `workspaces.json` に定期的に書き出す。
async function writeWorkspacesJson() {
  const payload = {
    version: WORKSPACES_FORMAT_VERSION,
    savedAt: Date.now(),
    workspaces: [],
  };
  for (const [, ws] of workspaces) {
    if (!ws || !ws.win || ws.win.isDestroyed()) continue;
    const b = ws.win.getBounds();
    const snapped = [];
    for (const [, info] of ws.snappedExternals) {
      snapped.push({
        windowNumber: info.windowNumber,
        app: info.app,
        pid: info.pid,
        title: info.title,
        windowIndex: info.windowIndex || 0,
        slot: info.slot,
        origX: info.origX, origY: info.origY,
        origW: info.origW, origH: info.origH,
        snappedAt: info.snappedAt || 0,
      });
    }
    payload.workspaces.push({
      name: ws.name,
      sidebar: { x: b.x, y: b.y, width: b.width, height: b.height },
      grid: { cols: ws.gridCols, rows: ws.gridRows, width: ws.gridWidth || 800, height: ws.gridHeight || 0 },
      colorIndex: ws.colorIndex,
      snappedExternals: snapped,
    });
  }
  await atomicWriteJSON(WORKSPACES_JSON, payload);
}

let _saveWsTimer = null;
function scheduleSaveWorkspaces(delay = 500) {
  // quit 進行中は空の状態で上書きしないよう保存をスキップ
  // (before-quit で同期的に writeWorkspacesJson を呼ぶので最終状態は保存済み)
  if (app.isQuitting) return;
  if (_saveWsTimer) clearTimeout(_saveWsTimer);
  _saveWsTimer = setTimeout(() => {
    _saveWsTimer = null;
    if (app.isQuitting) return;
    writeWorkspacesJson().catch(e => console.warn('[tin] save workspaces failed:', e.message));
  }, delay);
}

function loadPersistedWorkspaces() {
  try {
    if (!fs.existsSync(WORKSPACES_JSON)) return null;
    const raw = fs.readFileSync(WORKSPACES_JSON, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || data.version !== WORKSPACES_FORMAT_VERSION) return null;
    if (typeof data.savedAt !== 'number') return null;
    // 古すぎるセッションは復元しない (24h 経過)
    const ageMs = Date.now() - data.savedAt;
    if (ageMs > WORKSPACES_STALE_MS) {
      console.log(`[tin] persisted workspaces are stale (${Math.round(ageMs/3600000)}h old), skipping restore`);
      return null;
    }
    if (!Array.isArray(data.workspaces) || data.workspaces.length === 0) return null;
    return data;
  } catch (e) {
    console.warn('[tin] loadPersistedWorkspaces failed:', e.message);
    return null;
  }
}

// 復元対象のウィンドウを現在の live list に match させる。
// 優先度: windowNumber → (app + title 完全一致) → (app + title 前方 40 文字一致)
function matchPersistedToLive(persisted, liveWindows) {
  // 1. windowNumber で厳密一致
  const byNum = liveWindows.find(w => w.windowNumber === persisted.windowNumber);
  if (byNum) return byNum;
  // 2. app + title 完全一致
  const byFull = liveWindows.find(w => w.app === persisted.app && w.title === persisted.title);
  if (byFull) return byFull;
  // 3. app + title 前方 40 文字一致
  if (persisted.title && persisted.title.length > 0) {
    const prefix = persisted.title.slice(0, Math.min(40, persisted.title.length));
    const byPrefix = liveWindows.find(w =>
      w.app === persisted.app &&
      w.title && w.title.startsWith(prefix)
    );
    if (byPrefix) return byPrefix;
  }
  return null;
}

// 永続化された snapped エントリを現在のウィンドウにマッチさせ、grid に配置する。
// 結果 (復元成功/失敗) を renderer に送って通知バナーを表示させる。
async function restoreSnappedWindows(ws, persistedList) {
  if (!ws || !ws.win || ws.win.isDestroyed()) return;
  if (!persistedList || persistedList.length === 0) return;

  // daemon.list を取得 (最大 2 回リトライ: daemon 起動遅延対策)
  let liveWindows = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    liveWindows = await listWindows();
    if (liveWindows.length > 0) break;
    await new Promise(r => setTimeout(r, 400));
  }

  const restored = [];
  const missing = [];
  const moveCmds = [];

  for (const p of persistedList) {
    const live = matchPersistedToLive(p, liveWindows);
    if (!live) {
      missing.push({ app: p.app, title: p.title, slot: p.slot });
      continue;
    }
    // slot は保存時のもの — 競合しないかチェック
    if (ws.snappedExternals.has(live.windowNumber)) continue;
    const total = ws.gridCols * ws.gridRows;
    let slot = p.slot;
    if (slot >= total) {
      // grid サイズが縮んでる可能性 → 空きスロットに割当
      slot = nextFreeSlot(ws);
      if (slot < 0) {
        missing.push({ app: p.app, title: p.title, slot: p.slot, reason: 'no-slot' });
        continue;
      }
    }
    // 既にそのスロットを使っている window があればスキップ (保守的)
    let slotOccupied = false;
    for (const [, info] of ws.snappedExternals) {
      if (info.slot === slot) { slotOccupied = true; break; }
    }
    if (slotOccupied) {
      slot = nextFreeSlot(ws);
      if (slot < 0) {
        missing.push({ app: p.app, title: p.title, slot: p.slot, reason: 'no-slot' });
        continue;
      }
    }
    ws.snappedExternals.set(live.windowNumber, {
      app: live.app, pid: live.pid, title: live.title,
      windowNumber: live.windowNumber, windowIndex: live.windowIndex || 0, slot,
      origX: p.origX, origY: p.origY, origW: p.origW, origH: p.origH,
      snappedAt: p.snappedAt || Date.now(),
    });
    snappedIndexAdd(live.windowNumber, ws);
    const pos = getSlotBounds(ws, slot);
    if (pos) {
      moveCmds.push({
        windowNumber: live.windowNumber, pid: live.pid,
        app: live.app, title: live.title, ...pos,
      });
    }
    restored.push({ app: live.app, title: live.title, slot });
  }

  // まとめて move (daemon 経由、1 回の呼び出しで全件)
  if (moveCmds.length > 0) {
    await batchMove(moveCmds);
  }

  // renderer にレポート送信 (サイドバー上部にバナー表示)
  // restored にはマッチした windowNumber/app/title を入れて renderer の
  // snappedExternals Map を初期化させる
  try {
    ws.win.webContents.send('restore-report', {
      restored, missing,
      savedAgoMinutes: Math.round((Date.now() - (ws._savedAt || Date.now())) / 60000),
    });
    // renderer の snappedExternals Map を初期化するための別 IPC
    const hydrate = [];
    for (const [wn, info] of ws.snappedExternals) {
      hydrate.push({ windowNumber: wn, title: info.title, app: info.app });
    }
    ws.win.webContents.send('hydrate-snapped', hydrate);
  } catch {}

  // サイドバー側の snappedExternals Map も同期するため
  // external-windows 更新を即座に trigger (pollTimer を待たずに)
  scheduleSyncSnapped();
  console.log(`[tin] restored ${restored.length} snapped windows, ${missing.length} missing`);
}

// ── Display 移動: workspace + snapped ターミナルを丸ごと別ディスプレイへ ──
async function moveWorkspaceToDisplay(direction) {
  // フォーカス中の workspace を特定
  const focused = BrowserWindow.getFocusedWindow();
  let ws = null;
  for (const [, w] of workspaces) {
    if (w.win === focused || w.gridOverlay === focused) { ws = w; break; }
    for (const [, gw] of w.gridWindows) {
      if (gw.win === focused) { ws = w; break; }
    }
    if (ws) break;
  }
  if (!ws || !ws.win || ws.win.isDestroyed()) return;

  const displays = screen.getAllDisplays();
  if (displays.length <= 1) return;

  // sidebar が今どのディスプレイにいるか
  const sb = ws.win.getBounds();
  const sbCenter = { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 };
  let currentIdx = 0;
  for (let i = 0; i < displays.length; i++) {
    const wa = displays[i].workArea;
    if (sbCenter.x >= wa.x && sbCenter.x < wa.x + wa.width &&
        sbCenter.y >= wa.y && sbCenter.y < wa.y + wa.height) {
      currentIdx = i; break;
    }
  }

  // 次/前のディスプレイ
  const nextIdx = (currentIdx + direction + displays.length) % displays.length;
  const from = displays[currentIdx].workArea;
  const to = displays[nextIdx].workArea;
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  // sidebar 移動
  ws.win.setBounds({ x: sb.x + dx, y: sb.y + dy, width: sb.width, height: sb.height });

  // overlay 移動
  if (ws.gridOverlay && !ws.gridOverlay.isDestroyed()) {
    const ob = ws.gridOverlay.getBounds();
    ws.gridOverlay.setBounds({ x: ob.x + dx, y: ob.y + dy, width: ob.width, height: ob.height });
  }

  // grid windows 移動
  for (const [, gw] of ws.gridWindows) {
    if (gw.win && !gw.win.isDestroyed()) {
      const gb = gw.win.getBounds();
      gw.win.setBounds({ x: gb.x + dx, y: gb.y + dy, width: gb.width, height: gb.height });
    }
  }

  // snapped externals 移動 (daemon fire-and-forget で高速)
  const moveCmds = [];
  for (const [, info] of ws.snappedExternals) {
    const b = getSlotBounds(ws, info.slot);
    if (b) moveCmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title, ...b });
  }
  if (moveCmds.length) await batchMove(moveCmds);

  await raiseAllWorkspaceWindows(ws, true);
  scheduleSaveWorkspaces();
  console.log(`[tin] moved workspace "${ws.name}" to display ${nextIdx}`);
}

// ── Batch restore (全 workspace の復元を1回の daemon 呼び出しでまとめる) ──
let _restoreTimer = null;
function scheduleRestoreAll() {
  if (_restoreTimer) return;
  _restoreTimer = setTimeout(() => {
    _restoreTimer = null;
    restoreAllPending().catch(e => console.warn('[tin] batch restore failed:', e.message));
  }, 1000);
}

async function restoreAllPending() {
  // daemon が ready するまで待つ
  for (let i = 0; i < 5 && !daemonReady; i++) await new Promise(r => setTimeout(r, 300));

  // 1回だけ listWindows
  let liveWindows = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    liveWindows = await listWindows();
    if (liveWindows.length > 0) break;
    await new Promise(r => setTimeout(r, 400));
  }

  // 全 workspace の pending を一括処理
  const allMoveCmds = [];
  for (const [, ws] of workspaces) {
    if (!ws._pendingRestore || !ws.win || ws.win.isDestroyed()) continue;
    const persistedList = ws._pendingRestore;
    delete ws._pendingRestore;

    const restored = [];
    const missing = [];
    for (const p of persistedList) {
      const live = matchPersistedToLive(p, liveWindows);
      if (!live) { missing.push({ app: p.app, title: p.title, slot: p.slot }); continue; }
      if (ws.snappedExternals.has(live.windowNumber)) continue;
      let slot = p.slot;
      const total = ws.gridCols * ws.gridRows;
      if (slot >= total) { slot = nextFreeSlot(ws); if (slot < 0) continue; }
      let occupied = false;
      for (const [, info] of ws.snappedExternals) { if (info.slot === slot) { occupied = true; break; } }
      if (occupied) { slot = nextFreeSlot(ws); if (slot < 0) continue; }
      ws.snappedExternals.set(live.windowNumber, {
        app: live.app, pid: live.pid, title: live.title,
        windowNumber: live.windowNumber, windowIndex: live.windowIndex || 0, slot,
        origX: p.origX, origY: p.origY, origW: p.origW, origH: p.origH,
        snappedAt: p.snappedAt || Date.now(),
      });
      snappedIndexAdd(live.windowNumber, ws);
      const pos = getSlotBounds(ws, slot);
      if (pos) allMoveCmds.push({ windowNumber: live.windowNumber, pid: live.pid, app: live.app, title: live.title, ...pos });
      restored.push({ app: live.app, title: live.title, slot });
    }
    // renderer に通知
    try {
      ws.win.webContents.send('restore-report', { restored, missing });
      const hydrate = [];
      for (const [wn, info] of ws.snappedExternals) hydrate.push({ windowNumber: wn, title: info.title, app: info.app });
      ws.win.webContents.send('hydrate-snapped', hydrate);
    } catch {}
    console.log(`[tin] restored ${restored.length} snapped, ${missing.length} missing in "${ws.name}"`);
  }

  // 全ウィンドウを1回の batchMove で移動
  if (allMoveCmds.length > 0) {
    await batchMove(allMoveCmds);
    console.log(`[tin] batch restore: moved ${allMoveCmds.length} windows in 1 call`);
  }
  scheduleSyncSnapped();
}

// ── Workspace colors ──
// workspace ごとに固有色を割り当て、snapped バッジの色に使う
const WS_COLORS = [
  { name: 'blue',   h: 215, bg: 'rgba(50,120,220,0.12)',  fg: 'rgba(40,100,200,0.9)',  accent: 'rgba(50,120,220,0.7)' },
  { name: 'purple', h: 270, bg: 'rgba(130,70,220,0.12)',  fg: 'rgba(110,55,200,0.9)',  accent: 'rgba(130,70,220,0.7)' },
  { name: 'green',  h: 150, bg: 'rgba(40,170,100,0.12)',  fg: 'rgba(30,140,80,0.9)',   accent: 'rgba(40,170,100,0.7)' },
  { name: 'orange', h: 30,  bg: 'rgba(220,140,30,0.12)',  fg: 'rgba(190,110,20,0.9)',  accent: 'rgba(220,140,30,0.7)' },
  { name: 'red',    h: 0,   bg: 'rgba(210,60,50,0.12)',   fg: 'rgba(190,50,40,0.9)',   accent: 'rgba(210,60,50,0.7)' },
  { name: 'teal',   h: 180, bg: 'rgba(30,170,170,0.12)',  fg: 'rgba(20,140,140,0.9)',  accent: 'rgba(30,170,170,0.7)' },
];

// ── Workspace registry ──
const workspaces = new Map();
let nextWsId = 1;
let nextPtyId = 1;

// ── Swift daemon (list + move only) ──
// パッケージ版: Contents/MacOS/daemon (アプリバンドルの一部として TCC に認識される)
// dev 版: プロジェクトルートの daemon
const DAEMON_BIN = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'daemon')
  : path.join(__dirname, 'daemon');
let daemon = null;
let daemonReady = false;
const pendingRequests = new Map();
let nextReqId = 1;

process.on('uncaughtException', (err) => { if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return; });

function startDaemon() {
  daemon = spawn(DAEMON_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  daemon.stdin.on('error', () => {});
  let buffer = '';
  daemon.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.ready) { daemonReady = true; continue; }
        const pending = pendingRequests.get(msg.id);
        if (pending) { clearTimeout(pending.timer); pendingRequests.delete(msg.id); pending.resolve(msg.result); }
      } catch {}
    }
  });
  daemon.stderr.on('data', (d) => process.stderr.write('[daemon] ' + d));
  daemon.on('close', () => { daemonReady = false; if (!app.isQuitting) setTimeout(startDaemon, 500); });
  daemon.on('error', () => {});
}

function daemonRequest(cmd, extra = {}) {
  return new Promise((resolve) => {
    if (!daemon || !daemonReady) return resolve(cmd === 'list' ? [] : {});
    const id = String(nextReqId++);
    const timer = setTimeout(() => { pendingRequests.delete(id); resolve(cmd === 'list' ? [] : {}); }, 3000);
    pendingRequests.set(id, { resolve, timer });
    try { daemon.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n'); }
    catch { pendingRequests.delete(id); clearTimeout(timer); resolve(cmd === 'list' ? [] : {}); }
  });
}

function listWindows() { return daemonRequest('list'); }

// Fire-and-forget: daemon に move を送るが応答を待たない。
// sidebar ドラッグ中のリアルタイム retile 用。応答待ちで event loop を
// ブロックしないので、次の move イベントをすぐ処理できる。
function daemonMoveFireAndForget(windows, positionOnly = false) {
  if (!daemon || !daemonReady || !windows.length) return;
  try {
    const id = String(nextReqId++);
    const msg = { id, cmd: 'move', windows };
    if (positionOnly) msg.positionOnly = true;
    daemon.stdin.write(JSON.stringify(msg) + '\n');
  } catch {}
}

// Verify windows still exist via AX (includes off-screen windows, unlike list)
function verifyWindows(cmds) { return daemonRequest('verify', { windows: cmds }); }

// ── Stabilization guard ──
// Display reconnection and sleep/resume cause windows to temporarily
// disappear from CGWindowList even though they are still alive in AX.
// We set `stabilizingUntil` on these events to suppress release logic
// for a while afterward.
let stabilizingUntil = 0;
const STABILIZE_MS = 15000;
let retileAfterStabilize = null;
function beginStabilize(reason) {
  stabilizingUntil = Date.now() + STABILIZE_MS;
  // Reset all miss counters on every workspace
  for (const [, ws] of workspaces) {
    for (const [, info] of ws.snappedExternals) info._missCount = 0;
  }
  console.log(`[tin] stabilizing for ${STABILIZE_MS}ms (reason: ${reason})`);
  // After stabilization, reposition all snapped windows — display changes
  // can leave them on the wrong coordinates even though they're still alive.
  // Delay also helps when workspace sidebars have been moved to a still-
  // valid display by the OS and we want their new bounds as the reference.
  if (retileAfterStabilize) clearTimeout(retileAfterStabilize);
  retileAfterStabilize = setTimeout(async () => {
    retileAfterStabilize = null;
    for (const [, ws] of workspaces) {
      if (!ws.win || ws.win.isDestroyed()) continue;
      // Ensure the sidebar itself is on a valid display — if its saved
      // bounds are entirely off every connected display, move it to the
      // primary display.
      ensureOnScreen(ws);
      try { await retileAll(ws); } catch {}
    }
    console.log('[tin] retiled after stabilize');
  }, STABILIZE_MS + 500);
}
function isStabilizing() { return Date.now() < stabilizingUntil; }

// Move a workspace sidebar back onto a visible display if its bounds are
// entirely outside every display's work area (e.g. the display it was on
// got disconnected).
function ensureOnScreen(ws) {
  if (!ws.win || ws.win.isDestroyed()) return;
  const b = ws.win.getBounds();
  const displays = screen.getAllDisplays();
  const overlaps = displays.some(d => {
    const wa = d.workArea;
    return !(b.x + b.width < wa.x || b.x > wa.x + wa.width ||
             b.y + b.height < wa.y || b.y > wa.y + wa.height);
  });
  if (overlaps) return;
  const primary = screen.getPrimaryDisplay().workArea;
  ws.win.setBounds({
    x: primary.x + 50,
    y: primary.y + Math.round((primary.height - b.height) / 2),
    width: b.width,
    height: b.height,
  });
}

// ローカライズされたアプリ名を英語名 (AppleScript 互換) に変換
// 例: "ターミナル" → "Terminal"
function normalizeAppName(name) {
  if (!name) return name;
  const map = {
    'ターミナル': 'Terminal',
    'ファインダー': 'Finder',
  };
  return map[name] || name;
}

// Move windows: daemon (AX set, global coords) を第一経路、System Events
// (osascript) を fallback として使う。
//
// **注意**: 以前 `tell application "Terminal" set bounds` fallback が
// display-local 座標で解釈されるバグを起こしていたため完全廃止していたが、
// パッケージ版 TiN.app では daemon バイナリが親アプリとは別 cdhash で adhoc
// 署名されており、macOS の TCC がアクセシビリティ権限を daemon に継承しない
// ケースがあることが判明した (v1.2.5 以降)。結果 daemon の AX set は silent
// に失敗し snap が効かない。
//
// 復活させる fallback は **System Events の `set position`/`set size`** を
// 使う。これは `set bounds` と違ってグローバル座標で動作するので旧バグを
// 再発させない。System Events 自体は常にアクセシビリティ権限を保持している
// ので、daemon が権限不足で失敗しても動かせる。
// daemon の AX 状態を覚えておき、untrusted と確認できたら以降は daemon を呼ばず
// 直接 osascript fallback に行く (パッケージ版の rebuild 直後に TCC の cdhash が
// 変わって権限が外れるため)。
// daemon AX: ラッチしない。毎回 daemon を試し、失敗分だけ osascript fallback。
// _daemonAXUntrusted は UI バナー表示用のみ (動作制御には使わない)。
let _daemonAXUntrusted = false;

async function batchMove(cmds) {
  if (!cmds.length) return;
  const t0 = Date.now();
  const result = await daemonRequest('move', { windows: cmds });
  // daemon 応答がない (未 ready 等) → fallback
  if (!result || typeof result.moved !== 'number') {
    await osascriptMove(cmds);
    return;
  }
  // 全件成功
  const dt = Date.now() - t0;
  if (dt > 30) console.log(`[tin] batchMove: ${dt}ms moved=${result.moved} failed=${JSON.stringify(result.failed)} axTrusted=${result.axTrusted}`);
  if (result.moved === cmds.length && (!Array.isArray(result.failed) || result.failed.length === 0)) {
    return;
  }
  // 全件失敗 → fallback
  if (result.moved === 0) {
    await osascriptMove(cmds);
    return;
  }
  // 一部失敗 → 失敗分だけ fallback
  if (Array.isArray(result.failed) && result.failed.length > 0) {
    const failedSet = new Set(result.failed);
    const retry = cmds.filter(c => failedSet.has(c.windowNumber));
    if (retry.length) await osascriptMove(retry);
  }
}

// System Events を使ったウィンドウ移動 fallback。
// AXPosition/AXSize は global 座標で動作する (set bounds とは異なる)。
// title の先頭 40 文字でマッチングする (旧 raise fallback と同じ戦略)。
// **非同期実行必須** — execSync は main thread をブロックして sidebar drag を
// 凍らせる。runOsascript 経由で event loop を譲る。
// **アプリ名正規化必須** — CGWindowList は "ターミナル" を返すが System Events の
// `tell process` は英語名 "Terminal" を期待する場面がある (ローカライズ名で指定
// すると別プロセスにヒットする/位置が正しく適用されないケースあり)。
async function osascriptMove(cmds) {
  if (!cmds.length) return;
  const byApp = new Map();
  for (const cmd of cmds) {
    if (!cmd.app || !cmd.title) continue;
    const normalizedApp = normalizeAppName(cmd.app);
    if (!byApp.has(normalizedApp)) byApp.set(normalizedApp, []);
    byApp.get(normalizedApp).push(cmd);
  }
  const jobs = [];
  for (const [appName, wins] of byApp) {
    const lines = wins.map(w => {
      // タイトルの先頭 20 文字でマッチ (40→20: 短い方が検索高速 + 一意性は十分)
      const t = (w.title || '').substring(0, 20).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (!t) return '';
      const x = Math.round(w.x), y = Math.round(w.y);
      const ww = Math.round(w.width), wh = Math.round(w.height);
      return `    try\n      set _w to first window whose name contains "${t}"\n      set position of _w to {${x}, ${y}}\n      set size of _w to {${ww}, ${wh}}\n      set position of _w to {${x}, ${y}}\n    end try`;
    }).filter(Boolean).join('\n');
    if (!lines) continue;
    const script = `tell application "System Events" to tell process "${appName}"\n${lines}\nend tell`;
    // タイムアウト: 1.5s (3s だと体感が重い。タイムアウトしたら諦めて次へ)
    jobs.push(runOsascript(script, 1500));
  }
  if (jobs.length) await Promise.all(jobs);
}

// Raise: daemon (fast) with osascript fallback.
// daemon が AXRaise を使ってアプリをアクティブ化せず z-order だけ上げる。
// パッケージ版で daemon の AX 権限が継承されない場合、silent fail するので
// daemon が返す failed[] を元に System Events で再試行する。
// 注: fallback は `set frontmost to true` を **使わない** — 対象アプリ全体を
// アクティブ化すると TiN がその後ろに隠れてしまうため。
async function raiseSpecificWindows(cmds) {
  if (!cmds.length) return;
  let retry = cmds;
  {
    const result = await daemonRequest('raise', { windows: cmds });
    if (result && typeof result.raised === 'number') {
      if (result.raised === cmds.length && (!Array.isArray(result.failed) || result.failed.length === 0)) {
        return;
      }
      if (result.axTrusted === false && result.raised === 0) {
        // fall through to osascript
      } else if (Array.isArray(result.failed) && result.failed.length > 0) {
        const failedSet = new Set(result.failed);
        retry = cmds.filter(c => failedSet.has(c.windowNumber));
      } else {
        return;
      }
    }
  }
  // daemon 応答なし or 一部失敗 → System Events fallback (非同期)
  const byApp = new Map();
  for (const cmd of retry) {
    if (!cmd.app) continue;
    const normalizedApp = normalizeAppName(cmd.app);
    if (!byApp.has(normalizedApp)) byApp.set(normalizedApp, []);
    byApp.get(normalizedApp).push(cmd);
  }
  const jobs = [];
  for (const [appName, wins] of byApp) {
    const raiseLines = wins.map(w => {
      const t = (w.title || '').substring(0, 20).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `    try\n      perform action "AXRaise" of (first window whose name contains "${t}")\n    end try`;
    }).join('\n');
    const script = `tell application "System Events" to tell process "${appName}"\n${raiseLines}\nend tell`;
    jobs.push(runOsascript(script, 2000));
  }
  if (jobs.length) await Promise.all(jobs);
}

// ── Helpers ──
// O(1) workspace lookup by webContents (WeakMap — auto GC on window close)
const _wsByContents = new WeakMap();
function registerWorkspaceContents(ws) {
  if (ws.win && !ws.win.isDestroyed()) _wsByContents.set(ws.win.webContents, ws);
}
function findWorkspace(webContents) {
  return _wsByContents.get(webContents) || null;
}

// O(1) global snapped index: windowNumber → ws
const _globalSnappedIndex = new Map();
function snappedIndexAdd(windowNumber, ws) { _globalSnappedIndex.set(windowNumber, ws); }
function snappedIndexRemove(windowNumber) { _globalSnappedIndex.delete(windowNumber); }
function isExternalSnapped(windowNumber) {
  return _globalSnappedIndex.get(windowNumber) || null;
}

// ── Grid geometry ──
// Never rely on overlay.getBounds() — transparent windows report wrong bounds on macOS multi-display.
// Always calculate from workspace position + stored grid size.
//
// 以前は sidebar の置かれているディスプレイに grid area を強制 clamp していたが
// これは cross-display snap を壊していた (ユーザー報告)。
// 現在は raw 座標をそのまま返す。AX (System Events) はグローバル座標で動作するため
// 境界をまたいでも正しく配置される。ディスプレイ外にはみ出しても macOS が適切に
// ウィンドウを可視領域に寄せる。
function getGridArea(ws) {
  if (!ws.win || ws.win.isDestroyed()) return null;
  const b = ws.win.getBounds();
  return {
    x: b.x + b.width + 12,
    y: b.y,
    width: ws.gridWidth || 800,
    height: ws.gridHeight || b.height,
  };
}

function getSlotBounds(ws, slot) {
  const area = getGridArea(ws);
  if (!area) return null;
  const cols = ws.gridCols, rows = ws.gridRows;
  const gap = 4;
  const cw = Math.floor((area.width - gap * (cols - 1)) / cols);
  const ch = Math.floor((area.height - gap * (rows - 1)) / rows);
  const col = slot % cols, row = Math.floor(slot / cols);
  return {
    x: area.x + col * (cw + gap),
    y: area.y + row * (ch + gap),
    width: cw, height: ch,
  };
}

// ── Raise all workspace windows (grid + snapped externals) ──
let lastRaiseTime = 0;

async function raiseAllWorkspaceWindows(ws, force = false) {
  if (!ws) return;
  const now = Date.now();
  if (!force && now - lastRaiseTime < 300) return;
  lastRaiseTime = now;
  const t0 = Date.now();

  // 1. Raise snapped externals + retile を1ステップで実行。
  //    daemon に raise コマンドを送り、同時に grid windows を show する。
  //    await しないと z-order が崩れるが、grid show は同期なので先に実行。

  // Grid BrowserWindows を先に show (同期、即座)
  for (const [, gw] of ws.gridWindows) {
    if (gw.win && !gw.win.isDestroyed()) gw.win.show();
  }
  if (ws.gridOverlay && !ws.gridOverlay.isDestroyed()) ws.gridOverlay.show();

  // Snapped externals を daemon で一括 raise (非同期だが高速)
  if (ws.snappedExternals.size > 0) {
    const cmds = [...ws.snappedExternals.values()].map(info => ({
      windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
    }));
    await raiseSpecificWindows(cmds);
  }

  // TiN sidebar を最前面に (既にフォーカス中なら steal 不要)
  if (ws.win && !ws.win.isDestroyed()) {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) app.focus({ steal: true });
    ws.win.show();
    ws.win.focus();
  }
  const dt = Date.now() - t0;
  if (dt > 50) console.log(`[tin] raiseAll: ${dt}ms (${ws.snappedExternals.size} ext)`);
}

// ── Retile: reposition all grid items (embedded + external) ──
// fireAndForget=true: ドラッグ中のリアルタイム追従用。daemon 応答を待たない。
async function retileAll(ws, fireAndForget = false) {
  const moveCmds = [];

  // Reposition embedded grid windows (Electron BrowserWindow — 同期、即座)
  for (const [slot, gw] of ws.gridWindows) {
    if (gw.win && !gw.win.isDestroyed()) {
      const b = getSlotBounds(ws, slot);
      if (b) gw.win.setBounds(b);
    }
  }

  // Reposition snapped external windows
  for (const [, info] of ws.snappedExternals) {
    const b = getSlotBounds(ws, info.slot);
    if (b) moveCmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title, ...b });
  }

  if (moveCmds.length) {
    if (fireAndForget) {
      daemonMoveFireAndForget(moveCmds);
    } else {
      await batchMove(moveCmds);
    }
  }
}

function nextFreeSlot(ws) {
  const used = new Set();
  for (const [slot] of ws.gridWindows) used.add(slot);
  for (const [, info] of ws.snappedExternals) used.add(info.slot);
  const total = ws.gridCols * ws.gridRows;
  for (let i = 0; i < total; i++) if (!used.has(i)) return i;
  return -1;
}

function compactSlots(ws) {
  const all = [];
  for (const [slot, gw] of ws.gridWindows) all.push({ type: 'grid', slot, ref: gw });
  for (const [wn, info] of ws.snappedExternals) all.push({ type: 'ext', slot: info.slot, ref: info, wn });
  all.sort((a, b) => a.slot - b.slot);
  // Re-assign slots 0, 1, 2, ...
  for (let i = 0; i < all.length; i++) {
    const item = all[i];
    if (item.type === 'grid') {
      ws.gridWindows.delete(item.slot);
      item.ref.slot = i;
      ws.gridWindows.set(i, item.ref);
    } else {
      item.ref.slot = i;
    }
  }
}

// ── Create an embedded grid terminal (BrowserWindow + xterm.js) ──
function createGridTerminal(ws, slot) {
  const b = getSlotBounds(ws, slot);
  if (!b) return null;

  const gridWin = new BrowserWindow({
    ...b,
    frame: false,
    acceptFirstMouse: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  // Hide from macOS native Window menu listing (must be set via property, not constructor)
  gridWin.excludedFromShownWindowsMenu = true;

  const ptyId = nextPtyId++;
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color',
    cols: 80, rows: 24,
    cwd: process.env.HOME || '/',
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  p.onData(data => {
    if (!gridWin.isDestroyed()) gridWin.webContents.send('terminal-data', { id: ptyId, data });
  });
  p.onExit(() => {
    if (!gridWin.isDestroyed()) gridWin.webContents.send('terminal-exit', { id: ptyId });
  });

  const gw = { win: gridWin, pty: p, ptyId, slot };
  ws.gridWindows.set(slot, gw);

  gridWin.loadFile('grid-terminal.html');
  gridWin.webContents.on('did-finish-load', () => {
    gridWin.webContents.send('init-terminal', { id: ptyId });
  });

  gridWin.on('closed', () => {
    try { p.kill(); } catch {}
    ws.gridWindows.delete(slot);
  });

  return gw;
}

// ── IPC for grid terminal windows ──
ipcMain.on('grid-terminal-input', (event, { id, data }) => {
  for (const [, ws] of workspaces) {
    for (const [, gw] of ws.gridWindows) {
      if (gw.ptyId === id) { gw.pty.write(data); return; }
    }
  }
});

ipcMain.on('grid-terminal-resize', (event, { id, cols, rows }) => {
  for (const [, ws] of workspaces) {
    for (const [, gw] of ws.gridWindows) {
      if (gw.ptyId === id) { try { gw.pty.resize(cols, rows); } catch {} return; }
    }
  }
});

// ── IPC for sidebar embedded terminals ──
ipcMain.handle('create-terminal', (event, opts = {}) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { id: -1 };
  const id = nextPtyId++;
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color',
    cols: opts.cols || 80, rows: opts.rows || 24,
    cwd: opts.cwd || process.env.HOME || '/',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  ws.sidebarPtys.set(id, p);
  p.onData(data => { if (ws.win && !ws.win.isDestroyed()) ws.win.webContents.send('terminal-data', { id, data }); });
  p.onExit(() => { ws.sidebarPtys.delete(id); if (ws.win && !ws.win.isDestroyed()) ws.win.webContents.send('terminal-exit', { id }); });
  return { id };
});

ipcMain.on('terminal-input', (event, { id, data }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  const p = ws.sidebarPtys.get(id);
  if (p) p.write(data);
});

ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  const p = ws.sidebarPtys.get(id);
  if (p) try { p.resize(cols, rows); } catch {}
});

ipcMain.handle('kill-terminal', (event, { id }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  const p = ws.sidebarPtys.get(id);
  if (p) { try { p.kill(); } catch {} ws.sidebarPtys.delete(id); }
});

// ── IPC: add grid terminal from sidebar ──
ipcMain.handle('add-grid-terminal', (event) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const slot = nextFreeSlot(ws);
  if (slot < 0) return { ok: false, reason: 'grid-full' };
  createGridTerminal(ws, slot);
  return { ok: true, slot };
});

ipcMain.handle('remove-grid-terminal', (event, { slot }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const gw = ws.gridWindows.get(slot);
  if (gw) {
    if (gw.win && !gw.win.isDestroyed()) gw.win.close();
  }
  compactSlots(ws);
  retileAll(ws);
  return { ok: true };
});

// ── IPC: snap/unsnap external ──
ipcMain.handle('snap-external', async (event, { windowNumber, pid, app: appName, title, x, y, width, height, windowIndex }) => {
  const t0 = Date.now();
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const existing = isExternalSnapped(windowNumber);
  if (existing && existing.id !== ws.id) return { ok: false, reason: 'snapped-elsewhere' };
  const slot = nextFreeSlot(ws);
  if (slot < 0) return { ok: false, reason: 'no-slot' };
  ws.snappedExternals.set(windowNumber, {
    app: appName, pid, title, windowNumber, windowIndex: windowIndex || 0, slot,
    origX: x, origY: y, origW: width, origH: height,
    snappedAt: Date.now(),
  });
  snappedIndexAdd(windowNumber, ws);
  // snapped.json: 非同期で書き出し (AtelierX 競合は許容)
  scheduleSyncSnapped(0);
  const t1 = Date.now();
  const pos = getSlotBounds(ws, slot);
  if (pos) await batchMove([{ windowNumber, pid, app: appName, title, ...pos }]);
  const t2 = Date.now();
  scheduleSaveWorkspaces();
  await raiseAllWorkspaceWindows(ws, true);
  console.log(`[tin] snap: prep=${t1-t0}ms move=${t2-t1}ms total=${Date.now()-t0}ms`);
  return { ok: true, slot };
});

ipcMain.handle('unsnap-external', async (event, { windowNumber }) => {
  const t0 = Date.now();
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const info = ws.snappedExternals.get(windowNumber);
  if (!info) return { ok: false };
  ws.snappedExternals.delete(windowNumber);
  snappedIndexRemove(windowNumber);
  compactSlots(ws);
  // 元の位置に戻す + 残りを retile + 全体を前面化
  await batchMove([{ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
    x: info.origX, y: info.origY, width: info.origW, height: info.origH }]);
  await retileAll(ws);
  await raiseAllWorkspaceWindows(ws, true);
  scheduleSyncSnapped();
  scheduleSaveWorkspaces();
  console.log(`[tin] unsnap: total=${Date.now()-t0}ms`);
  return { ok: true };
});

// ── IPC: 個別 snapped window を前面化 (相互機能: 解釈A)
// workspace sidebar の個別スロットクリックから呼ばれる。
// URL スキーム tin://raise でも同じロジックを叩けるが、そちらは match-key 検索を伴う。
ipcMain.handle('raise-snapped', async (event, { windowNumber }) => {
  for (const [, ws] of workspaces) {
    const info = ws.snappedExternals.get(windowNumber);
    if (!info) continue;
    await raiseSpecificWindows([{
      app: info.app, pid: info.pid, title: info.title,
      windowNumber: info.windowNumber, windowIndex: info.windowIndex,
    }]);
    return { ok: true };
  }
  return { ok: false };
});

// ── IPC: wobble (縦方向に 8px ゆすって戻す) + raise ──
// 「クリックしたカードがどのウィンドウか視覚的に示す」ための軽量アニメ。
// daemon が AX 直叩きで実装しているので osascript より高速かつ name マッチ
// 不要 (windowNumber で一意にヒット、Finder ghost 問題も回避)。
// snapped / available どちらからも呼べる汎用 IPC。
ipcMain.handle('wobble-window', async (_event, { windowNumber, pid, app: appName, title, windowIndex }) => {
  if (!windowNumber && !appName) return { ok: false };
  await daemonRequest('wobble', {
    windows: [{ windowNumber, pid, app: appName, title, windowIndex: windowIndex || 0 }],
  });
  return { ok: true };
});

ipcMain.handle('get-snapped-externals', (event) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return {};
  return Object.fromEntries([...ws.snappedExternals.entries()].map(([k, v]) => [k, v.slot]));
});

// ── IPC: grid config ──
ipcMain.handle('set-grid-size', (event, { cols, rows }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  ws.gridCols = cols;
  ws.gridRows = rows;
  if (ws.gridOverlay && !ws.gridOverlay.isDestroyed()) {
    ws.gridOverlay.webContents.send('update-grid', { cols, rows });
  }
  retileAll(ws);
  scheduleSaveWorkspaces();
});

ipcMain.on('rename-workspace', (event, { name }) => {
  const ws = findWorkspace(event.sender);
  if (ws) {
    ws.name = name;
    scheduleSaveWorkspaces();
  }
});

ipcMain.on('toggle-collapse', (event, { collapsed }) => {
  const ws = findWorkspace(event.sender);
  if (!ws || !ws.win || ws.win.isDestroyed()) return;
  const b = ws.win.getBounds();
  if (collapsed) {
    ws._expandedWidth = b.width;
    ws.win.setMinimumSize(48, 300);
    ws.win.setBounds({ x: b.x, y: b.y, width: 48, height: b.height });
  } else {
    const w = ws._expandedWidth || 320;
    ws.win.setMinimumSize(200, 300);
    ws.win.setBounds({ x: b.x, y: b.y, width: w, height: b.height });
  }
  setTimeout(() => retileAll(ws), 50);
});

// ── Create workspace ──
// savedState: { sidebar:{x,y,w,h}, grid:{cols,rows,width}, snappedExternals:[...] }
// 再起動時の復帰用。渡されれば sidebar 位置 / grid 構成 / snappedExternals が
// 保存済みの値で初期化される。
function createWorkspace(name, savedState) {
  const wsId = nextWsId++;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const ww = 300, wh = 650;
  const offset = (wsId - 1) * 30;

  // sidebar 位置: saved state があればそれを、なければデフォルト
  const savedSidebar = savedState && savedState.sidebar;
  const winX = savedSidebar ? savedSidebar.x : 50 + offset;
  const winY = savedSidebar ? savedSidebar.y : Math.round((sh - wh) / 2) + offset;
  const winW = savedSidebar && savedSidebar.width ? savedSidebar.width : ww;
  const winH = savedSidebar && savedSidebar.height ? savedSidebar.height : wh;

  const win = new BrowserWindow({
    width: winW, height: winH,
    minWidth: 200, maxWidth: 500, minHeight: 300,
    x: winX,
    y: winY,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    transparent: false,
    backgroundColor: '#ffffff',
    alwaysOnTop: false,
    acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });

  const wsName = name || (savedState && savedState.name) || `Workspace ${wsId}`;
  const savedGrid = savedState && savedState.grid;
  const ws = {
    id: wsId, win, name: wsName,
    snappedExternals: new Map(),
    gridWindows: new Map(),    // slot -> { win, pty, ptyId }
    sidebarPtys: new Map(),    // ptyId -> pty (for sidebar embedded terms)
    gridOverlay: null,
    pollTimer: null,
    moveThrottle: null,
    overlayThrottle: null,
    gridCols: savedGrid ? (savedGrid.cols || 2) : 2,
    gridRows: savedGrid ? (savedGrid.rows || 2) : 2,
    gridWidth: savedGrid ? (savedGrid.width || 800) : 800,
    gridHeight: savedGrid ? (savedGrid.height || 0) : 0,
    color: (savedState && savedState.colorIndex != null) ? WS_COLORS[savedState.colorIndex % WS_COLORS.length] : WS_COLORS[(wsId - 1) % WS_COLORS.length],
    colorIndex: (savedState && savedState.colorIndex != null) ? savedState.colorIndex : (wsId - 1) % WS_COLORS.length,
  };
  workspaces.set(wsId, ws);
  registerWorkspaceContents(ws);
  // 復元対象の snapped エントリを deferred に処理する (daemon + sidebar 準備後)
  if (savedState && Array.isArray(savedState.snappedExternals) && savedState.snappedExternals.length > 0) {
    ws._pendingRestore = savedState.snappedExternals;
  }


  // ── Grid overlay (semi-transparent resizable area) ──
  function createGridOverlay() {
    const wb = win.getBounds();
    const overlayX = wb.x + wb.width + 12;
    const overlayY = wb.y;
    const overlayW = ws.gridWidth || 800;
    const overlayH = ws.gridHeight || wb.height;
    const overlay = new BrowserWindow({
      x: overlayX,
      y: overlayY,
      width: overlayW,
      height: overlayH,
      minWidth: 300, minHeight: 200,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: true,
      acceptFirstMouse: true,
      skipTaskbar: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    // Hide from macOS native Window menu listing (must be set via property, not constructor)
    overlay.excludedFromShownWindowsMenu = true;
    overlay.loadFile('grid-overlay.html');
    // Force position after creation (transparent windows can drift)
    overlay.setBounds({ x: overlayX, y: overlayY, width: overlayW, height: overlayH });
    // Click-through by default — only handles are interactive
    overlay.setIgnoreMouseEvents(true, { forward: true });
    ws.gridOverlay = overlay;

    // overlay resize: gridWidth/gridHeight を更新 + retile
    overlay.on('resize', () => {
      if (ws.overlayThrottle) return;
      ws.overlayThrottle = setTimeout(async () => {
        ws.overlayThrottle = null;
        if (!overlay.isDestroyed()) {
          const ob = overlay.getBounds();
          ws.gridWidth = ob.width;
          ws.gridHeight = ob.height;
        }
        await retileAll(ws);
        scheduleSaveWorkspaces();
      }, 16);
    });
    overlay.on('closed', () => { ws.gridOverlay = null; });
  }

  // Create overlay after workspace is shown
  win.once('show', () => setTimeout(createGridOverlay, 100));

  win.loadFile('workspace.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('workspace-info', { id: wsId, name: wsName, color: ws.color });
    // 復元は restoreAllPending() で一括実行 (個別ではなく全 workspace まとめて)
    if (ws._pendingRestore) scheduleRestoreAll();
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // Move grid items + overlay when sidebar moves/resizes
  // **リアルタイム追従**: ドラッグ中も snapped ウィンドウが一緒に動く。
  // throttle (16ms ≈ 60fps) で daemon に move を送る。前の move が完了する前に
  // 次の move を投げないようガードする。
  // sidebar ドラッグ中: overlay 同期 + snapped windows をリアルタイム追従
  // 16ms throttle で daemon にコマンド送信 (60fps 上限)。
  // ドラッグ中は poll を一時停止して daemon 競合を防ぐ。
  let _dragThrottle = null;
  let _dragging = false;
  let _lastSidebarHeight = winH;
  const syncOverlayPosition = () => {
    if (!ws.gridOverlay || ws.gridOverlay.isDestroyed() || !ws.win || ws.win.isDestroyed()) return;
    const sb = ws.win.getBounds();
    const ob = ws.gridOverlay.getBounds();
    // 位置だけ追従。サイズは overlay 独自管理。
    // ただし sidebar の高さが変わり、gridHeight が未設定 (0) なら sidebar に連動。
    let h = ob.height;
    if (!ws.gridHeight) {
      h = sb.height;
    } else if (sb.height !== _lastSidebarHeight && !ws.gridHeight) {
      h = sb.height;
    }
    _lastSidebarHeight = sb.height;
    ws.gridOverlay.setBounds({ x: sb.x + sb.width + 12, y: sb.y, width: ws.gridWidth || ob.width, height: h });
  };
  const onSidebarMove = () => {
    syncOverlayPosition();
    // embedded grid windows を即座に同期
    for (const [slot, gw] of ws.gridWindows) {
      if (gw.win && !gw.win.isDestroyed()) {
        const b = getSlotBounds(ws, slot);
        if (b) gw.win.setBounds(b);
      }
    }
    // snapped externals: 16ms throttle で daemon に fire-and-forget
    if (_dragThrottle) return;
    _dragThrottle = setTimeout(() => { _dragThrottle = null; }, 16);
    const moveCmds = [];
    for (const [, info] of ws.snappedExternals) {
      const b = getSlotBounds(ws, info.slot);
      if (b) moveCmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title, ...b });
    }
    if (moveCmds.length) daemonMoveFireAndForget(moveCmds, true);
  };
  win.on('move', onSidebarMove);
  win.on('resize', onSidebarMove);
  win.on('will-move', () => { if (!_dragging) { _dragging = true; } });
  win.on('moved', () => {
    _dragging = false;
    retileAll(ws);
    scheduleSaveWorkspaces();
  });
  // sidebar resize 終了時にサイズ確定
  let _resizeEnd = null;
  win.on('resize', () => {
    if (_resizeEnd) clearTimeout(_resizeEnd);
    _resizeEnd = setTimeout(() => {
      _resizeEnd = null;
      retileAll(ws);
      scheduleSaveWorkspaces();
    }, 150);
  });

  // Title cache: windowNumber -> title
  // パッケージ版では daemon binary が Screen Recording 権限を持たないため
  // CGWindowList がタイトルを空で返す。osascript fallback は高コスト
  // (~200ms × アプリ数) なので、**既知の windowNumber はキャッシュヒット**させ
  // 新規 windowNumber 出現時だけ再フェッチする。
  ws._titleCache = new Map();
  ws._titleCacheRefreshAt = 0;
  ws._lastPollIdentity = '';  // fast-path: skip IPC when nothing changed
  // Poll external windows
  // pollTimer: 2000ms。Available リスト更新は 2 秒遅延するが
  // snap/unsnap の即時操作には影響しない。snapped の grace period は 8 回 = ~16s。
  ws.pollTimer = setInterval(async () => {
    if (!ws.win || ws.win.isDestroyed()) return;
    if (_dragging) return; // ドラッグ中は poll スキップ (daemon 競合防止)
    const windows = await listWindows();
    // Title fallback for packaged app: キャッシュヒットを先に適用
    if (windows.length > 0) {
      let hasUnknown = false;
      for (const w of windows) {
        if (!w.title) {
          const cached = ws._titleCache.get(w.windowNumber);
          if (cached) { w.title = cached; }
          else { hasUnknown = true; }
        }
      }
      // 未知 windowNumber がある場合のみ osascript で補完 (5秒レート制限)
      if (hasUnknown) {
        const now = Date.now();
        if (now - ws._titleCacheRefreshAt > 5000) {
          ws._titleCacheRefreshAt = now;
          const appSet = new Set();
          for (const w of windows) appSet.add(w.app);
          for (const appName of appSet) {
            (async () => {
              try {
                const [idsRes, namesRes] = await Promise.all([
                  runOsascript(`tell application "${appName}" to get id of every window`, 2000),
                  runOsascript(`tell application "${appName}" to get name of every window`, 2000),
                ]);
                if (idsRes.err || namesRes.err) return;
                const ids = idsRes.stdout.trim().split(', ').map(Number);
                const names = namesRes.stdout.trim().split(', ');
                for (let i = 0; i < ids.length; i++) {
                  if (ids[i]) ws._titleCache.set(ids[i], names[i] || '');
                }
              } catch {}
            })();
          }
        }
      }
      // 古いエントリ削除 (256超過時のみ)
      if (ws._titleCache.size > 256) {
        const liveNums = new Set();
        for (const w of windows) liveNums.add(w.windowNumber);
        for (const k of ws._titleCache.keys()) {
          if (!liveNums.has(k)) ws._titleCache.delete(k);
        }
      }
    }
    // liveMap 構築: windowNumber → window (Set ではなく Map で O(1) lookup)
    const liveMap = new Map();
    for (const w of windows) liveMap.set(w.windowNumber, w);

    // snapped externals の生死チェック (missing があるときだけ verify IPC)
    const missingList = [];
    for (const [k, info] of ws.snappedExternals) {
      if (!liveMap.has(k)) missingList.push({ key: k, info });
    }
    let axAlive;
    if (missingList.length > 0) {
      const verifyCmds = missingList.map(({ key, info }) => ({
        windowNumber: key, pid: info.pid, app: info.app, title: info.title,
      }));
      const vr = await verifyWindows(verifyCmds);
      axAlive = (vr && Array.isArray(vr.alive)) ? new Set(vr.alive) : new Set();
    }
    let snappedChanged = false;
    for (const [k, info] of ws.snappedExternals) {
      const live = liveMap.get(k);
      if (!live) {
        if ((axAlive && axAlive.has(k)) || isStabilizing()) {
          info._missCount = 0;
          continue;
        }
        info._missCount = (info._missCount || 0) + 1;
        if (info._missCount >= 8) {
          ws.snappedExternals.delete(k);
          snappedIndexRemove(k);
          snappedChanged = true;
        }
        continue;
      }
      info._missCount = 0;
      if (info.title !== live.title || info.pid !== live.pid) {
        info.title = live.title;
        info.pid = live.pid;
      }
    }

    // Fast-path: build identity string and skip IPC if nothing changed
    // 軽量な identity: windowNumber:title の連結 + snapped keys + grid keys
    let identity = '';
    for (const w of windows) { identity += w.windowNumber; identity += ':'; identity += w.title; identity += ','; }
    identity += '|';
    for (const k of ws.snappedExternals.keys()) { identity += k; identity += ','; }
    identity += '|';
    for (const k of ws.gridWindows.keys()) { identity += k; identity += ','; }
    if (identity === ws._lastPollIdentity && !snappedChanged) return;
    ws._lastPollIdentity = identity;

    // snappedByOther: 複数 workspace がある場合のみ構築
    const snappedByOther = {};
    if (workspaces.size > 1) {
      for (const [, otherWs] of workspaces) {
        if (otherWs.id === ws.id) continue;
        for (const [wn] of otherWs.snappedExternals) snappedByOther[wn] = { name: otherWs.name, color: otherWs.color };
      }
    }
    const gridSlots = {};
    for (const [slot, gw] of ws.gridWindows) gridSlots[slot] = { ptyId: gw.ptyId };
    ws.win.webContents.send('external-windows', windows, snappedByOther, gridSlots);
  }, 2000);

  win.on('closed', async () => {
    if (ws.pollTimer) clearInterval(ws.pollTimer);
    if (ws.moveThrottle) clearTimeout(ws.moveThrottle);
    if (ws.overlayThrottle) clearTimeout(ws.overlayThrottle);
    // Close grid overlay
    if (ws.gridOverlay && !ws.gridOverlay.isDestroyed()) ws.gridOverlay.close();
    ws.gridOverlay = null;
    // Close grid windows
    for (const [, gw] of ws.gridWindows) {
      try { gw.pty.kill(); } catch {}
      if (gw.win && !gw.win.isDestroyed()) gw.win.close();
    }
    ws.gridWindows.clear();
    // **重要**: アプリ全体の quit 時は外部ウィンドウを元位置に戻さない。
    // workspaces.json に保存されているので次回起動で復元される。
    // ユーザーが個別にワークスペースを閉じた場合 (Cmd+Shift+W etc.) のみ
    // 元位置に戻す (ユーザー意図として release 扱い)。
    if (!app.isQuitting) {
      const cmds = [];
      for (const [, info] of ws.snappedExternals) {
        cmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
          x: info.origX, y: info.origY, width: info.origW, height: info.origH });
      }
      if (cmds.length) await osascriptMove(cmds);
    }
    for (const k of ws.snappedExternals.keys()) snappedIndexRemove(k);
    ws.snappedExternals.clear();
    // Kill sidebar PTYs
    for (const [, p] of ws.sidebarPtys) { try { p.kill(); } catch {} }
    ws.sidebarPtys.clear();
    ws.win = null;
    workspaces.delete(wsId);
    scheduleSaveWorkspaces();
  });

  return ws;
}

// ── RAISE: workspace フォーカスで全 snapped ウィンドウを前面化 ──
// workspace をクリックすると snapped ターミナルが全部まとまって前面に来る。
app.on('browser-window-focus', (_event, focusedWin) => {
  let ws = null;
  for (const [, w] of workspaces) {
    if (w.win === focusedWin || w.gridOverlay === focusedWin) { ws = w; break; }
    for (const [, gw] of w.gridWindows) {
      if (gw.win === focusedWin) { ws = w; break; }
    }
    if (ws) break;
  }
  if (ws) {
    raiseAllWorkspaceWindows(ws);
    scheduleSyncSnapped(200);
  }
});

ipcMain.on('raise-all', (event) => {
  const ws = findWorkspace(event.sender);
  if (ws) raiseAllWorkspaceWindows(ws, true);
});

ipcMain.on('raise-all-from-overlay', (event) => {
  for (const [, ws] of workspaces) {
    if (ws.gridOverlay && !ws.gridOverlay.isDestroyed() && ws.gridOverlay.webContents === event.sender) {
      raiseAllWorkspaceWindows(ws, true);
      return;
    }
  }
});

ipcMain.on('set-overlay-clickthrough', (event, clickthrough) => {
  for (const [, ws] of workspaces) {
    if (ws.gridOverlay && !ws.gridOverlay.isDestroyed() && ws.gridOverlay.webContents === event.sender) {
      if (clickthrough) {
        ws.gridOverlay.setIgnoreMouseEvents(true, { forward: true });
      } else {
        ws.gridOverlay.setIgnoreMouseEvents(false);
      }
      return;
    }
  }
});

ipcMain.handle('get-overlay-bounds', (event) => {
  for (const [, ws] of workspaces) {
    if (ws.gridOverlay && !ws.gridOverlay.isDestroyed() && ws.gridOverlay.webContents === event.sender) {
      return getGridArea(ws); // use calculated bounds, not overlay.getBounds()
    }
  }
  return null;
});

ipcMain.on('resize-overlay', (event, { width, height }) => {
  for (const [, ws] of workspaces) {
    if (ws.gridOverlay && !ws.gridOverlay.isDestroyed() && ws.gridOverlay.webContents === event.sender) {
      // Use workspace position to calculate overlay position (not overlay.getBounds)
      const sb = ws.win.getBounds();
      ws.gridOverlay.setBounds({ x: sb.x + sb.width + 12, y: sb.y, width, height });
      ws.gridWidth = width;
      ws.gridHeight = height;
      // overlay リサイズ後に snapped ターミナルのサイズも即座に反映
      retileAll(ws);
      scheduleSaveWorkspaces();
      return;
    }
  }
});

// ── URL scheme handler (docs/PROTOCOL.md §5) ──
// tin://<action>?<params> を受け取って内部アクションにルーティングする。
// fire-and-forget: 応答は返さない (状態変化があれば snapped.json が更新される)

function handleTinUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return; }
  if (u.protocol !== 'tin:') return;

  // Normalize: "tin://snap" → host="snap"、"tin://workspace/focus" → host="workspace", pathname="/focus"
  const action = u.hostname + (u.pathname && u.pathname !== '/' ? u.pathname : '');
  const params = Object.fromEntries(u.searchParams);

  // 全 workspace の中からマッチする snapped window を探すヘルパー
  function findInfoByKey({ app: appName, windowNumber, title, pid }) {
    const wn = windowNumber ? Number(windowNumber) : null;
    const p = pid ? Number(pid) : null;
    for (const [, ws] of workspaces) {
      // 第1候補: windowNumber 完全一致
      if (wn) {
        for (const [k, info] of ws.snappedExternals) {
          if (k === wn && (!appName || info.app === appName)) return { ws, info };
        }
      }
      // 第2候補: pid + app
      if (p) {
        for (const [, info] of ws.snappedExternals) {
          if (info.pid === p && (!appName || info.app === appName)) return { ws, info };
        }
      }
      // 第3候補: app + title 完全一致
      if (appName && title) {
        for (const [, info] of ws.snappedExternals) {
          if (info.app === appName && info.title === title) return { ws, info };
        }
      }
      // 第4候補: app + title 前方一致
      if (appName && title) {
        const prefix = title.slice(0, Math.min(40, title.length));
        for (const [, info] of ws.snappedExternals) {
          if (info.app === appName && info.title && info.title.startsWith(prefix)) return { ws, info };
        }
      }
    }
    return null;
  }

  (async () => {
    try {
      switch (action) {
        case 'raise': {
          // tin://raise?app=X&windowNumber=Y&title=Z&pid=W
          const match = findInfoByKey(params);
          if (match) {
            await raiseSpecificWindows([{
              app: match.info.app, pid: match.info.pid, title: match.info.title,
              windowNumber: match.info.windowNumber, windowIndex: match.info.windowIndex,
            }]);
          } else if (params.app && params.windowNumber) {
            // snapped でないウィンドウも raise 可能にする (汎用 raise)
            await raiseSpecificWindows([{
              app: params.app, pid: params.pid ? Number(params.pid) : undefined,
              title: params.title, windowNumber: Number(params.windowNumber),
            }]);
          }
          break;
        }
        case 'workspace/focus': {
          // アクティブ workspace を前面化。なければ最初の workspace。
          const focused = BrowserWindow.getFocusedWindow();
          let target = null;
          for (const [, ws] of workspaces) {
            if (!ws.win || ws.win.isDestroyed()) continue;
            if (focused && (ws.win === focused || ws.gridOverlay === focused)) { target = ws; break; }
          }
          if (!target) {
            for (const [, ws] of workspaces) {
              if (ws.win && !ws.win.isDestroyed()) { target = ws; break; }
            }
          }
          if (target) await raiseAllWorkspaceWindows(target, true);
          break;
        }
        case 'workspace/switch': {
          // tin://workspace/switch?id=X
          const id = Number(params.id);
          for (const [, ws] of workspaces) {
            if (ws.id === id) { await raiseAllWorkspaceWindows(ws, true); break; }
          }
          break;
        }
        case 'terminal/new': {
          // tin://terminal/new?cwd=X — 現在アクティブ workspace で新規 grid terminal 作成
          // 実装は sidebar 経由でワンステップ送るのが安全
          let target = null;
          const focused = BrowserWindow.getFocusedWindow();
          for (const [, ws] of workspaces) {
            if (!ws.win || ws.win.isDestroyed()) continue;
            if (focused && (ws.win === focused || ws.gridOverlay === focused)) { target = ws; break; }
          }
          if (!target) {
            for (const [, ws] of workspaces) {
              if (ws.win && !ws.win.isDestroyed()) { target = ws; break; }
            }
          }
          if (target && target.win && !target.win.isDestroyed()) {
            target.win.webContents.send('new-terminal', { cwd: params.cwd || '' });
          }
          break;
        }
        case 'snap': {
          // tin://snap?app=X&windowNumber=Y&slot=N
          // 現在のアクティブ workspace に対して snap 操作を送る
          // (注: 外部から snap するには windowNumber 等の情報が必要)
          // 簡易実装: sidebar に "external-snap-request" を送って UI 側で処理
          let target = null;
          const focused = BrowserWindow.getFocusedWindow();
          for (const [, ws] of workspaces) {
            if (!ws.win || ws.win.isDestroyed()) continue;
            if (focused && (ws.win === focused || ws.gridOverlay === focused)) { target = ws; break; }
          }
          if (!target) {
            for (const [, ws] of workspaces) {
              if (ws.win && !ws.win.isDestroyed()) { target = ws; break; }
            }
          }
          if (target && target.win && !target.win.isDestroyed()) {
            target.win.webContents.send('external-snap-request', params);
          }
          break;
        }
        case 'release':
        case 'unsnap': {
          const match = findInfoByKey(params);
          if (match) {
            match.ws.snappedExternals.delete(match.info.windowNumber);
            snappedIndexRemove(match.info.windowNumber);
            compactSlots(match.ws);
            try {
              await batchMove([{
                windowNumber: match.info.windowNumber,
                pid: match.info.pid,
                app: match.info.app,
                title: match.info.title,
                x: match.info.origX, y: match.info.origY,
                width: match.info.origW, height: match.info.origH,
              }]);
            } catch {}
            await retileAll(match.ws);
            scheduleSyncSnapped();
          }
          break;
        }
        case 'info':
          // info は info.json で公開中。URL では no-op (ただし呼ばれたら info.json を更新)
          writeInfoJson();
          break;
        default:
          // 未知のアクションは無視
          break;
      }
    } catch (e) {
      console.warn('[tin://] handler error:', e.message);
    }
  })();
}

// URL scheme を自身に関連付ける (Info.plist の CFBundleURLTypes と連携)
try { app.setAsDefaultProtocolClient('tin'); } catch {}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleTinUrl(url);
});

// 二重起動時に URL が process.argv で渡るケース (windows/linux想定、macでも保険)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    for (const arg of argv) {
      if (typeof arg === 'string' && arg.startsWith('tin:')) handleTinUrl(arg);
    }
  });
}

// ── Workspace Presets (メモリ機能) ──
function savePreset(name) {
  try {
    if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });
    const data = { name, savedAt: Date.now(), version: WORKSPACES_FORMAT_VERSION, workspaces: [] };
    for (const [, ws] of workspaces) {
      if (!ws || !ws.win || ws.win.isDestroyed()) continue;
      const b = ws.win.getBounds();
      const snapped = [];
      for (const [, info] of ws.snappedExternals) {
        snapped.push({
          windowNumber: info.windowNumber, app: info.app, pid: info.pid,
          title: info.title, windowIndex: info.windowIndex || 0, slot: info.slot,
          origX: info.origX, origY: info.origY, origW: info.origW, origH: info.origH,
        });
      }
      data.workspaces.push({
        name: ws.name, colorIndex: ws.colorIndex,
        sidebar: { x: b.x, y: b.y, width: b.width, height: b.height },
        grid: { cols: ws.gridCols, rows: ws.gridRows, width: ws.gridWidth || 800, height: ws.gridHeight || 0 },
        snappedExternals: snapped,
      });
    }
    const filename = name.replace(/[^a-zA-Z0-9\u3000-\u9fff_-]/g, '_') + '.json';
    fs.writeFileSync(path.join(PRESETS_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[tin] preset saved: ${name} (${data.workspaces.length} workspaces)`);
    return { ok: true, name };
  } catch (e) {
    return { error: e.message };
  }
}

function listPresets() {
  try {
    if (!fs.existsSync(PRESETS_DIR)) return [];
    return fs.readdirSync(PRESETS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf-8'));
          return { filename: f, name: d.name, savedAt: d.savedAt, wsCount: (d.workspaces || []).length };
        } catch { return null; }
      }).filter(Boolean)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

async function loadPreset(filename) {
  try {
    const raw = fs.readFileSync(path.join(PRESETS_DIR, filename), 'utf-8');
    const data = JSON.parse(raw);
    if (!data.workspaces || !data.workspaces.length) return { error: '空のプリセット' };
    // 既存 workspace を閉じる
    for (const [, ws] of workspaces) {
      if (ws.win && !ws.win.isDestroyed()) ws.win.close();
    }
    // 少し待ってから復元
    await new Promise(r => setTimeout(r, 300));
    for (const wsData of data.workspaces) {
      createWorkspace(wsData.name, wsData);
    }
    console.log(`[tin] preset loaded: ${data.name} (${data.workspaces.length} workspaces)`);
    return { ok: true, name: data.name, count: data.workspaces.length };
  } catch (e) {
    return { error: e.message };
  }
}

// テキスト入力ダイアログ (IME 対応)
function promptTextInput(title, label, defaultValue = '') {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 400, height: 160, resizable: false,
      titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 },
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const html = `<!DOCTYPE html><html><head><style>
      body{font-family:-apple-system,sans-serif;padding:38px 20px 16px;background:#fff}
      label{font-size:13px;font-weight:600;color:#333;display:block;margin-bottom:8px}
      input{width:100%;padding:7px 10px;font-size:13px;border:1px solid #ccc;border-radius:6px;outline:none}
      input:focus{border-color:#4a90d9}
      .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
      button{padding:5px 16px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid #ccc;background:#f5f5f5}
      button.ok{background:#2563eb;color:#fff;border-color:#2563eb}
    </style></head><body>
      <label>${label}</label>
      <input id="v" value="${defaultValue.replace(/"/g, '&quot;')}" />
      <div class="btns">
        <button onclick="require('electron').ipcRenderer.send('_prompt_result','')">キャンセル</button>
        <button class="ok" onclick="require('electron').ipcRenderer.send('_prompt_result',document.getElementById('v').value.trim())">OK</button>
      </div>
      <script>
        const inp=document.getElementById('v');inp.focus();inp.select();
        inp.addEventListener('keydown',e=>{if(e.isComposing||e.keyCode===229)return;if(e.key==='Enter')require('electron').ipcRenderer.send('_prompt_result',inp.value.trim());if(e.key==='Escape')require('electron').ipcRenderer.send('_prompt_result','')});
      </script>
    </body></html>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.setTitle(title);
    const handler = (_e, val) => { ipcMain.removeListener('_prompt_result', handler); w.close(); resolve(val || null); };
    ipcMain.on('_prompt_result', handler);
    w.on('closed', () => { ipcMain.removeListener('_prompt_result', handler); resolve(null); });
  });
}

ipcMain.handle('save-preset', async (_event, { name }) => savePreset(name));
ipcMain.handle('list-presets', async () => listPresets());
ipcMain.handle('load-preset', async (_event, { filename }) => loadPreset(filename));

// ── Auto Snap (AI クラスタリング) ──
// バッジクリックで対象 workspace 全体を前面化
ipcMain.on('switch-to-workspace-of', (_event, { windowNumber }) => {
  for (const [, ws] of workspaces) {
    if (ws.snappedExternals.has(windowNumber)) {
      raiseAllWorkspaceWindows(ws, true);
      return;
    }
  }
});

ipcMain.on('trigger-auto-snap', (_event, opts) => triggerAutoSnap(opts));
async function triggerAutoSnap(opts = {}) {
  const filter = (opts && opts.filter) || 'all';
  const FINDER_APPS = new Set(['Finder', 'ファインダー']);
  // 全 workspace から snapped 済みの windowNumber を収集
  const snappedSet = new Set();
  for (const [, ws] of workspaces) {
    for (const k of ws.snappedExternals.keys()) snappedSet.add(k);
  }
  // available (未 snap) ウィンドウを取得 + フィルター適用
  const allWindows = await listWindows();
  let available = allWindows.filter(w => !snappedSet.has(w.windowNumber));
  if (filter === 'terminal') available = available.filter(w => !FINDER_APPS.has(w.app));
  if (filter === 'finder') available = available.filter(w => FINDER_APPS.has(w.app));
  if (available.length === 0) {
    dialog.showMessageBox({ type: 'info', title: 'Auto Snap', message: 'スナップ可能なウィンドウがありません。' });
    return;
  }
  // 進行中通知を全 workspace に送信
  for (const [, ws] of workspaces) {
    if (ws.win && !ws.win.isDestroyed()) ws.win.webContents.send('auto-snap-status', { status: 'working', count: available.length });
  }
  const result = await autoSnap.executeAutoSnap(
    available,
    (name) => createWorkspace(name),
    async (ws, w) => {
      const slot = nextFreeSlot(ws);
      if (slot < 0) return;
      ws.snappedExternals.set(w.windowNumber, {
        app: w.app, pid: w.pid, title: w.title, windowNumber: w.windowNumber,
        windowIndex: w.windowIndex || 0, slot,
        origX: w.x, origY: w.y, origW: w.width, origH: w.height,
        snappedAt: Date.now(),
      });
      snappedIndexAdd(w.windowNumber, ws);
      const pos = getSlotBounds(ws, slot);
      if (pos) await batchMove([{ windowNumber: w.windowNumber, pid: w.pid, app: w.app, title: w.title, ...pos }]);
    }
  );
  // 結果通知
  for (const [, ws] of workspaces) {
    if (ws.win && !ws.win.isDestroyed()) {
      ws.win.webContents.send('auto-snap-status', {
        status: result.error ? 'error' : 'done',
        error: result.error,
        created: result.created,
      });
    }
  }
  if (result.error) {
    dialog.showMessageBox({ type: 'error', title: 'Auto Snap', message: result.error });
  } else {
    scheduleSyncSnapped();
    scheduleSaveWorkspaces();
    console.log(`[tin] auto-snap: created ${result.created.length} groups`);
  }
}

// ── App ──
app.isQuitting = false;

app.whenReady().then(() => {
  startDaemon();
  writeInfoJson();
  writeSnappedJson();

  // ── System event listeners: pause release logic on events that cause
  // windows to temporarily disappear from CGWindowList ──
  powerMonitor.on('suspend', () => beginStabilize('power:suspend'));
  powerMonitor.on('resume', () => beginStabilize('power:resume'));
  powerMonitor.on('lock-screen', () => beginStabilize('power:lock-screen'));
  powerMonitor.on('unlock-screen', () => beginStabilize('power:unlock-screen'));
  screen.on('display-added', () => beginStabilize('display-added'));
  screen.on('display-removed', () => beginStabilize('display-removed'));
  screen.on('display-metrics-changed', () => beginStabilize('display-metrics-changed'));

  const template = [
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'New Workspace', accelerator: 'CmdOrCtrl+N', click: () => createWorkspace() },
      { type: 'separator' },
      { label: 'Close Workspace', accelerator: 'CmdOrCtrl+Shift+W', click: () => {
        const win = BrowserWindow.getFocusedWindow();
        if (win) win.close();
      }},
    ]},
    { label: 'Shell', submenu: [
      { label: 'New Grid Terminal', accelerator: 'CmdOrCtrl+T', click: () => {
        const win = BrowserWindow.getFocusedWindow();
        if (win) win.webContents.send('new-terminal');
      }},
      { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => {
        const win = BrowserWindow.getFocusedWindow();
        if (win) win.webContents.send('close-current');
      }},
      { type: 'separator' },
      { label: 'Retile Windows', accelerator: 'CmdOrCtrl+R', click: async () => {
        // Force reposition all snapped externals to their assigned slots.
        // Use the workspace owning the focused window, or all workspaces.
        const focused = BrowserWindow.getFocusedWindow();
        let targets = [];
        if (focused) {
          for (const [, ws] of workspaces) {
            if (!ws.win || ws.win.isDestroyed()) continue;
            if (ws.win === focused || ws.gridOverlay === focused) { targets = [ws]; break; }
            for (const [, gw] of ws.gridWindows) {
              if (gw.win === focused) { targets = [ws]; break; }
            }
            if (targets.length) break;
          }
        }
        if (!targets.length) targets = [...workspaces.values()].filter(ws => ws.win && !ws.win.isDestroyed());
        for (const ws of targets) {
          ensureOnScreen(ws);
          // 強制 retile: osascript 経由で Terminal.app のサイズ制約を突破
          const moveCmds = [];
          for (const [slot, gw] of ws.gridWindows) {
            if (gw.win && !gw.win.isDestroyed()) {
              const b = getSlotBounds(ws, slot);
              if (b) gw.win.setBounds(b);
            }
          }
          for (const [, info] of ws.snappedExternals) {
            const b = getSlotBounds(ws, info.slot);
            if (b) moveCmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title, ...b });
          }
          if (moveCmds.length) await osascriptMove(moveCmds);
        }
      }},
      { type: 'separator' },
      { label: 'Auto Snap (AI) — All', accelerator: 'CmdOrCtrl+Shift+G', click: () => triggerAutoSnap({ filter: 'all' }) },
      { label: 'Edit Auto-Snap Config...', click: () => {
        autoSnap.ensureConfig();
        require('child_process').exec(`open "${autoSnap.CONFIG_FILE}"`);
      }},
      { type: 'separator' },
      { label: 'Save Workspace Preset...', accelerator: 'CmdOrCtrl+Shift+S', click: () => {
        promptTextInput('Save Preset', 'プリセット名', `Preset ${new Date().toLocaleDateString('ja')}`).then(name => {
          if (!name) return;
          const r = savePreset(name);
          if (r.ok) dialog.showMessageBox({ type: 'info', title: 'Saved', message: `"${name}" を保存しました` });
        });
      }},
      { label: 'Load Workspace Preset...', click: async () => {
        const presets = listPresets();
        if (presets.length === 0) {
          dialog.showMessageBox({ type: 'info', title: 'Presets', message: '保存済みプリセットがありません' });
          return;
        }
        const { response } = await dialog.showMessageBox({
          type: 'question', title: 'Load Preset',
          message: 'どのプリセットを復元しますか？',
          detail: presets.map((p, i) => `${i + 1}. ${p.name} (${p.wsCount} ws)`).join('\n'),
          buttons: [...presets.map((p, i) => `${i + 1}. ${p.name}`), 'キャンセル'],
        });
        if (response < presets.length) {
          await loadPreset(presets[response].filename);
        }
      }},
    ]},
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Toggle Sidebar Compact', accelerator: 'CmdOrCtrl+B', click: () => {
        const win = BrowserWindow.getFocusedWindow();
        if (win) win.webContents.send('toggle-compact');
      }},
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { role: 'togglefullscreen' },
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { label: 'Cycle Workspace', accelerator: 'CmdOrCtrl+`', click: () => {
        // Cycle through workspace windows only (skip overlay/grid)
        const wsList = [...workspaces.values()].filter(ws => ws.win && !ws.win.isDestroyed());
        if (wsList.length <= 1) return;
        const focused = BrowserWindow.getFocusedWindow();
        // Find which workspace currently has focus (sidebar, overlay, or grid)
        let currentIdx = -1;
        for (let i = 0; i < wsList.length; i++) {
          const ws = wsList[i];
          if (ws.win === focused || ws.gridOverlay === focused) { currentIdx = i; break; }
          for (const [, gw] of ws.gridWindows) {
            if (gw.win === focused) { currentIdx = i; break; }
          }
          if (currentIdx >= 0) break;
        }
        const nextWs = wsList[(currentIdx + 1) % wsList.length];
        raiseAllWorkspaceWindows(nextWs, true);
      }},
      { type: 'separator' },
      { label: 'Move to Next Display', accelerator: 'CmdOrCtrl+Shift+Right', click: () => moveWorkspaceToDisplay(1) },
      { label: 'Move to Prev Display', accelerator: 'CmdOrCtrl+Shift+Left', click: () => moveWorkspaceToDisplay(-1) },
      { type: 'separator' },
      { role: 'front' },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // 永続化された workspace 状態があれば復元、なければデフォルトを作成
  const persisted = loadPersistedWorkspaces();
  if (persisted && persisted.workspaces.length > 0) {
    console.log(`[tin] restoring ${persisted.workspaces.length} workspace(s) from workspaces.json`);
    for (const wsData of persisted.workspaces) {
      createWorkspace(wsData.name, wsData);
    }
  } else {
    createWorkspace();
  }
});

// 同期版: before-quit 用 (async 使えない)
function writeWorkspacesJsonSync() {
  const payload = { version: WORKSPACES_FORMAT_VERSION, savedAt: Date.now(), workspaces: [] };
  for (const [, ws] of workspaces) {
    if (!ws || !ws.win || ws.win.isDestroyed()) continue;
    const b = ws.win.getBounds();
    const snapped = [];
    for (const [, info] of ws.snappedExternals) {
      snapped.push({
        windowNumber: info.windowNumber, app: info.app, pid: info.pid,
        title: info.title, windowIndex: info.windowIndex || 0, slot: info.slot,
        origX: info.origX, origY: info.origY, origW: info.origW, origH: info.origH,
        snappedAt: info.snappedAt || 0,
      });
    }
    payload.workspaces.push({
      name: ws.name,
      sidebar: { x: b.x, y: b.y, width: b.width, height: b.height },
      grid: { cols: ws.gridCols, rows: ws.gridRows, width: ws.gridWidth || 800, height: ws.gridHeight || 0 },
      colorIndex: ws.colorIndex,
      snappedExternals: snapped,
    });
  }
  atomicWriteJSONSync(WORKSPACES_JSON, payload);
}

app.on('before-quit', () => {
  app.isQuitting = true;
  // quit 前に workspace 状態を確実に書き出す (debounce timer を待たない)
  try { writeWorkspacesJsonSync(); } catch (e) { console.warn('[tin] final save failed:', e.message); }
  if (daemon) { try { daemon.kill(); } catch {} daemon = null; }
  // 統合ステートファイルのクリーンアップ (クライアントが "TiN 未起動" と判定できるように)
  // workspaces.json は残す (次回起動で復元するため)
  try { if (fs.existsSync(INFO_JSON)) fs.unlinkSync(INFO_JSON); } catch {}
  try { if (fs.existsSync(SNAPPED_JSON)) fs.unlinkSync(SNAPPED_JSON); } catch {}
});

app.on('window-all-closed', () => app.quit());
