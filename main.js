const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const pty = require('node-pty');
const { spawn } = require('child_process');

const workspaces = new Map();
let nextWsId = 1;
let nextPtyId = 1;
const isDev = process.argv.includes('--dev');

// ── Daemon ──
const DAEMON_BIN = app.isPackaged ? path.join(process.resourcesPath, 'daemon') : path.join(__dirname, 'daemon');
let daemon = null;
let daemonReady = false;
const pendingReqs = new Map();
let nextReqId = 1;

// Prevent EPIPE crash
process.on('uncaughtException', (err) => {

  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return; // ignore pipe errors
});

function startDaemon() {
  daemon = spawn(DAEMON_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  daemon.stdin.on('error', () => {}); // swallow EPIPE on stdin
  let buf = '';
  daemon.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.ready) { daemonReady = true; continue; }
        const p = pendingReqs.get(msg.id);
        if (p) { clearTimeout(p.t); pendingReqs.delete(msg.id); p.r(msg.result); }
      } catch {}
    }
  });
  if (isDev) daemon.stderr.on('data', (d) => process.stderr.write('[d] ' + d));
  daemon.on('close', (code) => {
    daemonReady = false;
    // Resolve all pending requests so they don't hang
    for (const [id, p] of pendingReqs) { clearTimeout(p.t); p.r({}); }
    pendingReqs.clear();
    if (!app.isQuitting) setTimeout(startDaemon, 500);
  });
  daemon.on('error', () => { daemonReady = false; });
}

function daemonReq(cmd, extra) {
  return new Promise((r) => {
    const fallback = cmd === 'list' ? [] : {};
    if (!daemon || !daemonReady || !daemon.stdin?.writable) return r(fallback);
    const id = String(nextReqId++);
    const t = setTimeout(() => { pendingReqs.delete(id); r(fallback); }, 2000);
    pendingReqs.set(id, { r, t });
    try {
      const ok = daemon.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
      if (!ok) { pendingReqs.delete(id); clearTimeout(t); r(fallback); }
    } catch { pendingReqs.delete(id); clearTimeout(t); r(fallback); }
  });
}

const listWindows = () => daemonReq('list');
const batchMove = (w) => w.length ? daemonReq('move', { windows: w }) : Promise.resolve();
const raiseWindows = (w) => w.length ? daemonReq('raise', { windows: w }) : Promise.resolve();

// ── Helpers ──
function findWs(wc) { for (const [, ws] of workspaces) if (ws.win?.webContents === wc) return ws; return null; }
function findWsByWin(win) {
  for (const [, ws] of workspaces) {
    if (ws.win === win) return ws;
    for (const [, gw] of ws.gridWins) if (gw.win === win) return ws;
  }
  return null;
}
function isSnapped(wn) { for (const [, ws] of workspaces) if (ws.ext.has(wn)) return ws; return null; }

// ── Grid geometry ──
function gridArea(ws) {
  if (!ws.win || ws.win.isDestroyed()) return null;
  const b = ws.win.getBounds();
  return { x: b.x + b.width + 4, y: b.y, w: 900, h: b.height };
}

function slotBounds(ws, slot) {
  const a = gridArea(ws);
  if (!a) return null;
  const { cols, rows } = ws.grid;
  const gap = 4;
  const cw = Math.floor((a.w - gap * (cols - 1)) / cols);
  const ch = Math.floor((a.h - gap * (rows - 1)) / rows);
  return { x: a.x + (slot % cols) * (cw + gap), y: a.y + Math.floor(slot / cols) * (ch + gap), width: cw, height: ch };
}

// ── Raise ──
let lastRaise = 0;
function raiseExternals(ws) {
  if (!ws || ws.ext.size === 0) return;
  const now = Date.now();
  if (now - lastRaise < 500) return;
  lastRaise = now;
  raiseWindows([...ws.ext.values()].map(i => ({ windowNumber: i.wn, pid: i.pid })));
}

