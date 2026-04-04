const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const pty = require('node-pty');
const { spawn, exec } = require('child_process');

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
async function batchMove(cmds) {
  if (!cmds.length) return;
  const result = await daemonRequest('move', { windows: cmds });
  if (result.moved && result.moved >= cmds.length) return;
  // Fallback for packaged app (daemon AX permission may be denied)
  const { execSync } = require('child_process');
  for (const cmd of cmds) {
    if (!cmd.windowNumber || cmd.x == null || !cmd.app) continue;
    try {
      execSync(`osascript -e 'tell application "${cmd.app}" to set bounds of window id ${cmd.windowNumber} to {${cmd.x}, ${cmd.y}, ${cmd.x + cmd.width}, ${cmd.y + cmd.height}}'`, { timeout: 3000 });
    } catch {}
  }
}
function raiseSpecificWindows(cmds) { if (!cmds.length) return Promise.resolve(); return daemonRequest('raise', { windows: cmds }); }

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
function getGridArea(ws) {
  if (!ws.win || ws.win.isDestroyed()) return null;
  const b = ws.win.getBounds();
  // Use the display that contains the workspace window to calculate grid width
  const display = screen.getDisplayMatching(b);
  const workArea = display.workArea;
  const gridWidth = Math.min(workArea.x + workArea.width - (b.x + b.width + 4), workArea.width * 0.7);
  return { x: b.x + b.width + 4, y: b.y, width: Math.max(400, gridWidth), height: b.height };
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

// ── Raise snapped externals via osascript ──
let lastRaiseTime = 0;

function raiseSnappedExternals(ws) {
  if (!ws || ws.snappedExternals.size === 0) return;
  const now = Date.now();
  if (now - lastRaiseTime < 1000) return;
  lastRaiseTime = now;

  // Group snapped windows by app
  const byApp = new Map();
  for (const [, info] of ws.snappedExternals) {
    if (!byApp.has(info.app)) byApp.set(info.app, []);
    byApp.get(info.app).push(info);
  }

  // Activate each app, then set index by window id (not title, which changes)
  const scriptParts = [];
  for (const [appName, windows] of byApp) {
    const setIndexLines = windows.map((w, i) =>
      `      try\n        set index of window id ${w.windowNumber} to ${i + 1}\n      end try`
    ).join('\n');

    scriptParts.push(
      `tell application "${appName}"\n` +
      `  activate\n` +
      `  delay 0.15\n` +
      setIndexLines + '\n' +
      `end tell`
    );
  }

  const script = scriptParts.join('\n');
  exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

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
ipcMain.handle('snap-external', async (event, { windowNumber, pid, app: appName, title, x, y, width, height }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const existing = isExternalSnapped(windowNumber);
  if (existing && existing.id !== ws.id) return { ok: false, reason: 'snapped-elsewhere' };
  const slot = nextFreeSlot(ws);
  if (slot < 0) return { ok: false, reason: 'no-slot' };
  ws.snappedExternals.set(windowNumber, { app: appName, pid, title, windowNumber, slot, origX: x, origY: y, origW: width, origH: height });
  const pos = getSlotBounds(ws, slot);
  if (pos) await batchMove([{ windowNumber, pid, app: appName, title, ...pos }]);
  return { ok: true, slot };
});

ipcMain.handle('unsnap-external', async (event, { windowNumber }) => {
  const ws = findWorkspace(event.sender);
  if (!ws) return { ok: false };
  const info = ws.snappedExternals.get(windowNumber);
  if (!info) return { ok: false };
  ws.snappedExternals.delete(windowNumber);
  compactSlots(ws);
  await batchMove([{ windowNumber: info.windowNumber, pid: info.pid, app: info.app, title: info.title,
    x: info.origX, y: info.origY, width: info.origW, height: info.origH }]);
  await retileAll(ws);
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
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });

  const wsName = name || `Workspace ${wsId}`;
  const ws = {
    id: wsId, win, name: wsName,
    snappedExternals: new Map(),
    gridWindows: new Map(),    // slot -> { win, pty, ptyId }
    sidebarPtys: new Map(),    // ptyId -> pty (for sidebar embedded terms)
    pollTimer: null,
    moveThrottle: null,
    gridCols: 2, gridRows: 2, // default 2x2
  };
  workspaces.set(wsId, ws);

  win.loadFile('workspace.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('workspace-info', { id: wsId, name: wsName });
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // Move grid items when sidebar moves/resizes
  const scheduleRetile = () => {
    if (ws.moveThrottle) return;
    ws.moveThrottle = setTimeout(async () => {
      ws.moveThrottle = null;
      await retileAll(ws);
    }, 16);
  };
  win.on('move', scheduleRetile);
  win.on('resize', scheduleRetile);

  // Poll external windows
  ws.pollTimer = setInterval(async () => {
    if (!ws.win || ws.win.isDestroyed()) return;
    const windows = await listWindows();
    // Title fallback for packaged app
    if (windows.length > 0 && windows.every(w => !w.title)) {
      const { execSync } = require('child_process');
      for (const appName of [...new Set(windows.map(w => w.app))]) {
        try {
          const ids = execSync(`osascript -e 'tell application "${appName}" to get id of every window'`, { timeout: 2000, encoding: 'utf8' }).trim().split(', ').map(Number);
          const names = execSync(`osascript -e 'tell application "${appName}" to get name of every window'`, { timeout: 2000, encoding: 'utf8' }).trim().split(', ');
          const m = new Map(); for (let i = 0; i < ids.length; i++) if (ids[i]) m.set(ids[i], names[i] || '');
          for (const w of windows) if (w.app === appName && m.has(w.windowNumber)) w.title = m.get(w.windowNumber);
        } catch {}
      }
    }
    const liveMap = new Map(windows.map(w => [w.windowNumber, w]));
    for (const [k, info] of ws.snappedExternals) {
      const live = liveMap.get(k);
      if (!live) { ws.snappedExternals.delete(k); continue; }
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
    if (w.win === focusedWin) { ws = w; break; }
    for (const [, gw] of w.gridWindows) {
      if (gw.win === focusedWin) { ws = w; break; }
    }
    if (ws) break;
  }
  if (ws) raiseSnappedExternals(ws);
});

ipcMain.on('raise-all', (event) => {
  const ws = findWorkspace(event.sender);
  if (ws) raiseSnappedExternals(ws);
});

// ── App ──
app.isQuitting = false;

app.whenReady().then(() => {
  startDaemon();

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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWorkspace();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (daemon) { try { daemon.kill(); } catch {} daemon = null; }
});

app.on('window-all-closed', () => app.quit());
