const { app, BrowserWindow, ipcMain, screen, Menu, powerMonitor, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const pty = require('node-pty');
const { spawn, exec, execFile, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const autoSnap = require('./auto-snap');

// N-API native addon: AXUIElement 操作を Electron main process 内で直接実行。
// TiN.app の TCC 権限をそのまま使用。
let axHelper = null;
try {
  axHelper = require('./build/Release/ax_helper.node');
  console.log('[tin] ax_helper loaded — native AX mode');
} catch (e) {
  console.warn('[tin] ax_helper not available, falling back to osascript:', e.message);
}

// ── yabai 統合: Space 移動 ──
// yabai の window id = CGWindowID のため直接使用可能。
// SIP 部分無効 + `sudo yabai --load-sa` が必要。
let _yabaiPath = null;
function getYabaiPath() {
  if (_yabaiPath !== null) return _yabaiPath;
  try {
    _yabaiPath = execSync('which yabai', { timeout: 2000 }).toString().trim();
  } catch { _yabaiPath = ''; }
  return _yabaiPath;
}

async function yabaiIsRunning() {
  const p = getYabaiPath();
  if (!p) return false;
  try {
    await execAsync(`${p} -m query --windows`, { timeout: 2000 });
    return true;
  } catch { return false; }
}

// yabai scripting addition (SA) の有効状態を確認
// SA なしだと window --space 操作が偽成功するため、実際に移動するか検証する
let _yabaiSACache = null; // { active: bool, checkedAt: number }
async function checkYabaiSA() {
  const now = Date.now();
  if (_yabaiSACache && now - _yabaiSACache.checkedAt < 30000) return _yabaiSACache.active;

  const p = getYabaiPath();
  if (!p) { _yabaiSACache = { active: false, checkedAt: now }; return false; }
  try {
    // SA 確認: query --spaces は SA なしだと失敗する
    const { stdout } = await execAsync(`${p} -m query --spaces`, { timeout: 2000 });
    const spaces = JSON.parse(stdout);
    const active = Array.isArray(spaces) && spaces.length > 0;
    _yabaiSACache = { active, checkedAt: now };
    console.log(`[tin] yabai SA check: ${active ? 'ACTIVE' : 'INACTIVE'}`);
    return active;
  } catch {
    _yabaiSACache = { active: false, checkedAt: now };
    return false;
  }
}

ipcMain.handle('get-yabai-sa-status', async () => {
  const p = getYabaiPath();
  const running = p ? await yabaiIsRunning() : false;
  const saActive = running ? await checkYabaiSA() : false;
  return { yabaiPath: p || null, running, saActive };
});

ipcMain.handle('show-message', (_event, { message }) => {
  dialog.showMessageBox({ type: 'info', message, buttons: ['OK'] });
});

// yabai で windowNumbers を next/prev Space に移動。
// 成功した wn のリストを返す。
// yabai で Space 移動を試みる。
// yabai は SA 未ロード時に exit 0 を返しても実際には移動しない場合があるため、
// getSpaceForWindows で移動を検証し、失敗した wn を返り値から除外する。
async function moveWindowsViaYabai(windowNumbers, direction, targetSpaceId) {
  const p = getYabaiPath();
  if (!p || !windowNumbers.length) return [];

  // まず絶対 Space インデックスを取得（ラップアラウンドと検証に使用）
  let targetYabaiIndex = null;
  try {
    const { stdout } = await execAsync(`${p} -m query --spaces`, { timeout: 2000 });
    const spaces = JSON.parse(stdout);
    const currentIdx = spaces.findIndex(s => s['has-focus'] || s.focused || s['is-visible']);
    if (currentIdx >= 0) {
      const targetIdx = ((currentIdx + direction) + spaces.length) % spaces.length;
      targetYabaiIndex = spaces[targetIdx].index;
    }
  } catch {}

  const spaceArg = targetYabaiIndex != null
    ? String(targetYabaiIndex)                       // 絶対インデックス（ラップアラウンド対応）
    : (direction > 0 ? 'next' : 'prev');

  const attempted = [];
  await Promise.all(windowNumbers.map(async wn => {
    try {
      await execAsync(`${p} -m window ${wn} --space ${spaceArg}`, { timeout: 3000 });
      attempted.push(wn);
    } catch (e) {
      console.log(`[tin] yabai wn=${wn} --space ${spaceArg} failed: ${e.stderr?.trim() || e.message}`);
    }
  }));

  if (attempted.length === 0) return [];

  // SA 未ロード時の偽陽性を排除: getSpaceForWindows で実際の移動を検証
  if (axHelper && axHelper.getSpaceForWindows && targetSpaceId) {
    const actualSpaces = axHelper.getSpaceForWindows(attempted);
    const verified = actualSpaces
      .filter(s => Number(s.spaceId) === Number(targetSpaceId))
      .map(s => s.wn);
    const fake = attempted.filter(wn => !verified.includes(wn));
    if (fake.length > 0)
      console.log(`[tin] yabai偽陽性検出: wn=[${fake}] は実際には移動していない → CGS fallback`);
    return verified;
  }
  return attempted;
}

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

// Always enable remote debugging for MCP integration.
// 9222 が他 Electron アプリ (AtelierX 開発モード等) に占有されていたら 9223/9224 を試す。
function pickDevToolsPort() {
  const { execSync } = require('child_process');
  for (const p of [9222, 9223, 9224]) {
    try { execSync(`lsof -ti:${p}`, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return p; }
  }
  return 9222;
}
app.commandLine.appendSwitch('remote-debugging-port', String(pickDevToolsPort()));
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
// Groupy コンテナモード定数
const TITLEBAR_H = 68;        // TiN ヘッダー高さ (hiddenInset 2行)
const NATIVE_TITLEBAR_H = 28; // macOS ネイティブタイトルバー高さ (参考値)
// 外部アプリは TiN ヘッダーの直下に配置 — タイトルバーを完全に表示する
const GROUPY_Y_OFFSET = TITLEBAR_H; // 68px: 外部アプリは TiN ヘッダーの下から
// 旧レイアウト定数 (後方互換)
const DEFAULT_SIDEBAR_W = 280;
const SIDEBAR_DIVIDER_W = 6;
// workspace プリセット (メモリ機能)
const PRESETS_DIR = path.join(INTEGRATION_DIR, 'presets');
const TIN_START_TIME = Date.now();
// アプリ設定
const SETTINGS_JSON = path.join(INTEGRATION_DIR, 'settings.json');
const DEFAULT_HOTKEYS = {
  snapFrontmost:   'Command+Option+S',
  unsnapFrontmost: 'Command+Option+W',
  focusTiN:        'Command+Option+T',
  slot1: '', slot2: '', slot3: '', slot4: '',
};
const DEFAULT_SETTINGS = {
  pollIntervalMs: 3000,
  dragEndMode: 'position',  // 'position' | 'full' | 'off'
  defaultGridCols: 2,
  defaultGridRows: 2,
  autoLaunch: false,
  stickyWindows: false,     // 全 Space 追従: GPU コンポジターに常時負荷をかけるため OFF 推奨
  hotkeys: { ...DEFAULT_HOTKEYS },
};
let appSettings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_JSON)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));
      appSettings = { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch {}
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_JSON, JSON.stringify(appSettings, null, 2)); } catch {}
}
loadSettings();

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
    if (focused && ws.win === focused) {
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
      sidebarWidth: ws.sidebarWidth || DEFAULT_SIDEBAR_W,
      grid: { cols: ws.gridCols, rows: ws.gridRows, colRatios: ws.colRatios, rowRatios: ws.rowRatios, slotLayout: ws.slotLayout },
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
  // 別 Space にいるウィンドウも復元対象にする (push-to-space 後の再起動で消えるバグ対策)
  let liveAllSpaces = liveWindows;
  if (axHelper && axHelper.listWindowsAllSpaces) {
    try {
      const allSpaces = axHelper.listWindowsAllSpaces();
      if (allSpaces.length > liveWindows.length) liveAllSpaces = allSpaces;
    } catch {}
  }

  const restored = [];
  const missing = [];
  const moveCmds = [];

  for (const p of persistedList) {
    // まず現 Space で探し、なければ全 Space で探す (_spaceAbsent として復元)
    const live = matchPersistedToLive(p, liveWindows) || matchPersistedToLive(p, liveAllSpaces);
    const isAbsent = live && !liveWindows.some(w => w.windowNumber === live.windowNumber);
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
      _spaceAbsent: isAbsent || false,
    });
    ws._lastKnownSnappedWns.add(live.windowNumber);
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
      hydrate.push({ windowNumber: wn, title: info.title, app: info.app, slot: info.slot });
    }
    ws.win.webContents.send('hydrate-snapped', hydrate);
  } catch {}

  // サイドバー側の snappedExternals Map も同期するため
  // external-windows 更新を即座に trigger (pollTimer を待たずに)
  scheduleSyncSnapped();
  console.log(`[tin] restored ${restored.length} snapped windows, ${missing.length} missing`);
}