// ── Retile with RAF-style throttle ──
async function retile(ws) {
  for (const [slot, gw] of ws.gridWins) {
    if (gw.win && !gw.win.isDestroyed()) { const b = slotBounds(ws, slot); if (b) gw.win.setBounds(b); }
  }
  const mv = [];
  for (const [, info] of ws.ext) { const b = slotBounds(ws, info.slot); if (b) mv.push({ windowNumber: info.wn, pid: info.pid, ...b }); }
  if (mv.length) await batchMove(mv);
}

function nextSlot(ws) {
  const used = new Set();
  for (const [s] of ws.gridWins) used.add(s);
  for (const [, i] of ws.ext) used.add(i.slot);
  const total = ws.grid.cols * ws.grid.rows;
  for (let i = 0; i < total; i++) if (!used.has(i)) return i;
  return -1;
}

function compactSlots(ws) {
  const all = [];
  for (const [s, gw] of ws.gridWins) all.push({ t: 'g', s, r: gw });
  for (const [, info] of ws.ext) all.push({ t: 'e', s: info.slot, r: info });
  all.sort((a, b) => a.s - b.s);
  for (let i = 0; i < all.length; i++) {
    if (all[i].t === 'g') { ws.gridWins.delete(all[i].s); all[i].r.slot = i; ws.gridWins.set(i, all[i].r); }
    else all[i].r.slot = i;
  }
}

// ── Grid terminal BrowserWindow ──
function createGridTerm(ws, slot) {
  const b = slotBounds(ws, slot);
  if (!b) return null;
  const gw = new BrowserWindow({
    ...b, frame: false, acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  const pid = nextPtyId++;
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: process.env.HOME || '/',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  p.onData(d => { if (!gw.isDestroyed()) gw.webContents.send('td', { id: pid, d }); });
  p.onExit(() => { if (!gw.isDestroyed()) gw.webContents.send('te', { id: pid }); });
  const obj = { win: gw, pty: p, pid, slot };
  ws.gridWins.set(slot, obj);
  gw.loadFile('grid-terminal.html');
  gw.webContents.on('did-finish-load', () => gw.webContents.send('init', { id: pid }));
  gw.on('closed', () => { try { p.kill(); } catch {} ws.gridWins.delete(slot); });
  return obj;
}

// ── IPC: grid terminal I/O ──
ipcMain.on('gi', (_, { id, d }) => { for (const [, ws] of workspaces) for (const [, gw] of ws.gridWins) if (gw.pid === id) { gw.pty.write(d); return; } });
ipcMain.on('gr', (_, { id, c, r }) => { for (const [, ws] of workspaces) for (const [, gw] of ws.gridWins) if (gw.pid === id) { try { gw.pty.resize(c, r); } catch {} return; } });

// ── IPC: sidebar terminal I/O ──
ipcMain.handle('create-terminal', (ev, opts = {}) => {
  const ws = findWs(ev.sender); if (!ws) return { id: -1 };
  const id = nextPtyId++;
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24,
    cwd: opts.cwd || process.env.HOME || '/', env: { ...process.env, TERM: 'xterm-256color' },
  });
  ws.sPtys.set(id, p);
  p.onData(d => { if (ws.win && !ws.win.isDestroyed()) ws.win.webContents.send('terminal-data', { id, data: d }); });
  p.onExit(() => { ws.sPtys.delete(id); if (ws.win && !ws.win.isDestroyed()) ws.win.webContents.send('terminal-exit', { id }); });
  return { id };
});
ipcMain.on('terminal-input', (ev, { id, data }) => { const ws = findWs(ev.sender); if (ws) { const p = ws.sPtys.get(id); if (p) p.write(data); } });
ipcMain.on('terminal-resize', (ev, { id, cols, rows }) => { const ws = findWs(ev.sender); if (ws) { const p = ws.sPtys.get(id); if (p) try { p.resize(cols, rows); } catch {} } });
ipcMain.handle('kill-terminal', (ev, { id }) => { const ws = findWs(ev.sender); if (ws) { const p = ws.sPtys.get(id); if (p) { try { p.kill(); } catch {} ws.sPtys.delete(id); } } });

