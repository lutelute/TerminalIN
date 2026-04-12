const { app, BrowserWindow, ipcMain, screen, Menu, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { spawn, exec, execFile } = require('child_process');

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

// ── Integration protocol (docs/PROTOCOL.md) ──
// 外部ツール (AtelierX plugin 等) と連携するための状態ファイル書き出し。
// 依存関係: AtelierX 固有のコードは一切含めない — 汎用 URL scheme/ファイル IPC として公開する。
const PROTOCOL_VERSION = '1.0';
const TIN_CAPABILITIES = ['snap', 'raise', 'workspace', 'grid-terminal', 'window-list'];
const INTEGRATION_DIR = path.join(app.getPath('userData'));
const INFO_JSON = path.join(INTEGRATION_DIR, 'info.json');
const SNAPPED_JSON = path.join(INTEGRATION_DIR, 'snapped.json');
const TIN_START_TIME = Date.now();

function atomicWriteJSON(filePath, obj) {
  try {
    if (!fs.existsSync(INTEGRATION_DIR)) fs.mkdirSync(INTEGRATION_DIR, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // 書き出し失敗は TiN 本体機能を妨げない (graceful)
    console.warn('[integration] write failed:', filePath, e.message);
  }
}

function writeInfoJson() {
  atomicWriteJSON(INFO_JSON, {
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

function writeSnappedJson() {
  const snappedWindows = [];
  let activeWorkspaceId = null;
  // フォーカス中 workspace を activeWorkspaceId として記録
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
  atomicWriteJSON(SNAPPED_JSON, {
    protocol: PROTOCOL_VERSION,
    updatedAt: Date.now(),
    activeWorkspaceId,
    snappedWindows,
  });
}

// 書き出しのデバウンス (rapid snap/unsnap/move で多重書き込みを避ける)
let _syncTimer = null;
function scheduleSyncSnapped(delay = 80) {
  if (_syncTimer) return;
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    try { writeSnappedJson(); } catch {}
  }, delay);
}

// ── Workspace registry ──
const workspaces = new Map();
let nextWsId = 1;
let nextPtyId = 1;

// ── Swift daemon (list + move only) ──
const DAEMON_BIN = app.isPackaged
  ? path.join(process.resourcesPath, 'daemon')
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
let _daemonAXUntrusted = false;

async function batchMove(cmds) {
  if (!cmds.length) return;
  if (_daemonAXUntrusted) {
    await osascriptMove(cmds);
    return;
  }
  const result = await daemonRequest('move', { windows: cmds });
  // daemon 応答がない → 全件 fallback
  if (!result || typeof result.moved !== 'number') {
    await osascriptMove(cmds);
    return;
  }
  if (result.axTrusted === false) {
    if (!_daemonAXUntrusted) {
      _daemonAXUntrusted = true;
      console.warn('[tin] daemon reports AXIsProcessTrusted()=false — switching to System Events fallback for move/raise.');
    }
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
      const t = (w.title || '').substring(0, 40).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

// Raise: daemon (fast) with osascript fallback.
// daemon が AXRaise を使ってアプリをアクティブ化せず z-order だけ上げる。
// パッケージ版で daemon の AX 権限が継承されない場合、silent fail するので
// daemon が返す failed[] を元に System Events で再試行する。
// 注: fallback は `set frontmost to true` を **使わない** — 対象アプリ全体を
// アクティブ化すると TiN がその後ろに隠れてしまうため。
async function raiseSpecificWindows(cmds) {
  if (!cmds.length) return;
  let retry = cmds;
  if (!_daemonAXUntrusted) {
    const result = await daemonRequest('raise', { windows: cmds });
    if (result && typeof result.raised === 'number') {
      if (result.axTrusted === false) {
        _daemonAXUntrusted = true;
        console.warn('[tin] daemon reports AXIsProcessTrusted()=false — switching to System Events fallback.');
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
function findWorkspace(webContents) {
  for (const [, ws] of workspaces) {
    if (ws.win && !ws.win.isDestroyed() && ws.win.webContents === webContents) return ws;
  }
  return null;
}

function isExternalSnapped(windowNumber) {
  for (const [, ws] of workspaces) {
    if (ws.snappedExternals.has(windowNumber)) return ws;
  }
  return null;
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
    height: b.height,
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

  // 1. Raise snapped external terminal windows first.
  // MUST be awaited — otherwise the async daemon raise completes AFTER
  // we raise TiN, clobbering the intended z-order.
  if (ws.snappedExternals.size > 0) {
    const cmds = [...ws.snappedExternals.values()].map(info => ({
      windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
    }));
    await raiseSpecificWindows(cmds);
  }

  // 2. Raise grid BrowserWindows above the externals
  for (const [, gw] of ws.gridWindows) {
    if (gw.win && !gw.win.isDestroyed()) {
      gw.win.show();
    }
  }

  // 3. Bring overlay + workspace sidebar to the top.
  // app.focus({steal:true}) is required to steal focus from another macOS app
  // (e.g. Terminal.app). A plain win.focus() is a no-op when the frontmost
  // app is not TiN itself due to macOS focus-stealing prevention.
  if (ws.gridOverlay && !ws.gridOverlay.isDestroyed()) {
    ws.gridOverlay.show();
  }
  if (ws.win && !ws.win.isDestroyed()) {
    app.focus({ steal: true });
    ws.win.show();
    ws.win.focus();
  }
}

// ── Retile: reposition all grid items (embedded + external) ──
async function retileAll(ws) {
  const moveCmds = [];

  // Reposition embedded grid windows
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

  if (moveCmds.length) await batchMove(moveCmds);
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
  const pos = getSlotBounds(ws, slot);
  if (pos) await batchMove([{ windowNumber, pid, app: appName, title, ...pos }]);
  // Restore z-order: the move may have activated the target app, pushing
  // ALL its windows — including ones not snapped — in front of TiN.
  // Raise only the snapped window + TiN sidebar.
  await raiseAllWorkspaceWindows(ws, true);
  scheduleSyncSnapped();
  return { ok: true, slot };
});

ipcMain.handle('unsnap-external', async (event, { windowNumber }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const info = ws.snappedExternals.get(windowNumber);
  if (!info) return { ok: false };
  ws.snappedExternals.delete(windowNumber);
  compactSlots(ws);
  // **unsnap は osascriptMove を直接呼ぶ** (v1.2.8)。
  // Terminal.app の AX set size は「大きな拡大を silent fail する」実装バグ
  // があり、daemon 経由だと snap 時のサイズから戻らない。osascript (System
  // Events) 経由なら信頼できる。snap は daemon で高速 (縮小方向は問題無し)、
  // unsnap だけ ~400ms かかるが頻度が低いので許容。
  await osascriptMove([{ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
    x: info.origX, y: info.origY, width: info.origW, height: info.origH }]);
  await retileAll(ws);
  // Same reason as snap: restore TiN to the top after external move.
  await raiseAllWorkspaceWindows(ws, true);
  scheduleSyncSnapped();
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
});

ipcMain.on('rename-workspace', (event, { name }) => {
  const ws = findWorkspace(event.sender);
  if (ws) ws.name = name;
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
function createWorkspace(name) {
  const wsId = nextWsId++;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const ww = 300, wh = 650;
  const offset = (wsId - 1) * 30;

  const win = new BrowserWindow({
    width: ww, height: wh,
    minWidth: 200, maxWidth: 500, minHeight: 300,
    x: 50 + offset,
    y: Math.round((sh - wh) / 2) + offset,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    alwaysOnTop: false,
    acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });

  const wsName = name || `Workspace ${wsId}`;
  const ws = {
    id: wsId, win, name: wsName,
    snappedExternals: new Map(),
    gridWindows: new Map(),    // slot -> { win, pty, ptyId }
    sidebarPtys: new Map(),    // ptyId -> pty (for sidebar embedded terms)
    gridOverlay: null,
    pollTimer: null,
    moveThrottle: null,
    overlayThrottle: null,
    gridCols: 2, gridRows: 2, // default 2x2
    gridWidth: 800, // tracked separately — overlay getBounds is unreliable
  };
  workspaces.set(wsId, ws);


  // ── Grid overlay (semi-transparent resizable area) ──
  function createGridOverlay() {
    const wb = win.getBounds();
    const overlayX = wb.x + wb.width + 12;
    const overlayY = wb.y;
    const overlay = new BrowserWindow({
      x: overlayX,
      y: overlayY,
      width: 800,
      height: wb.height,
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
    overlay.setBounds({ x: overlayX, y: overlayY, width: 800, height: wb.height });
    // Click-through by default — only handles are interactive
    overlay.setIgnoreMouseEvents(true, { forward: true });
    ws.gridOverlay = overlay;

    const scheduleOverlayRetile = () => {
      if (ws.overlayThrottle) return;
      ws.overlayThrottle = setTimeout(async () => {
        ws.overlayThrottle = null;
        await retileAll(ws);
      }, 16);
    };
    overlay.on('resize', scheduleOverlayRetile);
    overlay.on('move', scheduleOverlayRetile);
    overlay.on('closed', () => { ws.gridOverlay = null; });
  }

  // Create overlay after workspace is shown
  win.once('show', () => setTimeout(createGridOverlay, 100));

  win.loadFile('workspace.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('workspace-info', { id: wsId, name: wsName });
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // Move grid items + overlay when sidebar moves/resizes
  // Sync overlay immediately (visual), but debounce retile (expensive)
  const syncOverlay = () => {
    if (ws.gridOverlay && !ws.gridOverlay.isDestroyed() && ws.win && !ws.win.isDestroyed()) {
      const sb = ws.win.getBounds();
      ws.gridOverlay.setBounds({ x: sb.x + sb.width + 12, y: sb.y, width: ws.gridWidth, height: sb.height });
    }
  };
  const scheduleRetile = () => {
    syncOverlay();
    // Debounce retile — only fire after drag stops (300ms)
    if (ws.moveThrottle) clearTimeout(ws.moveThrottle);
    ws.moveThrottle = setTimeout(async () => {
      ws.moveThrottle = null;
      syncOverlay();
      await retileAll(ws);
    }, 300);
  };
  win.on('move', scheduleRetile);
  win.on('resize', scheduleRetile);

  // Title cache: windowNumber -> title
  // パッケージ版では daemon binary が Screen Recording 権限を持たないため
  // CGWindowList がタイトルを空で返す。osascript fallback は高コスト
  // (~200ms × アプリ数) なので、**既知の windowNumber はキャッシュヒット**させ
  // 新規 windowNumber 出現時だけ再フェッチする。
  ws._titleCache = new Map();
  ws._titleCacheRefreshAt = 0;
  // Poll external windows
  ws.pollTimer = setInterval(async () => {
    if (!ws.win || ws.win.isDestroyed()) return;
    const windows = await listWindows();
    // Title fallback for packaged app: キャッシュヒットを先に適用
    if (windows.length > 0) {
      for (const w of windows) {
        if (!w.title && ws._titleCache.has(w.windowNumber)) {
          w.title = ws._titleCache.get(w.windowNumber);
        }
      }
      // キャッシュに存在しない未知 windowNumber がある場合のみ osascript で補完。
      // 権限があって CGWindowList がタイトルを返している時は w.title が既に
      // 埋まっているので hasUnknown=false となり osascript は呼ばれない。
      // 新規ウィンドウが出現した時は hasUnknown=true となる。
      // 連続する poll で暴発しないよう 5 秒のレート制限をかける。
      const hasUnknown = windows.some(w => !w.title && !ws._titleCache.has(w.windowNumber));
      const now = Date.now();
      const shouldRefresh = hasUnknown && now - ws._titleCacheRefreshAt > 5000;
      if (shouldRefresh) {
        ws._titleCacheRefreshAt = now;
        // 非同期で実行 — pollTimer ハンドラをブロックしない。
        // 結果は次の poll 周期でキャッシュヒットする。
        for (const appName of [...new Set(windows.map(w => w.app))]) {
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
      // 古いエントリを消す (現存 windowNumber に含まれないものは遅延削除)
      if (ws._titleCache.size > 256) {
        const liveNums = new Set(windows.map(w => w.windowNumber));
        for (const k of ws._titleCache.keys()) {
          if (!liveNums.has(k)) ws._titleCache.delete(k);
        }
      }
    }
    const liveMap = new Map(windows.map(w => [w.windowNumber, w]));
    // Collect snapped externals that are missing from the on-screen list.
    // These MIGHT be truly gone, or they might be off-screen on a disconnected
    // display — use AX verify to distinguish.
    const missingList = [];
    for (const [k, info] of ws.snappedExternals) {
      if (!liveMap.has(k)) missingList.push({ key: k, info });
    }
    let axAlive = new Set();
    if (missingList.length > 0) {
      const verifyCmds = missingList.map(({ key, info }) => ({
        windowNumber: key, pid: info.pid, app: info.app, title: info.title,
      }));
      const vr = await verifyWindows(verifyCmds);
      if (vr && Array.isArray(vr.alive)) axAlive = new Set(vr.alive);
    }
    for (const [k, info] of ws.snappedExternals) {
      const live = liveMap.get(k);
      if (!live) {
        // Missing from on-screen list. If AX says it's still alive (e.g. on a
        // disconnected display) or we're stabilizing after a system event,
        // keep it and reset the counter. Otherwise apply the grace period.
        if (axAlive.has(k) || isStabilizing()) {
          info._missCount = 0;
          continue;
        }
        info._missCount = (info._missCount || 0) + 1;
        if (info._missCount >= 8) {  // ~6.4s at 800ms poll interval
          ws.snappedExternals.delete(k);
        }
        continue;
      }
      info._missCount = 0;  // reset on sight
      // Keep title fresh for AppleScript set index
      info.title = live.title;
      info.pid = live.pid;
    }
    const snappedByOther = {};
    for (const [, otherWs] of workspaces) {
      if (otherWs.id === ws.id) continue;
      for (const [wn] of otherWs.snappedExternals) snappedByOther[wn] = otherWs.name;
    }
    // Include grid window info
    const gridSlots = {};
    for (const [slot, gw] of ws.gridWindows) gridSlots[slot] = { ptyId: gw.ptyId };
    ws.win.webContents.send('external-windows', windows, snappedByOther, gridSlots);
  }, 800);

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
    // Release externals
    const cmds = [];
    for (const [, info] of ws.snappedExternals) {
      cmds.push({ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
        x: info.origX, y: info.origY, width: info.origW, height: info.origH });
    }
    if (cmds.length) await batchMove(cmds);
    ws.snappedExternals.clear();
    // Kill sidebar PTYs
    for (const [, p] of ws.sidebarPtys) { try { p.kill(); } catch {} }
    ws.sidebarPtys.clear();
    ws.win = null;
    workspaces.delete(wsId);
  });

  return ws;
}

// ── RAISE: on workspace focus + explicit button ──
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
    // activeWorkspaceId が変わった可能性 → snapped.json 更新
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
      ws.gridWidth = width; // track for getGridArea
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
          try { await retileAll(ws); } catch {}
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
      { role: 'front' },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWorkspace();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (daemon) { try { daemon.kill(); } catch {} daemon = null; }
  // 統合ステートファイルのクリーンアップ (クライアントが "TiN 未起動" と判定できるように)
  try { if (fs.existsSync(INFO_JSON)) fs.unlinkSync(INFO_JSON); } catch {}
  try { if (fs.existsSync(SNAPPED_JSON)) fs.unlinkSync(SNAPPED_JSON); } catch {}
});

app.on('window-all-closed', () => app.quit());