// ── Space / Display 移動: workspace + snapped ターミナルを丸ごと移動 ──
// Spaces 移動は #5 で別途対応 (プライベート API で不安定のため一旦削除)

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
      ws._lastKnownSnappedWns.add(live.windowNumber);
      snappedIndexAdd(live.windowNumber, ws);
      const pos = getSlotBounds(ws, slot);
      if (pos) allMoveCmds.push({ windowNumber: live.windowNumber, pid: live.pid, app: live.app, title: live.title, windowIndex: live.windowIndex || 0, ...pos });
      restored.push({ app: live.app, title: live.title, slot });
    }
    // renderer に通知
    try {
      ws.win.webContents.send('restore-report', { restored, missing });
      const hydrate = [];
      for (const [wn, info] of ws.snappedExternals) hydrate.push({ windowNumber: wn, title: info.title, app: info.app, slot: info.slot });
      ws.win.webContents.send('hydrate-snapped', hydrate);
    } catch {}
    console.log(`[tin] restored ${restored.length} snapped, ${missing.length} missing in "${ws.name}"`);
  }

  // 全ウィンドウを1回の batchMove で移動
  // moveWindowsToActiveSpace を先に呼び、ウィンドウを現在 Space に集合させてから AX 移動する
  if (allMoveCmds.length > 0) {
    if (axHelper && axHelper.moveWindowsToActiveSpace) {
      try { axHelper.moveWindowsToActiveSpace(allMoveCmds.map(c => c.windowNumber)); } catch {}
      await new Promise(r => setTimeout(r, 80));
    }
    await batchMove(allMoveCmds);
    console.log(`[tin] batch restore: moved ${allMoveCmds.length} windows in 1 call`);
    // sticky 化 — stickyWindows 設定が ON の場合のみ (OFF = コンポジター負荷なし)
    if (appSettings.stickyWindows && axHelper && axHelper.setWindowSticky) {
      const wns = allMoveCmds.map(c => c.windowNumber);
      try { axHelper.setWindowSticky(wns, true); console.log(`[tin] batch restore: sticky set for ${wns.length} windows`); } catch {}
    }
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

process.on('uncaughtException', (err) => { if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return; });

// 外部ウィンドウ一覧 (snap/retile/auto-snap/release 処理用)。TiN 自身は除外して
// 自己 snap などの副作用を防ぐ。
function listWindows() {
  if (axHelper) {
    try {
      const all = axHelper.listWindows();
      return Promise.resolve(all.filter(w => w.app !== 'TiN'));
    } catch {}
  }
  return Promise.resolve([]);
}

// UI 表示用 (available リスト)。TiN ウィンドウも含めて別 workspace への移動を可能にする。
function listWindowsForUI() {
  if (axHelper) {
    try { return Promise.resolve(axHelper.listWindows()); } catch {}
  }
  return Promise.resolve([]);
}


// Fire-and-forget: sidebar ドラッグ中のリアルタイム retile 用。応答待ちで
// event loop をブロックしないので、次の move イベントをすぐ処理できる。
function fireAndForgetMove(windows, positionOnly = false) {
  if (!windows.length || !axHelper) return;
  try { axHelper.moveWindows(windows, positionOnly); } catch {}
}

// ── Stabilization guard ──
// Display reconnection and sleep/resume cause windows to temporarily
// disappear from CGWindowList even though they are still alive in AX.
// We set `stabilizingUntil` on these events to suppress release logic
// for a while afterward.
let stabilizingUntil = 0; // グローバル fallback (sleep/display 系イベント用)
const STABILIZE_MS = 30000;
let retileAfterStabilize = null;
let recoveryTimers = [];

// 再 snap: title + app で live window を探し、snap し直す
async function recoverSnappedWindows() {
  const allLive = await listWindows();
  for (const [, ws] of workspaces) {
    if (!ws.win || ws.win.isDestroyed()) continue;
    ensureOnScreen(ws);
    // 各 snapped について再リンク試行
    const toRelink = [];
    for (const [k, info] of ws.snappedExternals) {
      if (allLive.find(w => w.windowNumber === k)) continue; // 既に生きている
      // title + app で再検索
      let live = allLive.find(w => w.app === info.app && w.title === info.title);
      if (!live && info.title) {
        const prefix = info.title.slice(0, Math.min(40, info.title.length));
        live = allLive.find(w => w.app === info.app && w.title && w.title.startsWith(prefix));
      }
      if (live) toRelink.push({ oldKey: k, info, live });
    }
    // 再リンク実行
    for (const { oldKey, info, live } of toRelink) {
      ws.snappedExternals.delete(oldKey);
      ws._lastKnownSnappedWns.delete(oldKey);
      snappedIndexRemove(oldKey);
      info.windowNumber = live.windowNumber;
      info.pid = live.pid;
      info._missCount = 0;
      ws.snappedExternals.set(live.windowNumber, info);
      ws._lastKnownSnappedWns.add(live.windowNumber);
      snappedIndexAdd(live.windowNumber, ws);
    }
    if (toRelink.length > 0) console.log(`[tin] recovered ${toRelink.length} snapped in "${ws.name}"`);
    // retile で現在の sidebar 位置に基づいて再配置
    try { await retileAll(ws); } catch {}
    // renderer 更新
    const hydrate = [];
    for (const [wn, info] of ws.snappedExternals) hydrate.push({ windowNumber: wn, title: info.title, app: info.app, slot: info.slot });
    if (ws.win && !ws.win.isDestroyed()) ws.win.webContents.send('hydrate-snapped', hydrate);
  }
}

// ws を指定すると per-workspace stabilize（push-to-space, space-follow 用）
// ws 省略でグローバル stabilize（sleep/display 系）
function beginStabilize(reason, ws) {
  const until = Date.now() + STABILIZE_MS;
  if (ws) {
    ws._stabilizingUntil = until;
    for (const [, info] of ws.snappedExternals) info._missCount = 0;
  } else {
    stabilizingUntil = until;
    for (const [, w] of workspaces) {
      w._stabilizingUntil = until;
      for (const [, info] of w.snappedExternals) info._missCount = 0;
    }
  }
  console.log(`[tin] stabilizing for ${STABILIZE_MS}ms (reason: ${reason})`);
  recoveryTimers.forEach(t => clearTimeout(t));
  recoveryTimers = [];
  [1000, 3000, 8000, 15000, 30000].forEach(delay => {
    const t = setTimeout(() => {
      recoverSnappedWindows().catch(e => console.warn('[tin] recovery failed:', e.message));
    }, delay);
    recoveryTimers.push(t);
  });
}
function isStabilizing(ws) {
  const now = Date.now();
  return now < stabilizingUntil || (ws && now < (ws._stabilizingUntil || 0));
}

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

// Move windows: N-API addon (AXUIElement、TiN.app の TCC を直接使用) を第一経路、
// System Events (osascript) を fallback として使う。
// osascript fallback は System Events の set position/set size で動作し、
// set bounds と違ってグローバル座標で解釈される。
async function batchMove(cmds) {
  if (!cmds.length) return;
  if (!axHelper) return;
  const t0 = Date.now();
  try {
    const moved = axHelper.moveWindows(cmds, false);
    const dt = Date.now() - t0;
    if (dt > 30) console.log(`[tin] batchMove(native): ${dt}ms ${cmds.length}win moved=${moved}`);
  } catch {}
  // osascript fallback は廃止 — System Events が全アプリに Automation 権限を要求するため
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
    jobs.push(runOsascript(script, 3000));
  }
  if (jobs.length) await Promise.all(jobs);
}

// Raise: N-API addon で AXRaise (対象アプリをアクティブ化せず z-order だけ上げる)。
// native が一部失敗した場合のみ System Events で再試行する。
// 注: fallback は `set frontmost to true` を **使わない** — 対象アプリ全体を
// アクティブ化すると TiN がその後ろに隠れてしまうため。
async function raiseSpecificWindows(cmds) {
  if (!cmds.length) return;
  if (!axHelper) return;
  try {
    const t0 = Date.now();
    axHelper.raiseWindows(cmds);
    const dt = Date.now() - t0;
    if (dt > 30) console.log(`[tin] raise(native): ${dt}ms ${cmds.length}win`);
  } catch {}
  // osascript fallback は使わない — spawn ~200ms の遅延がタブ選択のもたつきの原因
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

// ── Grid geometry (Groupy コンテナモード) ──
// TiN ヘッダー (68px) の直下にアプリを配置。タイトルバーは完全に表示される。
function getGridArea(ws) {
  if (!ws.win || ws.win.isDestroyed()) return null;
  const b = ws.win.getBounds();
  return {
    x: b.x,
    y: b.y + GROUPY_Y_OFFSET,
    width: Math.max(200, b.width),
    height: Math.max(100, b.height - GROUPY_Y_OFFSET),
  };
}

function getSlotBounds(ws, slot) {
  const area = getGridArea(ws);
  if (!area) return null;

  // ── Tab モード: 全スロットを同じ全画面位置に配置、AX raise でアクティブを前面に ──
  // オフスクリーンパーキング不可（CGWindowList の OnScreenOnly から消える → unsnap 誤発火）
  if (ws.viewMode === 'tab') {
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  }

  // ── Grid モード: 通常のグリッドレイアウト ──
  // gap/padding は workspace.html の .gp-grid-container と一致させる
  // CSS: gap:8px, padding: 4px 8px 8px (top=4, right=8, bottom=8, left=8)
  const cols = ws.gridCols, rows = ws.gridRows;
  const gap = 8, padX = 8, padTop = 4, padBottom = 8;

  const colRatios = (ws.colRatios && ws.colRatios.length === cols) ? ws.colRatios : Array(cols).fill(1/cols);
  const rowRatios = (ws.rowRatios && ws.rowRatios.length === rows) ? ws.rowRatios : Array(rows).fill(1/rows);

  const innerW = area.width  - padX * 2 - gap * (cols - 1);
  const innerH = area.height - padTop - padBottom - gap * (rows - 1);

  // ── 柔軟グリッド: slotLayout がある場合は colSpan/rowSpan を考慮 ──
  let cellCol, cellRow, cellColSpan, cellRowSpan;
  if (ws.slotLayout) {
    const cell = ws.slotLayout.find(c => c.id === slot);
    if (!cell) return null;
    cellCol = cell.col; cellRow = cell.row;
    cellColSpan = cell.colSpan; cellRowSpan = cell.rowSpan;
  } else {
    cellCol = slot % cols; cellRow = Math.floor(slot / cols);
    cellColSpan = 1; cellRowSpan = 1;
  }

  let xOff = 0, yOff = 0;
  for (let i = 0; i < cellCol; i++) xOff += innerW * colRatios[i] + gap;
  for (let i = 0; i < cellRow; i++) yOff += innerH * rowRatios[i] + gap;

  let w = 0, h = 0;
  for (let i = 0; i < cellColSpan; i++) w += innerW * colRatios[cellCol + i] + (i > 0 ? gap : 0);
  for (let i = 0; i < cellRowSpan; i++) h += innerH * rowRatios[cellRow + i] + (i > 0 ? gap : 0);

  return {
    x: Math.round(area.x + padX + xOff),
    y: Math.round(area.y + padTop + yOff),
    width: Math.round(w),
    height: Math.round(h),
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

  // z-order (下→上): TiN → grid terminals → snapped externals
  // TiN を先に show
  if (ws.win && !ws.win.isDestroyed()) {
    ws.win.show();
  }

  // Grid BrowserWindows を show (TiN の上)
  for (const [, gw] of ws.gridWindows) {
    if (gw.win && !gw.win.isDestroyed()) gw.win.show();
  }

  // Snapped externals を最前面に raise (grid terminals より上に来る)
  if (ws.snappedExternals.size > 0) {
    const cmds = [...ws.snappedExternals.values()].map(info => ({
      windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
    }));
    await raiseSpecificWindows(cmds);
  }

  // force=true (サイドバー明示クリック) の場合のみ TiN にフォーカス
  // 通常の browser-window-focus では snapped ウィンドウをクリックするたびに
  // TiN が割り込まないよう focus しない
  if (force && ws.win && !ws.win.isDestroyed()) {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) app.focus({ steal: true });
    ws.win.focus();
  }
  const dt = Date.now() - t0;
  if (dt > 50) console.log(`[tin] raiseAll: ${dt}ms (${ws.snappedExternals.size} ext)`);
}

// ── Retile: reposition all grid items (embedded + external) ──
// fireAndForget=true: ドラッグ中のリアルタイム追従用。daemon 応答を待たない。
async function retileAll(ws, fireAndForget = false, positionOnly = false) {
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
      fireAndForgetMove(moveCmds, positionOnly);
    } else if (positionOnly) {
      // position のみ設定 (drag 終了時用: size は既に正しい前提、AX call を減らす)
      if (axHelper) {
        try { axHelper.moveWindows(moveCmds, true); return; } catch {}
      }
      await batchMove(moveCmds);
    } else {
      await batchMove(moveCmds);
    }
  }
}