// ── IPC: grid management ──
ipcMain.handle('add-grid-terminal', (ev) => {
  const ws = findWs(ev.sender); if (!ws) return { ok: false };
  const s = nextSlot(ws); if (s < 0) return { ok: false, reason: 'grid-full' };
  createGridTerm(ws, s); return { ok: true, slot: s };
});
ipcMain.handle('remove-grid-terminal', (ev, { slot }) => {
  const ws = findWs(ev.sender); if (!ws) return { ok: false };
  const gw = ws.gridWins.get(slot);
  if (gw?.win && !gw.win.isDestroyed()) gw.win.close();
  compactSlots(ws); retile(ws); return { ok: true };
});

// ── IPC: launch new external terminal window ──
ipcMain.handle('launch-terminal', async (ev, { app: appName }) => {
  const ws = findWs(ev.sender); if (!ws) return { ok: false };
  const { exec } = require('child_process');
  // Open a new terminal window via osascript
  const script = appName === 'iTerm2'
    ? `tell application "iTerm2" to create window with default profile`
    : `tell application "${appName}" to do script ""`;
  return new Promise((resolve) => {
    exec(`osascript -e '${script}'`, async (err) => {
      if (err) return resolve({ ok: false, error: err.message });
      // Wait for window to appear, then snap it
      await new Promise(r => setTimeout(r, 500));
      const windows = await listWindows();
      // Find the newest window from that app (highest windowNumber)
      const appWins = windows.filter(w => w.app === appName || (appName === 'Terminal' && w.app === 'ターミナル'));
      const snappedWns = new Set(ws.ext.keys());
      const newWin = appWins.filter(w => !snappedWns.has(w.windowNumber)).sort((a, b) => b.windowNumber - a.windowNumber)[0];
      if (!newWin) return resolve({ ok: false, error: 'window-not-found' });
      // Auto-snap
      const s = nextSlot(ws); if (s < 0) return resolve({ ok: false, reason: 'no-slot' });
      ws.ext.set(newWin.windowNumber, { app: newWin.app, pid: newWin.pid, title: newWin.title, wn: newWin.windowNumber, slot: s, ox: newWin.x, oy: newWin.y, ow: newWin.width, oh: newWin.height });
      ws._lastPollHash = '';
      const b = slotBounds(ws, s);
      if (b) await batchMove([{ windowNumber: newWin.windowNumber, pid: newWin.pid, ...b }]);
      resolve({ ok: true, slot: s });
    });
  });
});

// ── IPC: snap/unsnap ──
ipcMain.handle('snap-external', async (ev, { windowNumber, pid, app: a, title, x, y, width, height }) => {
  const ws = findWs(ev.sender); if (!ws) return { ok: false };
  const ex = isSnapped(windowNumber); if (ex && ex.id !== ws.id) return { ok: false, reason: 'snapped-elsewhere' };
  const s = nextSlot(ws); if (s < 0) return { ok: false, reason: 'no-slot' };
  ws.ext.set(windowNumber, { app: a, pid, title, wn: windowNumber, slot: s, ox: x, oy: y, ow: width, oh: height });
  ws._lastPollHash = ''; // force UI refresh
  const b = slotBounds(ws, s);
  if (b) await batchMove([{ windowNumber, pid, ...b }]);
  return { ok: true, slot: s };
});
ipcMain.handle('unsnap-external', async (ev, { windowNumber }) => {
  const ws = findWs(ev.sender); if (!ws) return { ok: false };
  const info = ws.ext.get(windowNumber); if (!info) return { ok: false };
  ws.ext.delete(windowNumber);
  ws._lastPollHash = ''; // force UI refresh
  compactSlots(ws);
  await batchMove([{ windowNumber: info.wn, pid: info.pid, x: info.ox, y: info.oy, width: info.ow, height: info.oh }]);
  await retile(ws);
  return { ok: true };
});

