const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Embedded terminal APIs
  createTerminal: (opts) => ipcRenderer.invoke('create-terminal', opts),
  killTerminal: (id) => ipcRenderer.invoke('kill-terminal', { id }),
  sendInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),
  onData: (cb) => ipcRenderer.on('terminal-data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('terminal-exit', (_e, payload) => cb(payload)),

  // External window APIs
  listExternalWindows: () => ipcRenderer.invoke('list-external-windows'),
  snapExternal: (info) => ipcRenderer.invoke('snap-external', info),
  unsnapExternal: (info) => ipcRenderer.invoke('unsnap-external', info),
  moveExternal: (info) => ipcRenderer.invoke('move-external', info),
  hideExternal: (info) => ipcRenderer.invoke('hide-external', info),
  raiseExternal: (info) => ipcRenderer.invoke('raise-external', info),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  onExternalWindowsUpdate: (cb) => ipcRenderer.on('external-windows-update', (_e, windows) => cb(windows)),
});