function nextFreeSlot(ws) {
  const used = new Set();
  for (const [slot] of ws.gridWindows) used.add(slot);
  for (const [, info] of ws.snappedExternals) used.add(info.slot);
  if (ws.slotLayout) {
    for (const cell of ws.slotLayout) {
      if (!used.has(cell.id)) return cell.id;
    }
    return -1;
  }
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

  gridWin.on('page-title-updated', (e) => e.preventDefault());
  gridWin.setTitle(`TiN — ${ws.name} [${slot}]`);
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
ipcMain.handle('snap-external', async (event, { windowNumber, pid, app: appName, title, x, y, width, height, windowIndex, targetSlot }) => {
  const t0 = Date.now();
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const existing = isExternalSnapped(windowNumber);
  if (existing && existing.id !== ws.id) return { ok: false, reason: 'snapped-elsewhere' };
  // targetSlot 指定あり & 空なら使う。なければ nextFreeSlot にフォールバック。
  let slot = -1;
  if (Number.isInteger(targetSlot) && targetSlot >= 0 && targetSlot < ws.gridCols * ws.gridRows) {
    let occupied = false;
    for (const [, info] of ws.snappedExternals) { if (info.slot === targetSlot) { occupied = true; break; } }
    if (ws.gridWindows.has(targetSlot)) occupied = true;
    if (!occupied) slot = targetSlot;
  }
  if (slot < 0) slot = nextFreeSlot(ws);
  if (slot < 0) {
    // renderer の snappedExternals を main の実態に同期させる
    const hydrate = [...ws.snappedExternals].map(([wn, info]) => ({
      windowNumber: wn, title: info.title, app: info.app, slot: info.slot,
    }));
    return { ok: false, reason: 'no-slot', hydrate };
  }
  ws.snappedExternals.set(windowNumber, {
    app: appName, pid, title, windowNumber, windowIndex: windowIndex || 0, slot,
    origX: x, origY: y, origW: width, origH: height,
    snappedAt: Date.now(),
  });
  ws._lastKnownSnappedWns.add(windowNumber);
  snappedIndexAdd(windowNumber, ws);
  // snapped.json: 非同期で書き出し (AtelierX 競合は許容)
  scheduleSyncSnapped(0);
  // AX 操作は fire-and-forget で、renderer を待たせない (UI 即応)
  const pos = getSlotBounds(ws, slot);
  (async () => {
    try {
      if (axHelper && axHelper.moveWindowsToActiveSpace) {
        axHelper.moveWindowsToActiveSpace([windowNumber]);
        await new Promise(r => setTimeout(r, 80));
      }
      if (pos) await batchMove([{ windowNumber, pid, app: appName, title, windowIndex: windowIndex || 0, ...pos }]);
      if (appSettings.stickyWindows && axHelper && axHelper.setWindowSticky) {
        axHelper.setWindowSticky([windowNumber], true);
        console.log(`[tin] snap: wn=${windowNumber} → sticky=true`);
      }
    } catch {}
  })();
  scheduleSaveWorkspaces();
  console.log(`[tin] snap: prep=${Date.now()-t0}ms (AX 非同期)`);
  return { ok: true, slot };
});

ipcMain.handle('unsnap-external', async (event, { windowNumber }) => {
  const t0 = Date.now();
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const info = ws.snappedExternals.get(windowNumber);
  if (!info) return { ok: false };
  ws.snappedExternals.delete(windowNumber);
  ws._lastKnownSnappedWns.delete(windowNumber);
  snappedIndexRemove(windowNumber);
  compactSlots(ws);
  // sticky 解除 (unsnap 前に実施)
  if (axHelper && axHelper.setWindowSticky) {
    try { axHelper.setWindowSticky([windowNumber], false); } catch {}
  }
  // 元の位置・サイズに戻す。AX expansion は Terminal.app silent fail するので osascript 補完。
  const restoreCmd = [{ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
    x: info.origX, y: info.origY, width: info.origW, height: info.origH }];
  await batchMove(restoreCmd);
  await retileAll(ws);
  raiseAllWorkspaceWindows(ws, true).catch(() => {});
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

// ── IPC: wobble (ジグザグに揺らして場所を示す) + raise ──
// 「クリックしたカードがどのウィンドウか視覚的に示す」ための軽量アニメ。
// raise で最前面化した上で、左右+上+元位置の 3-pulse で視認性を高める。
ipcMain.handle('wobble-window', async (_event, { windowNumber, pid, app: appName, title, windowIndex }) => {
  if (!windowNumber && !appName) return { ok: false };
  if (!axHelper) return { ok: false };
  try {
    const all = axHelper.listWindows();
    const w = all.find(x => x.windowNumber === windowNumber)
          || all.find(x => x.pid === pid && x.title === title);
    if (!w) return { ok: false };
    const target = { windowNumber: w.windowNumber, pid: w.pid, app: appName, title: w.title, windowIndex: windowIndex || 0 };
    // 1. まず raise して z-order を最前面に (wobble を見えるようにする)
    axHelper.raiseWindows([target]);
    // 2. 3-pulse wobble: ジグザグに動かして視覚的に判別させる
    const pulses = [
      { dx: 14, dy: 0 },
      { dx: -14, dy: 0 },
      { dx: 0, dy: -10 },
      { dx: 0, dy: 0 },  // 元位置
    ];
    for (const p of pulses) {
      axHelper.moveWindows([{ ...target, x: w.x + p.dx, y: w.y + p.dy, width: w.width, height: w.height }], true);
      await new Promise(r => setTimeout(r, 45));
    }
  } catch {}
  return { ok: true };
});

ipcMain.handle('get-snapped-externals', (event) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return {};
  return Object.fromEntries([...ws.snappedExternals.entries()].map(([k, v]) => [k, v.slot]));
});

// Available リストから他の TiN workspace の sidebar をクリックしたとき、
// その workspace 全体 (sidebar + grid + snapped) を前面化する。
ipcMain.on('raise-tin-window', (_event, { windowNumber }) => {
  for (const [, ws] of workspaces) {
    if (ws.win && !ws.win.isDestroyed() && ws.win.getNativeWindowHandle) {
      // windowNumber は CGWindowList 経由の値なので Electron BrowserWindow とは直接紐付かない。
      // sidebar のタイトル位置で照合する代わりに、bounds でマッチしてもよいが、
      // 単純に title 一致 (TiN — {name}) で対象を決める方が確実。
    }
  }
  // CGWindowList の windowNumber から対象の workspace を逆引き
  if (!axHelper) return;
  try {
    const all = axHelper.listWindows();
    const target = all.find(w => w.windowNumber === windowNumber);
    if (!target) return;
    // タイトルから workspace 名を抽出: "TiN — {name}"
    const m = /^TiN — (.+?)$/.exec(target.title);
    if (!m) return;
    const wsName = m[1];
    for (const [, ws] of workspaces) {
      if (ws.name === wsName) {
        raiseAllWorkspaceWindows(ws, true);
        return;
      }
    }
  } catch {}
});

// ── IPC: grid config ──
// Slot picker 用: grid 情報と各 slot の占有状態を返す
ipcMain.handle('get-grid-state', (event) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return null;
  const total = ws.gridCols * ws.gridRows;
  const slots = [];
  for (let i = 0; i < total; i++) {
    let occupant = null;
    for (const [, info] of ws.snappedExternals) {
      if (info.slot === i) { occupant = { type: 'ext', title: info.title, app: info.app }; break; }
    }
    if (!occupant && ws.gridWindows.has(i)) occupant = { type: 'grid', title: `Terminal #${i+1}` };
    slots.push(occupant);
  }
  return { cols: ws.gridCols, rows: ws.gridRows, slots };
});

// ── Global Hotkeys ──────────────────────────────────────────────────────────

// フロントウィンドウを対象 workspace の次の空きスロットにスナップ
async function snapFrontmostWindow(ws) {
  if (!axHelper) return;
  const wn = axHelper.getFrontmostWindowNumber();
  if (!wn) return;
  if (isExternalSnapped(wn)) return; // 既にスナップ済み
  const allWins = axHelper.listWindows();
  const win = allWins.find(w => w.windowNumber === wn);
  if (!win || win.app === 'TiN') return;
  const slot = nextFreeSlot(ws);
  if (slot < 0) return;
  ws.snappedExternals.set(wn, {
    app: win.app, pid: win.pid, title: win.title, windowNumber: wn,
    windowIndex: win.windowIndex || 0, slot,
    origX: win.x, origY: win.y, origW: win.width, origH: win.height,
    snappedAt: Date.now(),
  });
  ws._lastKnownSnappedWns.add(wn);
  snappedIndexAdd(wn, ws);
  scheduleSyncSnapped(0);
  const pos = getSlotBounds(ws, slot);
  if (pos) {
    try {
      if (axHelper.moveWindowsToActiveSpace) {
        axHelper.moveWindowsToActiveSpace([wn]);
        await new Promise(r => setTimeout(r, 80));
      }
      await batchMove([{ windowNumber: wn, pid: win.pid, app: win.app, title: win.title, ...pos }]);
      if (appSettings.stickyWindows && axHelper.setWindowSticky) axHelper.setWindowSticky([wn], true);
    } catch {}
  }
  scheduleSaveWorkspaces();
}

// フロントウィンドウをスナップ解除
async function unsnapFrontmostWindow(ws) {
  if (!axHelper) return;
  const wn = axHelper.getFrontmostWindowNumber();
  if (!wn) return;
  const info = ws.snappedExternals.get(wn);
  if (!info) return;
  ws.snappedExternals.delete(wn);
  ws._lastKnownSnappedWns.delete(wn);
  snappedIndexRemove(wn);
  compactSlots(ws);
  scheduleSyncSnapped(0);
  if (axHelper.setWindowSticky) try { axHelper.setWindowSticky([wn], false); } catch {}
  const cmds = [{ windowNumber: wn, pid: info.pid, app: info.app, title: info.title,
    x: info.origX, y: info.origY, width: info.origW, height: info.origH }];
  try { await osascriptMove(cmds); } catch {}
  await retileAll(ws);
  scheduleSaveWorkspaces();
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = { ...DEFAULT_HOTKEYS, ...(appSettings.hotkeys || {}) };

  // アクティブな (or 最初の) workspace を返すヘルパー
  const activeWs = () => [...workspaces.values()][0];

  const actions = {
    snapFrontmost:   () => { const ws = activeWs(); if (ws) snapFrontmostWindow(ws).catch(() => {}); },
    unsnapFrontmost: () => { const ws = activeWs(); if (ws) unsnapFrontmostWindow(ws).catch(() => {}); },
    focusTiN: () => {
      for (const [, ws] of workspaces) {
        if (ws.win && !ws.win.isDestroyed()) { ws.win.show(); ws.win.focus(); }
      }
    },
    slot1: () => { const ws = activeWs(); if (ws) ipcMain.emit('set-active-tab-hotkey', ws, 0); },
    slot2: () => { const ws = activeWs(); if (ws) ipcMain.emit('set-active-tab-hotkey', ws, 1); },
    slot3: () => { const ws = activeWs(); if (ws) ipcMain.emit('set-active-tab-hotkey', ws, 2); },
    slot4: () => { const ws = activeWs(); if (ws) ipcMain.emit('set-active-tab-hotkey', ws, 3); },
  };

  for (const [key, acc] of Object.entries(hk)) {
    if (!acc || !actions[key]) continue;
    try {
      const ok = globalShortcut.register(acc, actions[key]);
      if (!ok) console.warn(`[tin] hotkey conflict: ${acc} (${key})`);
    } catch (e) {
      console.warn(`[tin] hotkey register failed: ${acc} — ${e.message}`);
    }
  }
}

// slot切替をホットキーから直接実行
ipcMain.on('set-active-tab-hotkey', (ws, slot) => {
  if (!ws || !ws.win || ws.win.isDestroyed()) return;
  ws.activeTabSlot = slot;
  ws.viewMode = 'tab';
  beginStabilize('set-active-tab', ws);
  retileAll(ws).then(() => {
    const activeWns = [];
    for (const [wn, info] of ws.snappedExternals) {
      if (info.slot === slot) activeWns.push({ windowNumber: wn, pid: info.pid, app: info.app, title: info.title });
    }
    if (activeWns.length && axHelper && axHelper.raiseWindows) axHelper.raiseWindows(activeWns);
  }).catch(() => {});
  ws.win.webContents.send('tab-switched-hotkey', slot);
});

// Settings IPC
ipcMain.handle('get-settings', () => ({ ...appSettings }));
ipcMain.handle('save-settings', (_event, newSettings) => {
  const prev = { ...appSettings };
  appSettings = { ...DEFAULT_SETTINGS, ...(newSettings || {}),
    hotkeys: { ...DEFAULT_HOTKEYS, ...(newSettings?.hotkeys || {}) } };
  saveSettings();
  // 即座に反映: auto-launch
  if (appSettings.autoLaunch !== prev.autoLaunch) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!appSettings.autoLaunch, openAsHidden: false });
    } catch {}
  }
  // poll 間隔変更時は全 workspace の timer 再起動
  if (appSettings.pollIntervalMs !== prev.pollIntervalMs) {
    for (const [, ws] of workspaces) {
      if (ws._pollRestart) ws._pollRestart();
    }
  }
  // hotkeys 変更時は再登録
  registerHotkeys();
  return { ok: true, settings: { ...appSettings } };
});