// ── IPC: config ──
ipcMain.handle('set-grid-size', (ev, { cols, rows }) => { const ws = findWs(ev.sender); if (ws) { ws.grid = { cols, rows }; retile(ws); } });
ipcMain.on('rename-workspace', (ev, { name }) => { const ws = findWs(ev.sender); if (ws) ws.name = name; });
ipcMain.on('toggle-collapse', (ev, { collapsed }) => {
  const ws = findWs(ev.sender); if (!ws?.win || ws.win.isDestroyed()) return;
  const b = ws.win.getBounds();
  if (collapsed) { ws._ew = b.width; ws.win.setMinimumSize(48, 300); ws.win.setBounds({ ...b, width: 48 }); }
  else { ws.win.setMinimumSize(200, 300); ws.win.setBounds({ ...b, width: ws._ew || 320 }); }
  setTimeout(() => retile(ws), 50);
});
ipcMain.on('raise-all', (ev) => { const ws = findWs(ev.sender); if (ws) raiseExternals(ws); });

// ── Workspace ──
function createWorkspace(name) {
  const wsId = nextWsId++;
  const { height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const off = (wsId - 1) * 30;

  const win = new BrowserWindow({
    width: 300, height: 650, minWidth: 200, maxWidth: 500, minHeight: 300,
    x: 50 + off, y: Math.round((sh - 650) / 2) + off,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 10 },
    vibrancy: 'sidebar', visualEffectState: 'active',
    alwaysOnTop: true, acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });

  const wsName = name || `Workspace ${wsId}`;
  const ws = {
    id: wsId, win, name: wsName,
    ext: new Map(),        // windowNumber -> { app, pid, title, wn, slot, ox, oy, ow, oh }
    gridWins: new Map(),   // slot -> { win, pty, pid, slot }
    sPtys: new Map(),      // ptyId -> pty
    pollTimer: null, _mt: null, _lastPollHash: '',
    grid: { cols: 2, rows: 2 },
  };
  workspaces.set(wsId, ws);

  win.loadFile('workspace.html');
  win.webContents.on('did-finish-load', () => {
    ws._lastPollHash = ''; // force re-send on page load
    win.webContents.send('workspace-info', { id: wsId, name: wsName });
  });
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Retile on move/resize — 16ms throttle
  const schedRetile = () => { if (ws._mt) return; ws._mt = setTimeout(async () => { ws._mt = null; await retile(ws); }, 16); };
  win.on('move', schedRetile);
  win.on('resize', schedRetile);

  // Adaptive polling with hash-based skip
  const poll = async () => {
    dbg('[poll] start, win:', !!ws.win, 'destroyed:', ws.win?.isDestroyed());
    if (!ws.win || ws.win.isDestroyed()) return;
    const windows = await listWindows();
    dbg('[poll] got', windows.length, 'windows, titles:', JSON.stringify(windows.slice(0,3).map(w=>({t:w.title, type: typeof w.title}))));

    // Fallback: if titles are empty (no Screen Recording / AX permission),
    // fetch via AppleScript using window id for exact matching
    // Fallback: fetch titles via osascript when daemon can't (no Screen Recording perm)
    if (windows.length > 0 && windows.every(w => !w.title)) {
      const { execSync } = require('child_process');
      const apps = [...new Set(windows.map(w => w.app))];
      for (const appName of apps) {
        try {
          const idRaw = execSync(`osascript -e 'tell application "${appName}" to get id of every window'`, { timeout: 2000, encoding: 'utf8' }).trim();
          const nameRaw = execSync(`osascript -e 'tell application "${appName}" to get name of every window'`, { timeout: 2000, encoding: 'utf8' }).trim();
          dbg('[poll] fallback for', appName, 'ids:', idRaw.substring(0, 40), 'names:', nameRaw.substring(0, 40));
          const ids = idRaw.split(', ').map(Number);
          const names = nameRaw.split(', ');
          const map = new Map();
          for (let i = 0; i < ids.length; i++) if (ids[i]) map.set(ids[i], names[i] || '');
          for (const w of windows) if (w.app === appName && map.has(w.windowNumber)) w.title = map.get(w.windowNumber);
        } catch (e) { dbg('[poll] fallback error:', appName, e.message?.substring(0, 80)); }
      }
    }
    dbg('[poll] after fallback, titles:', windows.slice(0,2).map(w=>w.title?.substring(0,25)||'STILL_EMPTY').join('|'));
    // Update ext info
    const liveMap = new Map(windows.map(w => [w.windowNumber, w]));
    for (const [k, info] of ws.ext) {
      const live = liveMap.get(k);
      if (!live) { ws.ext.delete(k); continue; }
      info.title = live.title;
      info.pid = live.pid;
    }
    // Build payload hash — skip send if unchanged
    const snappedOther = {};
    for (const [, ows] of workspaces) { if (ows.id === ws.id) continue; for (const [wn] of ows.ext) snappedOther[wn] = ows.name; }
    const gridSlots = {};
    for (const [s, gw] of ws.gridWins) gridSlots[s] = { ptyId: gw.pid };
    const hash = JSON.stringify([windows.map(w => w.windowNumber + ':' + w.title), snappedOther, gridSlots]);
    if (hash === ws._lastPollHash) return;
    ws._lastPollHash = hash;
    ws.win.webContents.send('external-windows', windows, snappedOther, gridSlots);
  };

  const setPoll = (ms) => { if (ws.pollTimer) clearInterval(ws.pollTimer); ws.pollTimer = setInterval(poll, ms); };
  setPoll(1000);
  win.on('focus', () => setPoll(1000));
  win.on('blur', () => setPoll(3000));

  win.on('closed', async () => {
    if (ws.pollTimer) clearInterval(ws.pollTimer);
    if (ws._mt) clearTimeout(ws._mt);
    for (const [, gw] of ws.gridWins) { try { gw.pty.kill(); } catch {} if (gw.win && !gw.win.isDestroyed()) gw.win.close(); }
    ws.gridWins.clear();
    const mv = [...ws.ext.values()].map(i => ({ windowNumber: i.wn, pid: i.pid, x: i.ox, y: i.oy, width: i.ow, height: i.oh }));
    if (mv.length) await batchMove(mv);
    ws.ext.clear();
    for (const [, p] of ws.sPtys) { try { p.kill(); } catch {} }
    ws.sPtys.clear();
    ws.win = null;
    workspaces.delete(wsId);
  });

  return ws;
}

// ── Raise on focus (no loop: no re-activate) ──
app.on('browser-window-focus', (_, win) => { const ws = findWsByWin(win); if (ws) raiseExternals(ws); });

// ── App ──
app.isQuitting = false;
app.whenReady().then(() => {
  startDaemon();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'New Workspace', accelerator: 'CmdOrCtrl+N', click: () => createWorkspace() },
      { type: 'separator' },
      { label: 'Close Workspace', accelerator: 'CmdOrCtrl+Shift+W', click: () => BrowserWindow.getFocusedWindow()?.close() },
    ]},
    { label: 'Shell', submenu: [
      { label: 'New Grid Terminal', accelerator: 'CmdOrCtrl+T', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('new-terminal') },
      { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('close-current') },
    ]},
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Toggle Compact', accelerator: 'CmdOrCtrl+B', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('toggle-compact') },
      { type: 'separator' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
    ]},
  ]));
  createWorkspace();
});
app.on('before-quit', () => { app.isQuitting = true; if (daemon) { try { daemon.kill(); } catch {} daemon = null; } });
app.on('window-all-closed', () => app.quit());