// ユーザが "Retile" ボタンを押した時:
//   1. snapped 全ウィンドウを現在アクティブな Space に引き寄せる
//   2. slot 位置・サイズに合わせる (AX + osascript)
ipcMain.handle('retile-now', async (event) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const cmds = [];
  const wns = [];
  for (const [, info] of ws.snappedExternals) {
    const b = getSlotBounds(ws, info.slot);
    if (b) {
      cmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title, ...b });
      wns.push(info.windowNumber);
    }
  }
  // sticky 再設定 (stickyWindows ON 時のみ)
  if (appSettings.stickyWindows && wns.length && axHelper && axHelper.setWindowSticky) {
    try { axHelper.setWindowSticky(wns, true); } catch {}
  }
  // snapped ウィンドウ + このワークスペースの TiN 全ウィンドウをまとめて現在 Space に引き寄せる
  const sidebarWn = getElectronWinNumber(ws.win);
  const allWns = [...new Set([...wns, ...(sidebarWn ? [sidebarWn] : [])])];
  if (allWns.length && axHelper && axHelper.moveWindowsToActiveSpace) {
    try { axHelper.moveWindowsToActiveSpace(allWns); } catch {}
  }
  if (cmds.length) {
    await batchMove(cmds);
    osascriptMove(cmds).catch(() => {});
  }
  return { ok: true };
});

// TiN サイドバー + snap 済みウィンドウを丸ごと次/前のデスクトップ (Space) に移動。
// direction: +1 = 次, -1 = 前。移動後ユーザーがスワイプして確認する。
// Electron BrowserWindow の CGWindowNumber を title でマッチして返す。
// transparent ウィンドウは CGWindowList に出ないため AX 経由でウィンドウ番号を取得。
// AX から取得した windowNumber[] を pid のタイトルでマッチせずそのまま返す。
// 各 BrowserWindow は AX の window 配列の先頭から順に対応するが、
// ここでは pid の全 wn を返して呼び出し側で使う。
const _electronWnCache = new WeakMap();
function getElectronWinNumber(win) {
  if (!axHelper || !win || win.isDestroyed()) return null;
  if (!axHelper.getWindowNumbersByPid) {
    // fallback: CGWindowList
    try {
      const myPid = process.pid;
      const title = win.getTitle();
      const match = axHelper.listWindows().find(w => w.pid === myPid && w.title === title);
      return match ? match.windowNumber : null;
    } catch { return null; }
  }
  try {
    const wns = axHelper.getWindowNumbersByPid(process.pid);
    if (!wns || wns.length === 0) return null;
    // BrowserWindow の index を bounds で近似マッチ
    const b = win.getBounds();
    const cgWins = axHelper.listWindows().filter(w => w.pid === process.pid);
    if (cgWins.length > 0) {
      // CGWindowList に出ていれば title マッチ
      const title = win.getTitle();
      const m = cgWins.find(w => w.title === title);
      if (m) return m.windowNumber;
    }
    // transparent 等で CGWindowList に出ない場合: AX wns の最初を返す
    // (複数ウィンドウがある場合は全部渡して moveToSpace で一括処理するため問題なし)
    return wns[0] || null;
  } catch { return null; }
}

ipcMain.handle('push-to-space', async (event, { direction }) => {
  const ws = findWorkspace(event.sender);
  if (!ws || !axHelper || !axHelper.moveToSpace) return { ok: false };

  // TiN 自身のウィンドウ番号を getNativeWindowHandle で確実に取得
  // (transparent: true ウィンドウは CGWindowList/AX には出ない)
  let electronWns = [];
  if (ws.win && !ws.win.isDestroyed() && axHelper.getWindowIdFromHandle) {
    try {
      const handle = ws.win.getNativeWindowHandle();
      const ptr = handle.readBigUInt64LE(0);
      const wid = axHelper.getWindowIdFromHandle(ptr);
      if (wid > 0) electronWns.push(wid);
    } catch (e) {
      console.log(`[tin] getWindowIdFromHandle error: ${e.message}`);
    }
  }

  // snapped externals: 現 Space の snappedExternals を優先
  let snappedWns = [...ws.snappedExternals.values()]
    .map(info => info.windowNumber)
    .filter(wn => typeof wn === 'number' && wn > 0);

  // TiN が別 Space に移動済みで snappedExternals が空の場合は
  // _lastKnownSnappedWns + listWindowsAllSpaces() でウィンドウを探す
  if (snappedWns.length === 0 && ws._lastKnownSnappedWns.size > 0 && axHelper.listWindowsAllSpaces) {
    try {
      const allWinsList = axHelper.listWindowsAllSpaces();
      const allWnSet = new Set(allWinsList.map(w => w.windowNumber));
      for (const wn of ws._lastKnownSnappedWns) {
        if (allWnSet.has(wn)) snappedWns.push(wn);
        else ws._lastKnownSnappedWns.delete(wn); // 本当に閉じた
      }
    } catch (e) {
      console.log(`[tin] listWindowsAllSpaces error: ${e.message}`);
    }
  }

  console.log(`[tin] push-to-space dir=${direction} electronWns=[${electronWns}] snappedWns=[${snappedWns}]`);
  if (!electronWns.length) return { ok: false, reason: 'no-tin-window' };

  // 目標 Space ID を CGS から事前計算（yabai 検証と moveWindowsToSpaceId に使用）
  let targetSpaceId = null;
  if (axHelper.getSpacesList) {
    try {
      const spaceList = axHelper.getSpacesList();
      const curIdx = spaceList.findIndex(s => s.isCurrent);
      if (curIdx >= 0) {
        const tgtIdx = ((curIdx + direction) + spaceList.length) % spaceList.length;
        targetSpaceId = spaceList[tgtIdx].id;
      }
    } catch {}
  }

  beginStabilize('push-to-space', ws);
  try {
    // ── sticky 方式: snapped windows は snap 時に sticky 化済み ──
    // sticky window は全 Space に常時表示されるため、TiN を移動するだけで
    // snapped window も新 Space に追従する。
    // 100ms タイマー (_groupyFollowTimer) が位置を TiN に合わせて再配置する。

    // TiN 自身を移動（CGS、自プロセスなので確実）
    const tinMoved = axHelper.moveToSpace ? axHelper.moveToSpace(electronWns, direction) : 0;
    console.log(`[tin] push-to-space tinMoved=${tinMoved} snappedSticky=${snappedWns.length}`);

    // TiN を新 Space のディスプレイに合わせて中央配置
    // 短い待機後に実行（Space アニメーション中はディスプレイ取得が不安定）
    await new Promise(r => setTimeout(r, 180));
    if (ws.win && !ws.win.isDestroyed()) {
      const b = ws.win.getBounds();
      const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const wa = disp.workArea;
      ws.win.setBounds({
        x: wa.x + Math.round((wa.width - b.width) / 2),
        y: wa.y + Math.round((wa.height - b.height) / 2),
        width: b.width, height: b.height,
      });
      // retileAll で sticky snapped windows を TiN の新位置に揃える
      await retileAll(ws, true).catch(() => {});
    }

    // _tinSpaceId 更新（space-follow ポーリングの誤検知防止）
    if (electronWns.length > 0 && axHelper.getSpaceForWindows) {
      try {
        const spaces = axHelper.getSpaceForWindows([electronWns[0]]);
        const sid = Number(spaces[0]?.spaceId || 0);
        if (sid > 0) ws._tinSpaceId = sid;
      } catch {}
    }

    return { ok: true, moved: tinMoved };
  } catch (e) {
    console.log(`[tin] push-to-space error: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// ── Space 一覧取得 ──
// yabai query を優先、なければ CGS native で返す
ipcMain.handle('get-spaces', async () => {
  const p = getYabaiPath();
  if (p && await yabaiIsRunning()) {
    try {
      const { stdout } = await execAsync(`${p} -m query --spaces`, { timeout: 2000 });
      const ys = JSON.parse(stdout);
      return ys.map(s => ({
        index: s.index,
        id: s.id,
        label: s.label || '',
        isCurrent: !!(s['has-focus'] || s.focused || s['is-visible']),
      }));
    } catch {}
  }
  if (axHelper && axHelper.getSpacesList) {
    try {
      return axHelper.getSpacesList().map(s => ({
        index: s.index,
        id: s.id,
        label: '',
        isCurrent: s.isCurrent,
      }));
    } catch {}
  }
  return [];
});

// ── 特定 Space への移動 (ピッカー用) ──
// targetSpaceId: CGS Space ID (get-spaces の id フィールド)
// targetIndex:   yabai Space index (get-spaces の index フィールド、yabai 使用時)
ipcMain.handle('push-to-space-to', async (event, { targetSpaceId, targetIndex }) => {
  const ws = findWorkspace(event.sender);
  if (!ws || !axHelper) return { ok: false };

  // TiN ウィンドウ番号取得
  let electronWns = [];
  if (ws.win && !ws.win.isDestroyed() && axHelper.getWindowIdFromHandle) {
    try {
      const handle = ws.win.getNativeWindowHandle();
      const ptr = handle.readBigUInt64LE(0);
      const wid = axHelper.getWindowIdFromHandle(ptr);
      if (wid > 0) electronWns.push(wid);
    } catch {}
  }
  if (!electronWns.length) return { ok: false, reason: 'no-tin-window' };

  // snapped 全取得（別 Space のものも含む）
  let snappedWns = [...ws.snappedExternals.values()]
    .map(i => i.windowNumber).filter(wn => typeof wn === 'number' && wn > 0);
  if (snappedWns.length === 0 && ws._lastKnownSnappedWns.size > 0 && axHelper.listWindowsAllSpaces) {
    try {
      const allWns = new Set(axHelper.listWindowsAllSpaces().map(w => w.windowNumber));
      for (const wn of ws._lastKnownSnappedWns) {
        if (allWns.has(wn)) snappedWns.push(wn);
        else ws._lastKnownSnappedWns.delete(wn);
      }
    } catch {}
  }

  console.log(`[tin] push-to-space-to spaceId=${targetSpaceId} idx=${targetIndex} electronWns=[${electronWns}] snappedWns=[${snappedWns}]`);
  beginStabilize('push-to-space-to', ws);
  try {
    let yabaiMoved = 0, cgsMoved = 0;

    // ターミナル移動: yabai 絶対インデックス優先
    const yabaiSucceeded = new Set();
    if (snappedWns.length > 0) {
      const p = getYabaiPath();
      if (p && targetIndex && await yabaiIsRunning()) {
        await Promise.all(snappedWns.map(async wn => {
          try {
            await execAsync(`${p} -m window ${wn} --space ${targetIndex}`, { timeout: 3000 });
            yabaiSucceeded.add(wn);
          } catch (e) {
            console.log(`[tin] yabai wn=${wn} --space ${targetIndex} failed: ${e.stderr?.trim()}`);
          }
        }));
        yabaiMoved = yabaiSucceeded.size;
      }
      // yabai 偽陽性を検証: 実際に targetSpaceId に移動したか確認
      if (yabaiSucceeded.size > 0 && axHelper.getSpaceForWindows && targetSpaceId) {
        const actualSpaces = axHelper.getSpaceForWindows([...yabaiSucceeded]);
        for (const s of actualSpaces) {
          if (Number(s.spaceId) !== Number(targetSpaceId)) {
            console.log(`[tin] yabai偽陽性 wn=${s.wn}: spaceId=${s.spaceId} ≠ target=${targetSpaceId} → CGS fallback`);
            yabaiSucceeded.delete(s.wn);
          }
        }
        yabaiMoved = yabaiSucceeded.size;
      }
      // yabai で実際に動かなかった分は CGS で移動
      const cgsTargets = snappedWns.filter(wn => !yabaiSucceeded.has(wn));
      if (cgsTargets.length > 0 && axHelper.moveWindowsToSpaceId && targetSpaceId) {
        cgsMoved = axHelper.moveWindowsToSpaceId(cgsTargets, targetSpaceId);
        console.log(`[tin] cgs moved ${cgsMoved}/${cgsTargets.length} to spaceId=${targetSpaceId}`);
      }
    }

    // TiN 自身を CGS で移動
    let tinMoved = 0;
    if (axHelper.moveWindowsToSpaceId && targetSpaceId) {
      tinMoved = axHelper.moveWindowsToSpaceId(electronWns, targetSpaceId);
    }

    // センタリング + retile
    if (ws.win && !ws.win.isDestroyed()) {
      const b = ws.win.getBounds();
      const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const wa = disp.workArea;
      ws.win.setBounds({ x: wa.x + Math.round((wa.width - b.width) / 2), y: wa.y + Math.round((wa.height - b.height) / 2), width: b.width, height: b.height });
      retileAll(ws, true).catch(() => {});
    }
    if (electronWns.length > 0 && axHelper.getSpaceForWindows) {
      try {
        const spaces = axHelper.getSpaceForWindows([electronWns[0]]);
        const sid = Number(spaces[0]?.spaceId || 0);
        if (sid > 0) ws._tinSpaceId = sid;
      } catch {}
    }
    return { ok: true, moved: tinMoved + yabaiMoved + cgsMoved };
  } catch (e) {
    console.log(`[tin] push-to-space-to error: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// slot の順序を並べ替え (line card の間にドロップする挿入操作)。
// src の entry を dst の前/後ろに挿入し、全 slot を 0,1,2,... で再割当。
ipcMain.handle('reorder-grid-slot', async (event, { src, dst, before }) => {
  const ws = findWorkspace(event.sender);
  console.log(`[reorder] src=${src} dst=${dst} before=${before} ws=${ws ? ws.name : 'null'}`);
  if (!ws) return { ok: false };
  src = Number(src); dst = Number(dst);
  if (src === dst) return { ok: true };
  const items = [];
  for (const [wn, info] of ws.snappedExternals) items.push({ type: 'ext', slot: info.slot, ref: info, wn });
  for (const [slot, gw] of ws.gridWindows) items.push({ type: 'pty', slot: Number(slot), ref: gw });
  items.sort((a, b) => a.slot - b.slot);
  console.log(`[reorder] items=`, items.map(i => `${i.type}@${i.slot}`).join(','));
  const srcIdx = items.findIndex(i => i.slot === src);
  if (srcIdx < 0) { console.log(`[reorder] src-not-found src=${src}`); return { ok: false, reason: 'src-not-found' }; }
  const dstIdx = items.findIndex(i => i.slot === dst);
  if (dstIdx < 0) { console.log(`[reorder] dst-not-found dst=${dst}`); return { ok: false, reason: 'dst-not-found' }; }
  const srcItem = items[srcIdx];
  items.splice(srcIdx, 1);
  // splice 後、dst の index を再取得 (srcIdx<dstIdx なら -1 ずれる)
  let insertIdx = items.findIndex(i => i.slot === dst);
  if (!before) insertIdx++;
  items.splice(insertIdx, 0, srcItem);
  console.log(`[reorder] reassigned=`, items.map((i, idx) => `${i.type}@${idx}(was=${i.slot})`).join(','));
  // slot を 0,1,2,... で再割当
  ws.gridWindows.clear();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'pty') {
      ws.gridWindows.set(i, item.ref);
      if (item.ref.slot !== undefined) item.ref.slot = i;
    } else {
      item.ref.slot = i;
    }
  }
  try { await retileAll(ws); } catch (e) { console.error('[reorder] retile error', e); }
  try { scheduleSaveWorkspaces(); } catch {}
  return { ok: true };
});

// slot 入れ替え (drag&drop から呼ばれる)。pty/ext どちらも対応。
ipcMain.handle('swap-grid-slots', async (event, { src, dst }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  if (src === dst) return { ok: true };
  const total = ws.gridCols * ws.gridRows;
  if (!Number.isFinite(src) || !Number.isFinite(dst) || src < 0 || dst < 0 || src >= total || dst >= total) {
    return { ok: false, reason: 'invalid-slot' };
  }
  const srcPty = ws.gridWindows.get(src);
  const dstPty = ws.gridWindows.get(dst);
  let srcExt = null, dstExt = null;
  for (const [wn, info] of ws.snappedExternals) {
    if (info.slot === src) srcExt = { wn, info };
    else if (info.slot === dst) dstExt = { wn, info };
  }
  // pty: gridWindows Map を入れ替え
  if (srcPty) ws.gridWindows.delete(src);
  if (dstPty) ws.gridWindows.delete(dst);
  if (srcPty) ws.gridWindows.set(dst, srcPty);
  if (dstPty) ws.gridWindows.set(src, dstPty);
  // ext: info.slot を更新
  if (srcExt) srcExt.info.slot = dst;
  if (dstExt) dstExt.info.slot = src;
  // retile で visual 反映 (ext window 移動 + pty window move)
  try { await retileAll(ws); } catch (e) { console.error('[swap-grid-slots] retile error', e); }
  try { scheduleSaveWorkspaces(); } catch {}
  return { ok: true };
});

ipcMain.handle('set-grid-size', (event, { cols, rows }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  // 新サイズに収まらないスナップを押し出してから変更
  const validSlotIds = new Set(Array.from({ length: cols * rows }, (_, i) => i));
  evictOverflowSnapped(ws, validSlotIds);
  ws.gridCols = cols;
  ws.gridRows = rows;
  ws.colRatios = null;
  ws.rowRatios = null;
  ws.slotLayout = null;
  if (ws.win && !ws.win.isDestroyed()) {
    ws.win.webContents.send('update-grid-panel', { cols, rows, colRatios: null, rowRatios: null, slotLayout: null });
  }
  beginStabilize('set-grid-size', ws);
  retileAll(ws);
  scheduleSaveWorkspaces();
});

// ── 有効スロットに収まらないスナップウィンドウを処理 ──
// 空きスロットがあればシフト、なければ元位置に戻してアンスナップ
function evictOverflowSnapped(ws, validSlotIds) {
  // 現在有効スロット内で使用中のスロットを収集
  const usedSlots = new Set();
  for (const [, info] of ws.snappedExternals) {
    if (validSlotIds.has(info.slot)) usedSlots.add(info.slot);
  }

  const overflow = [];
  for (const [wn, info] of ws.snappedExternals) {
    if (!validSlotIds.has(info.slot)) overflow.push(wn);
  }
  if (!overflow.length) return;

  console.log(`[tin] overflow ${overflow.length} snapped windows — shift or evict`);
  for (const wn of overflow) {
    const info = ws.snappedExternals.get(wn);
    // 空き有効スロットを探してシフト
    let freeSlot = -1;
    for (const id of validSlotIds) {
      if (!usedSlots.has(id)) { freeSlot = id; break; }
    }
    if (freeSlot >= 0) {
      usedSlots.add(freeSlot);
      info.slot = freeSlot;
      console.log(`[tin] shift wn=${wn} → slot ${freeSlot}`);
    } else {
      // 空きなし → アンスナップ（元位置に戻す）
      ws.snappedExternals.delete(wn);
      ws._lastKnownSnappedWns.delete(wn);
      snappedIndexRemove(wn);
      if (axHelper && axHelper.setWindowSticky) {
        try { axHelper.setWindowSticky([wn], false); } catch {}
      }
      if (info && info.origX !== undefined) {
        batchMove([{ windowNumber: info.windowNumber, pid: info.pid, app: info.app,
          title: info.title, x: info.origX, y: info.origY, width: info.origW, height: info.origH }]).catch(() => {});
      }
      console.log(`[tin] evict wn=${wn} (no free slot)`);
    }
  }
  // renderer の snappedExternals を同期
  if (ws.win && !ws.win.isDestroyed()) {
    const hydrate = [...ws.snappedExternals].map(([wn, info]) => ({ windowNumber: wn, title: info.title, app: info.app, slot: info.slot }));
    ws.win.webContents.send('hydrate-snapped', hydrate);
  }
  scheduleSyncSnapped();
}

// ── 柔軟グリッド: slotLayout を設定 ──
ipcMain.handle('set-slot-layout', (event, { layout }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  // 結合後の有効スロットIDに収まらないスナップを押し出す
  const validSlotIds = layout
    ? new Set(layout.map(cell => cell.id))
    : new Set(Array.from({ length: ws.gridCols * ws.gridRows }, (_, i) => i));
  evictOverflowSnapped(ws, validSlotIds);
  ws.slotLayout = layout;
  if (ws.win && !ws.win.isDestroyed()) {
    ws.win.webContents.send('update-grid-panel', {
      cols: ws.gridCols, rows: ws.gridRows,
      colRatios: ws.colRatios, rowRatios: ws.rowRatios,
      slotLayout: layout,
    });
  }
  retileAll(ws).catch(() => {});
  scheduleSaveWorkspaces();
});

// ── Tab / Grid モード切り替え ──
ipcMain.handle('set-view-mode', (event, { mode }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  ws.viewMode = mode;
  beginStabilize('set-view-mode', ws); // retile 中の watchdog 誤発火を抑制
  retileAll(ws);
});

// Tab モードでアクティブなスロットを変更し retile + AX raise
ipcMain.handle('set-active-tab', (event, { slot }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  ws.activeTabSlot = Number(slot);
  ws.viewMode = 'tab';
  beginStabilize('set-active-tab', ws);
  retileAll(ws).then(() => {
    // アクティブスロットのウィンドウを前面に上げる
    const activeWns = [];
    for (const [wn, info] of ws.snappedExternals) {
      if (info.slot === Number(slot)) activeWns.push({ windowNumber: wn, pid: info.pid, app: info.app, title: info.title });
    }
    if (activeWns.length > 0 && axHelper && axHelper.raiseWindows) {
      axHelper.raiseWindows(activeWns);
    }
  }).catch(() => {});
});

ipcMain.on('rename-workspace', (event, { name }) => {
  const ws = findWorkspace(event.sender);
  if (ws) {
    ws.name = name;
    if (ws.win && !ws.win.isDestroyed()) ws.win.setTitle(`TiN — ${name}`);
    for (const [slot, gw] of ws.gridWindows) {
      if (gw.win && !gw.win.isDestroyed()) gw.win.setTitle(`TiN — ${name} [${slot}]`);
    }
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
  const wh = 650;
  const offset = (wsId - 1) * 30;

  // sidebar 位置: saved state があればそれを、なければデフォルト
  const savedSidebar = savedState && savedState.sidebar;
  const savedGrid = savedState && savedState.grid;
  const winX = savedSidebar ? savedSidebar.x : 50 + offset;
  const winY = savedSidebar ? savedSidebar.y : Math.round((sh - wh) / 2) + offset;
  // 統合ウィンドウ幅 = sidebarWidth + divider + gridWidth
  // 旧フォーマット互換: sidebar.width が小さい (300以下) なら旧サイドバー幅なので gridWidth を補完
  const savedSidebarW = (savedState && savedState.sidebarWidth) || DEFAULT_SIDEBAR_W;
  const savedGridW = savedGrid && savedGrid.width ? savedGrid.width : 800;
  let winW;
  if (savedSidebar && savedSidebar.width) {
    // 旧フォーマット: sidebar.width が sidebarWidth+gridWidth の合計か否かを判定
    winW = savedSidebar.width > 600
      ? savedSidebar.width  // 新フォーマット (統合ウィンドウ幅)
      : savedSidebar.width + SIDEBAR_DIVIDER_W + savedGridW; // 旧フォーマット補完
  } else {
    winW = savedSidebarW + SIDEBAR_DIVIDER_W + savedGridW;
  }
  const winH = savedSidebar && savedSidebar.height ? savedSidebar.height : wh;

  const win = new BrowserWindow({
    width: winW, height: winH,
    minWidth: DEFAULT_SIDEBAR_W + SIDEBAR_DIVIDER_W + 200,
    minHeight: 300,
    x: winX,
    y: winY,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    transparent: true,        // グリッドパネル部分を透過させスナップウィンドウを表示
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: false,
    acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });

  const wsName = name || (savedState && savedState.name) || `Workspace ${wsId}`;
  // HTML <title> による上書きを防止 — CGWindowList でワークスペース名が見えるように
  win.on('page-title-updated', (e) => e.preventDefault());
  win.setTitle(`TiN — ${wsName}`);
  const ws = {
    id: wsId, win, name: wsName,
    snappedExternals: new Map(),
    _lastKnownSnappedWns: new Set(), // Space 移動後も snapped wn を保持 (miss で消えない)
    _tinSpaceId: 0, // TiN 自身の現在 Space ID (Mission Control 追従検知用)
    gridWindows: new Map(),    // slot -> { win, pty, ptyId }
    sidebarPtys: new Map(),    // ptyId -> pty (for sidebar embedded terms)
    gridOverlay: null,         // 廃止済み (統合ウィンドウ方式)
    pollTimer: null,
    moveThrottle: null,
    overlayThrottle: null,
    gridCols: savedGrid ? (savedGrid.cols || 2) : (appSettings.defaultGridCols || 2),
    gridRows: savedGrid ? (savedGrid.rows || 2) : (appSettings.defaultGridRows || 2),
    sidebarWidth: savedSidebarW,
    colRatios: savedGrid && savedGrid.colRatios ? savedGrid.colRatios : null,
    rowRatios: savedGrid && savedGrid.rowRatios ? savedGrid.rowRatios : null,
    slotLayout: savedGrid && savedGrid.slotLayout ? savedGrid.slotLayout : null,
    color: (savedState && savedState.colorIndex != null) ? WS_COLORS[savedState.colorIndex % WS_COLORS.length] : WS_COLORS[(wsId - 1) % WS_COLORS.length],
    colorIndex: (savedState && savedState.colorIndex != null) ? savedState.colorIndex : (wsId - 1) % WS_COLORS.length,
  };
  workspaces.set(wsId, ws);
  registerWorkspaceContents(ws);
  // 復元対象の snapped エントリを deferred に処理する (daemon + sidebar 準備後)
  if (savedState && Array.isArray(savedState.snappedExternals) && savedState.snappedExternals.length > 0) {
    ws._pendingRestore = savedState.snappedExternals;
  }


  win.loadFile('workspace.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('workspace-info', { id: wsId, name: wsName, color: ws.color });
    // サイドバー幅を CSS 変数として通知
    win.webContents.send('set-sidebar-width', { width: ws.sidebarWidth || DEFAULT_SIDEBAR_W });
    // グリッドパネルを初期化
    win.webContents.send('update-grid-panel', { cols: ws.gridCols, rows: ws.gridRows, colRatios: ws.colRatios, rowRatios: ws.rowRatios, slotLayout: ws.slotLayout });
    // リロード後も main 側の snappedExternals を renderer に同期
    if (ws.snappedExternals.size > 0) {
      const hydrate = [...ws.snappedExternals].map(([wn, info]) => ({
        windowNumber: wn, title: info.title, app: info.app, slot: info.slot,
      }));
      win.webContents.send('hydrate-snapped', hydrate);
    }
    // 復元は restoreAllPending() で一括実行 (個別ではなく全 workspace まとめて)
    if (ws._pendingRestore) scheduleRestoreAll();
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // Move grid items + overlay when sidebar moves/resizes
  // **リアルタイム追従**: ドラッグ中も snapped ウィンドウが一緒に動く。
  // throttle (16ms ≈ 60fps) で daemon に move を送る。前の move が完了する前に
  // 次の move を投げないようガードする。
  // sidebar ドラッグ中: overlay 同期 + snapped windows をリアルタイム追従
  // drag 中は snapped 外部ウィンドウの AX 追従を停止し、主スレッドを空ける。
  // 外部ターミナルは drag 終了時の retileAll で一括配置する。
  let _dragging = false;
  let _groupyDirty = false; // 外部ウィンドウ追従が必要かどうか
  const onWinMove = () => {
    // 1. embedded BrowserWindow は setBounds() で即座に同期 (ブロックしない)
    for (const [slot, gw] of ws.gridWindows) {
      if (gw.win && !gw.win.isDestroyed()) {
        const b = getSlotBounds(ws, slot);
        if (b) gw.win.setBounds(b);
      }
    }
    // 2. 外部ウィンドウはフラグを立てるだけ — AX は 50ms タイマーで非同期実行
    if (ws.snappedExternals.size > 0) _groupyDirty = true;
  };

  // 外部ウィンドウ追従タイマー (100ms = 10fps)
  // move イベントから分離して main thread のブロックを回避
  const _groupyFollowTimer = setInterval(() => {
    if (!_groupyDirty || !ws.snappedExternals.size || !axHelper || ws.win?.isDestroyed()) return;
    _groupyDirty = false;
    const cmds = [];
    for (const [, info] of ws.snappedExternals) {
      const b = getSlotBounds(ws, info.slot);
      if (b) cmds.push({ windowNumber: info.windowNumber, pid: info.pid,
        app: info.app, title: info.title, windowIndex: info.windowIndex || 0, ...b });
    }
    if (cmds.length) fireAndForgetMove(cmds, true);
  }, 100);
  // ウィンドウ close 時にタイマーを停止
  win.once('closed', () => clearInterval(_groupyFollowTimer));

  win.on('move', onWinMove);
  win.on('resize', onWinMove);
  win.on('will-move', () => { if (!_dragging) { _dragging = true; } });
  win.on('moved', () => {
    _dragging = false;
    // 設定に従って drag 終了時の挙動を切り替え
    const mode = appSettings.dragEndMode || 'position';
    if (mode === 'position') retileAll(ws, false, true);
    else if (mode === 'full') retileAll(ws);
    // 'off' の場合は何もしない (Retile ボタンで手動同期)
    scheduleSaveWorkspaces();
  });
  // sidebar resize 終了時は slot サイズも変わる可能性があるので full retile
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
  ws.viewMode = 'grid';       // 'grid' | 'tab' — Groupy 表示モード
  ws.activeTabSlot = 0;       // Tab モードでアクティブなスロット番号
  // Poll external windows
  // pollTimer: デフォルト 1500ms。listWindows (CGWindowList, ~1ms) なので短縮しても CPU 負荷は低い。
  // snap/unsnap の即時操作には影響しない。snapped の grace period は 3 回 miss = ~4.5s。
  const pollFn = async () => {
    if (!ws.win || ws.win.isDestroyed()) return;
    if (_dragging) return;

    // TiN 自身が別 Space に移動した検知 (Mission Control / 直接 Space 移動)
    // sticky 方式: snapped windows は全 Space に存在するため CGS 移動は不要
    // TiN が新 Space に来たら retileAll で位置を揃えるだけでよい
    if (axHelper && axHelper.getSpaceForWindows &&
        ws.snappedExternals.size > 0 && !isStabilizing(ws)) {
      try {
        const handle = ws.win.getNativeWindowHandle();
        const ptr = handle.readBigUInt64LE(0);
        const tinWid = axHelper.getWindowIdFromHandle ? axHelper.getWindowIdFromHandle(ptr) : 0;
        if (tinWid > 0) {
          const spaces = axHelper.getSpaceForWindows([tinWid]);
          const tinSpaceId = Number(spaces[0]?.spaceId || 0);
          if (tinSpaceId > 0) {
            if (ws._tinSpaceId > 0 && tinSpaceId !== ws._tinSpaceId) {
              console.log(`[tin] space-follow (sticky): TiN ${ws._tinSpaceId}→${tinSpaceId}, retiling ${ws.snappedExternals.size} windows`);
              beginStabilize('space-follow', ws);
              // sticky windows は新 Space でも同じ座標にいるため retileAll だけで揃う
              setTimeout(() => retileAll(ws, true).catch(() => {}), 200);
            }
            ws._tinSpaceId = tinSpaceId;
          }
        }
      } catch {}
    }

    const windowsAll = await listWindowsForUI();
    const windows = windowsAll.filter(w => w.app !== 'TiN');

    // 大量消失検知: sleep 復帰 / ディスプレイ切替の watchdog
    // windowNumber が変わっただけ (title 再マッチで救える) のケースは missing 扱いしない。
    // 連続 2 回 50%以上 missing した時だけ発動 → 1 poll の瞬間的な欠落では誤発動しない。
    if (!isStabilizing(ws) && ws.snappedExternals.size >= 2) {
      const liveSet = new Set();
      for (const w of windows) liveSet.add(w.windowNumber);
      let missing = 0;
      for (const [k, info] of ws.snappedExternals) {
        if (liveSet.has(k)) continue;
        let found = false;
        if (info.title) {
          for (const w of windows) {
            if (w.app === info.app && w.title === info.title) { found = true; break; }
          }
          if (!found) {
            const prefix = info.title.slice(0, Math.min(40, info.title.length));
            for (const w of windows) {
              if (w.app === info.app && w.title && w.title.startsWith(prefix)) { found = true; break; }
            }
          }
        }
        if (!found) missing++;
      }
      if (missing / ws.snappedExternals.size >= 0.5) {
        ws._watchdogMissStreak = (ws._watchdogMissStreak || 0) + 1;
        if (ws._watchdogMissStreak >= 2) {
          console.log(`[tin] watchdog: ${missing}/${ws.snappedExternals.size} missing (streak=${ws._watchdogMissStreak}) → auto-recovery`);
          beginStabilize('watchdog-mass-disappear', ws);
          ws._watchdogMissStreak = 0;
        }
      } else {
        ws._watchdogMissStreak = 0;
      }
    }
    // liveMap 構築: windowNumber → window (O(1) lookup)
    const liveMap = new Map();
    for (const w of windows) liveMap.set(w.windowNumber, w);

    // Title fallback: スナップ済みウィンドウのタイトルのみ osascript で補完。
    // 全ウィンドウに適用すると 4ws × 15app × 2 osascript = ~120プロセス/5s になる。
    if (windows.length > 0) {
      // キャッシュヒットを先に適用 (全ウィンドウ)
      for (const w of windows) {
        if (!w.title) {
          const cached = ws._titleCache.get(w.windowNumber);
          if (cached) w.title = cached;
        }
      }
      // osascript 補完: スナップ済みでタイトルが空のものだけ対象
      const snappedMissingApps = new Set();
      for (const [wn, info] of ws.snappedExternals) {
        const live = liveMap.get(wn);
        if (live && !live.title) snappedMissingApps.add(live.app);
      }
      if (snappedMissingApps.size > 0) {
        const now = Date.now();
        if (now - ws._titleCacheRefreshAt > 30000) { // 30秒レート制限 (5秒→30秒)
          ws._titleCacheRefreshAt = now;
          for (const appName of snappedMissingApps) {
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
        const liveNums = new Set(windows.map(w => w.windowNumber));
        for (const k of ws._titleCache.keys()) {
          if (!liveNums.has(k)) ws._titleCache.delete(k);
        }
      }
    }
    let snappedChanged = false;
    for (const [k, info] of ws.snappedExternals) {
      let live = liveMap.get(k);
      // sleep 復帰等で windowNumber が変わった場合: title + app + pid で再マッチ
      if (!live && info.title) {
        for (const w of windows) {
          if (w.app === info.app && w.title === info.title) { live = w; break; }
        }
        if (!live) {
          // 前方一致でも試す
          const prefix = info.title.slice(0, Math.min(40, info.title.length));
          for (const w of windows) {
            if (w.app === info.app && w.title && w.title.startsWith(prefix)) { live = w; break; }
          }
        }
        if (live) {
          // windowNumber を更新して再リンク
          ws.snappedExternals.delete(k);
          ws._lastKnownSnappedWns.delete(k);
          snappedIndexRemove(k);
          info.windowNumber = live.windowNumber;
          info.pid = live.pid;
          ws.snappedExternals.set(live.windowNumber, info);
          ws._lastKnownSnappedWns.add(live.windowNumber);
          snappedIndexAdd(live.windowNumber, ws);
          snappedChanged = true;
          // 復元位置に再 snap (fire-and-forget で event loop ブロックしない)
          const pos = getSlotBounds(ws, info.slot);
          if (pos) fireAndForgetMove([{ windowNumber: live.windowNumber, pid: live.pid, app: info.app, title: info.title, ...pos }]);
          info._missCount = 0;
          continue;
        }
      }
      if (!live) {
        if (isStabilizing(ws)) {
          info._missCount = 0;
          continue;
        }
        // space-absent 中は既に別 Space と判定済み → miss を数えない
        if (info._spaceAbsent) continue;
        info._missCount = (info._missCount || 0) + 1;
        if (info._missCount >= 3) {
          // 別 Space に存在するか確認 (閉じた vs Space 移動の区別)
          let foundElsewhere = false;
          if (axHelper && axHelper.listWindowsAllSpaces) {
            try {
              const allWins = axHelper.listWindowsAllSpaces();
              foundElsewhere = allWins.some(w => w.windowNumber === k);
            } catch {}
          }
          if (foundElsewhere) {
            // 別 Space にいる → ghost として保持、スロットは占有したまま
            info._spaceAbsent = true;
            info._missCount = 0;
          } else {
            // 本当に閉じた → 削除
            ws.snappedExternals.delete(k);
            ws._lastKnownSnappedWns.delete(k);
            snappedIndexRemove(k);
            compactSlots(ws);
            snappedChanged = true;
          }
        }
        continue;
      }
      // ウィンドウが現 Space に戻ってきた
      if (info._spaceAbsent) {
        info._spaceAbsent = false;
        // 正しいスロット位置に再配置
        const pos = getSlotBounds(ws, info.slot);
        if (pos) fireAndForgetMove([{ windowNumber: live.windowNumber, pid: live.pid, app: info.app, title: info.title, ...pos }]);
        snappedChanged = true;
      }
      info._missCount = 0;
      if (info.title !== live.title || info.pid !== live.pid) {
        info.title = live.title;
        info.pid = live.pid;
      }
    }

    // Fast-path: build identity string and skip IPC if nothing changed
    // スナップ済みウィンドウのみタイトルを含める (terminal タイトルは常時変化するため
    // 全ウィンドウのタイトルを入れると毎 poll で IPC が発火してしまう)
    const snappedWnSet = new Set(ws.snappedExternals.keys());
    let identity = '';
    for (const w of windows) {
      identity += w.windowNumber;
      if (snappedWnSet.has(w.windowNumber)) { identity += ':'; identity += w.title; }
      identity += ',';
    }
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
    // UI には TiN 自身も含めて送る (available リストに TiN workspace を表示するため)。
    // 自 workspace の TiN ウィンドウは除外して重複表示を防ぐ。
    const ownTitles = new Set();
    ownTitles.add(`TiN — ${ws.name}`);
    ownTitles.add(`TiN — ${ws.name} Grid`);
    for (const [slot] of ws.gridWindows) ownTitles.add(`TiN — ${ws.name} [${slot}]`);
    const windowsForUI = windowsAll.filter(w => !(w.app === 'TiN' && ownTitles.has(w.title)));
    // snapped ext の完全リスト（空間的に見えなくても権威あるリスト）
    const snappedSlots = {};
    const snappedList = []; // renderer の snappedExternals を authoritative に同期するため
    for (const [wn, info] of ws.snappedExternals) {
      if (typeof info.slot === 'number') snappedSlots[wn] = info.slot;
      snappedList.push({ windowNumber: wn, title: info.title, app: info.app, slot: info.slot });
    }
    // 最前面 window (focused slot ハイライト用) — _frontmostInterval (500ms) のキャッシュを流用
    ws.win.webContents.send('external-windows', windowsForUI, snappedByOther, gridSlots, snappedSlots, _lastFrontmost, snappedList);
  };
  ws.pollTimer = setInterval(pollFn, appSettings.pollIntervalMs || 4000);
  ws._pollRestart = () => {
    if (ws.pollTimer) clearInterval(ws.pollTimer);
    ws.pollTimer = setInterval(pollFn, appSettings.pollIntervalMs || 4000);
  };

  // ── clickthrough 完全管理: IPC に頼らず main process だけで ON/OFF を決定 ──
  // renderer の set-win-clickthrough IPC は backup として残すが、このループが主制御。
  // IPC の非同期性によるクリック取りこぼしを防ぐため、ここで両方向を設定する。
  let _ctState = false; // 現在の setIgnoreMouseEvents 状態キャッシュ (呼び出し削減)
  const _setCT = (on) => {
    if (_ctState === on) return;
    _ctState = on;
    ws.win.setIgnoreMouseEvents(on, { forward: true });
  };
  const _ctGuardLoop = () => {
    try {
      if (!ws.win || ws.win.isDestroyed()) {
        ws._ctGuardTimer = setTimeout(_ctGuardLoop, 500);
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const b = ws.win.getBounds();
      const inWindow = cursor.x >= b.x && cursor.x <= b.x + b.width
                    && cursor.y >= b.y && cursor.y <= b.y + b.height;
      if (!inWindow) {
        _setCT(false);
        ws._ctGuardTimer = setTimeout(_ctGuardLoop, 800);
        return;
      }
      // ヘッダー / overlay / editMode → OFF、グリッドエリア → ON
      const inHeader = cursor.y < b.y + TITLEBAR_H;
      _setCT(!(inHeader || ws._hasOverlay || ws._editMode));
      ws._ctGuardTimer = setTimeout(_ctGuardLoop, 50);
    } catch {
      ws._ctGuardTimer = setTimeout(_ctGuardLoop, 200);
    }
  };
  ws._ctGuardTimer = setTimeout(_ctGuardLoop, 50);

  win.on('closed', async () => {
    if (ws.pollTimer) clearInterval(ws.pollTimer);
    if (ws._ctGuardTimer) clearTimeout(ws._ctGuardTimer);
    if (ws.moveThrottle) clearTimeout(ws.moveThrottle);
    if (ws.overlayThrottle) clearTimeout(ws.overlayThrottle);
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
    ws._lastKnownSnappedWns.clear();
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
    if (w.win === focusedWin) { ws = w; break; }
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

// renderer からの clickthrough 制御 (renderer が grid panel 上かどうかを判定して呼ぶ)
ipcMain.on('set-win-clickthrough', (event, on) => {
  const ws = findWorkspace(event.sender);
  if (!ws || !ws.win || ws.win.isDestroyed()) return;
  ws.win.setIgnoreMouseEvents(on, { forward: true });
});
ipcMain.on('set-overlay-active', (event, active) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  ws._hasOverlay = !!active;
  // overlay ON になった瞬間に clickthrough を即座に OFF (IPC → _ctGuardLoop 遅延を橋渡し)
  if (active && ws.win && !ws.win.isDestroyed()) {
    ws.win.setIgnoreMouseEvents(false);
  }
});
ipcMain.on('set-edit-mode', (event, active) => {
  const ws = findWorkspace(event.sender);
  if (ws) ws._editMode = !!active;
});

// 統合ウィンドウ方式では raise-all-from-overlay / set-overlay-clickthrough は不要 (no-op)
ipcMain.on('raise-all-from-overlay', () => {});
ipcMain.on('set-overlay-clickthrough', () => {
  {
    if (false) {
      return;
    }
  }
});

ipcMain.handle('get-overlay-bounds', (event) => {
  const ws = findWorkspace(event.sender);
  if (ws) return getGridArea(ws);
  return null;
});

// Grid edit モード: ratio 更新 (ドラッグ中 fire-and-forget)
ipcMain.on('update-grid-ratios', (event, { colRatios, rowRatios }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  ws.colRatios = colRatios;
  ws.rowRatios = rowRatios;
  // snapped windows を fire-and-forget で追従
  const moveCmds = [];
  for (const [, info] of ws.snappedExternals) {
    const b = getSlotBounds(ws, info.slot);
    if (b) moveCmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title, ...b });
  }
  // embedded grid 即座
  for (const [slot, gw] of ws.gridWindows) {
    if (gw.win && !gw.win.isDestroyed()) {
      const b = getSlotBounds(ws, slot);
      if (b) gw.win.setBounds(b);
    }
  }
  if (moveCmds.length) fireAndForgetMove(moveCmds, false);
});

// Grid edit 確定
ipcMain.on('commit-grid-ratios', async (event, { colRatios, rowRatios }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  ws.colRatios = colRatios;
  ws.rowRatios = rowRatios;
  await retileAll(ws);
  scheduleSaveWorkspaces();
});

// Edit モード開始 (renderer からのリクエスト)
ipcMain.on('enter-grid-edit', (event) => {
  const ws = findWorkspace(event.sender);
  if (ws && ws.win && !ws.win.isDestroyed()) {
    ws.win.webContents.send('enter-grid-edit-mode');
  }
});

// resize-overlay は統合ウィンドウ方式では不要 (no-op)
ipcMain.on('resize-overlay', () => {});

// sidebar 幅変更 (divider ドラッグ)
ipcMain.on('sidebar-width-changed', (event, { width }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return;
  ws.sidebarWidth = width;
  // embedded grid windows を即座に再配置
  for (const [slot, gw] of ws.gridWindows) {
    if (gw.win && !gw.win.isDestroyed()) {
      const b = getSlotBounds(ws, slot);
      if (b) gw.win.setBounds(b);
    }
  }
  retileAll(ws, false, true);
  scheduleSaveWorkspaces();
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
            if (focused && (ws.win === focused)) { target = ws; break; }
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
            if (focused && (ws.win === focused)) { target = ws; break; }
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
            if (focused && (ws.win === focused)) { target = ws; break; }
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
            match.ws._lastKnownSnappedWns.delete(match.info.windowNumber);
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
        sidebarWidth: ws.sidebarWidth || DEFAULT_SIDEBAR_W,
        grid: { cols: ws.gridCols, rows: ws.gridRows, colRatios: ws.colRatios, rowRatios: ws.rowRatios, slotLayout: ws.slotLayout },
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
      ws._lastKnownSnappedWns.add(w.windowNumber);
      snappedIndexAdd(w.windowNumber, ws);
      const pos = getSlotBounds(ws, slot);
      if (pos) await batchMove([{ windowNumber: w.windowNumber, pid: w.pid, app: w.app, title: w.title, ...pos }]);
    }
  );
  // renderer に snapped 情報を送信 (GRID 欄に反映させる)
  if (!result.error) {
    for (const [, ws] of workspaces) {
      if (!ws.win || ws.win.isDestroyed()) continue;
      const hydrate = [];
      for (const [wn, info] of ws.snappedExternals) {
        hydrate.push({ windowNumber: wn, title: info.title, app: info.app, slot: info.slot });
      }
      ws.win.webContents.send('hydrate-snapped', hydrate);
    }
  }
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

// Frontmost window 専用の軽量 poll (getFrontmostWindowNumber は CGWindowList 1 回 ~1ms)。
// 外部 cmd+tab / 他 app 切替時の focused ハイライト更新用。
// 500ms × 1ms = 0.2% 未満の CPU 使用率で済む。
let _lastFrontmost = 0;
let _frontmostInterval = null;
function startFrontmostPoll() {
  if (!axHelper || !axHelper.getFrontmostWindowNumber) return;
  if (_frontmostInterval) return;
  _frontmostInterval = setInterval(() => {
    try {
      const wn = axHelper.getFrontmostWindowNumber() || 0;
      if (wn === _lastFrontmost) return;
      _lastFrontmost = wn;
      for (const [, ws] of workspaces) {
        if (ws.win && !ws.win.isDestroyed()) {
          ws.win.webContents.send('frontmost-update', wn);
        }
      }
    } catch {}
  }, 1000); // 1000ms: mousedown で即時更新するので視覚的な遅れなし
}

app.whenReady().then(() => {
  writeInfoJson();
  writeSnappedJson();
  startFrontmostPoll();
  registerHotkeys();
  startRestServer();

  // stickyWindows=false の場合: 残存 sticky を起動時に即解除 (前バージョンの遺産を清掃)
  if (!appSettings.stickyWindows && axHelper && axHelper.setWindowSticky) {
    try {
      const allWins = axHelper.listWindows();
      const nonTiN = allWins.filter(w => w.app !== 'TiN').map(w => w.windowNumber);
      if (nonTiN.length) axHelper.setWindowSticky(nonTiN, false);
      console.log(`[tin] cleared sticky on ${nonTiN.length} windows`);
    } catch {}
  }

  // Accessibility 権限チェック: 無いと snap / raise が silent fail するので
  // 明示的にダイアログ表示して System Settings へ誘導。
  if (axHelper && !axHelper.isAXTrusted()) {
    const btn = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'TiN: アクセシビリティ権限が必要です',
      message: 'TiN がウィンドウを snap / raise するにはアクセシビリティ権限が必要です。',
      detail: 'システム設定 → プライバシーとセキュリティ → アクセシビリティ で TiN を有効化してください。一度拒否された場合はリストから TiN を削除してから再度許可してください。',
      buttons: ['システム設定を開く', '後で'],
      defaultId: 0,
      cancelId: 1,
    });
    if (btn === 0) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  }

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
    { label: app.name, submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => {
        const win = BrowserWindow.getFocusedWindow();
        if (win) win.webContents.send('open-preferences');
      }},
      { type: 'separator' },
      { role: 'quit' },
    ]},
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
            if (ws.win === focused) { targets = [ws]; break; }
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
          if (moveCmds.length) await batchMove(moveCmds);
        }
      }},
      { type: 'separator' },
      { label: 'Auto Snap (AI)', accelerator: 'CmdOrCtrl+Shift+G', click: () => triggerAutoSnap({ filter: 'terminal' }) },
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
          if (ws.win === focused) { currentIdx = i; break; }
          for (const [, gw] of ws.gridWindows) {
            if (gw.win === focused) { currentIdx = i; break; }
          }
          if (currentIdx >= 0) break;
        }
        const nextWs = wsList[(currentIdx + 1) % wsList.length];
        raiseAllWorkspaceWindows(nextWs, true);
      }},
      { type: 'separator' },
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
      sidebarWidth: ws.sidebarWidth || DEFAULT_SIDEBAR_W,
      grid: { cols: ws.gridCols, rows: ws.gridRows, colRatios: ws.colRatios, rowRatios: ws.rowRatios, slotLayout: ws.slotLayout },
      colorIndex: ws.colorIndex,
      snappedExternals: snapped,
    });
  }
  atomicWriteJSONSync(WORKSPACES_JSON, payload);
}

// ── REST API (localhost only) — Raycast 拡張・外部ツール連携用 ──────────────
// port は info.json に書き出し。
const REST_PORT = 37123;
let _restServer = null;

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function restReply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function startRestServer() {
  if (_restServer) return;
  _restServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { restReply(res, 204, {}); return; }
    const url = new URL(req.url, `http://localhost:${REST_PORT}`);
    const route = `${req.method} ${url.pathname}`;

    // GET /api/status — ワークスペース・スナップ状態
    if (route === 'GET /api/status') {
      const wsArr = [];
      for (const [, ws] of workspaces) {
        const snapped = [];
        for (const [wn, info] of ws.snappedExternals) {
          snapped.push({ windowNumber: wn, app: info.app, title: info.title, slot: info.slot });
        }
        wsArr.push({ id: ws.id, name: ws.name, gridCols: ws.gridCols, gridRows: ws.gridRows,
          snapped, gridTerminals: ws.gridWindows.size });
      }
      return restReply(res, 200, { ok: true, version: PROTOCOL_VERSION, workspaces: wsArr });
    }

    // GET /api/windows — スナップ可能なウィンドウ一覧
    if (route === 'GET /api/windows') {
      const wins = axHelper ? axHelper.listWindows().filter(w => w.app !== 'TiN') : [];
      return restReply(res, 200, { ok: true, windows: wins.map(w => ({
        windowNumber: w.windowNumber, app: w.app, title: w.title, pid: w.pid
      })) });
    }

    // POST /api/snap — フロントウィンドウをスナップ { windowNumber?: number, workspaceId?: number }
    if (route === 'POST /api/snap') {
      const body = await parseBody(req);
      const ws = (body.workspaceId ? workspaces.get(body.workspaceId) : null) || [...workspaces.values()][0];
      if (!ws) return restReply(res, 404, { ok: false, error: 'no workspace' });
      let targetWn = body.windowNumber;
      if (!targetWn && axHelper) targetWn = axHelper.getFrontmostWindowNumber();
      if (!targetWn) return restReply(res, 400, { ok: false, error: 'no window' });
      if (isExternalSnapped(targetWn)) return restReply(res, 200, { ok: true, note: 'already snapped' });
      const allWins = axHelper ? axHelper.listWindows() : [];
      const win = allWins.find(w => w.windowNumber === targetWn);
      if (!win || win.app === 'TiN') return restReply(res, 400, { ok: false, error: 'invalid window' });
      const slot = nextFreeSlot(ws);
      if (slot < 0) return restReply(res, 409, { ok: false, error: 'no free slot' });
      ws.snappedExternals.set(targetWn, {
        app: win.app, pid: win.pid, title: win.title, windowNumber: targetWn,
        windowIndex: win.windowIndex || 0, slot,
        origX: win.x, origY: win.y, origW: win.width, origH: win.height, snappedAt: Date.now(),
      });
      ws._lastKnownSnappedWns.add(targetWn);
      snappedIndexAdd(targetWn, ws);
      scheduleSyncSnapped(0);
      const pos = getSlotBounds(ws, slot);
      if (pos) {
        (async () => {
          try {
            if (axHelper.moveWindowsToActiveSpace) { axHelper.moveWindowsToActiveSpace([targetWn]); await new Promise(r=>setTimeout(r,80)); }
            await batchMove([{ windowNumber: targetWn, pid: win.pid, app: win.app, title: win.title, ...pos }]);
            if (appSettings.stickyWindows && axHelper.setWindowSticky) axHelper.setWindowSticky([targetWn], true);
          } catch {}
        })();
      }
      scheduleSaveWorkspaces();
      return restReply(res, 200, { ok: true, slot, workspaceId: ws.id });
    }

    // POST /api/unsnap { windowNumber: number }
    if (route === 'POST /api/unsnap') {
      const body = await parseBody(req);
      let wn = body.windowNumber;
      if (!wn && axHelper) wn = axHelper.getFrontmostWindowNumber();
      if (!wn) return restReply(res, 400, { ok: false, error: 'no window' });
      let found = false;
      for (const [, ws] of workspaces) {
        const info = ws.snappedExternals.get(wn);
        if (!info) continue;
        found = true;
        ws.snappedExternals.delete(wn);
        ws._lastKnownSnappedWns.delete(wn);
        snappedIndexRemove(wn);
        compactSlots(ws);
        scheduleSyncSnapped(0);
        if (axHelper?.setWindowSticky) try { axHelper.setWindowSticky([wn], false); } catch {}
        osascriptMove([{ windowNumber: wn, pid: info.pid, app: info.app, title: info.title,
          x: info.origX, y: info.origY, width: info.origW, height: info.origH }]).catch(() => {});
        retileAll(ws).catch(() => {});
        scheduleSaveWorkspaces();
        break;
      }
      return restReply(res, found ? 200 : 404, { ok: found, error: found ? undefined : 'not snapped' });
    }

    // POST /api/focus — TiN ウィンドウをフォーカス
    if (route === 'POST /api/focus') {
      for (const [, ws] of workspaces) {
        if (ws.win && !ws.win.isDestroyed()) { ws.win.show(); ws.win.focus(); }
      }
      return restReply(res, 200, { ok: true });
    }

    restReply(res, 404, { ok: false, error: 'not found' });
  });

  _restServer.listen(REST_PORT, '127.0.0.1', () => {
    console.log(`[tin] REST API listening on http://127.0.0.1:${REST_PORT}`);
  });
  _restServer.on('error', (e) => {
    console.warn(`[tin] REST API error: ${e.message}`);
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // REST サーバーを強制クローズ (接続待ちで quit がブロックされないよう)
  if (_restServer) {
    try {
      // Node 18.2+ では closeAllConnections() が使える
      if (_restServer.closeAllConnections) _restServer.closeAllConnections();
      _restServer.close();
    } catch {}
    _restServer = null;
  }
});

app.on('before-quit', (e) => {
  if (app._quitting) return; // 二重呼び出し防止
  app._quitting = true;
  app.isQuitting = true;
  e.preventDefault(); // 非同期 cleanup のために一時停止

  // PTY を全 kill (SIGKILL で即時停止)
  for (const [, ws] of workspaces) {
    for (const [, gw] of ws.gridWindows) { try { gw.pty.kill('SIGKILL'); } catch {} }
    for (const [, p] of (ws.sidebarPtys || new Map())) { try { p.kill('SIGKILL'); } catch {} }
  }

  try { writeWorkspacesJsonSync(); } catch {}
  try { if (fs.existsSync(INFO_JSON)) fs.unlinkSync(INFO_JSON); } catch {}
  try { if (fs.existsSync(SNAPPED_JSON)) fs.unlinkSync(SNAPPED_JSON); } catch {}

  // node-pty の ThreadSafeFunction が JS cleanup で crash するのを避けるため
  // PTY kill 後に 50ms 待ってから process.exit() で直接終了する
  setTimeout(() => process.exit(0), 50);
});

app.on('window-all-closed', () => app.quit());
