const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fren', {
  getState: () => ipcRenderer.invoke('fren:getState'),
  toggleObservation: () => ipcRenderer.invoke('fren:toggleObservation'),
  chat: (text) => ipcRenderer.invoke('fren:chat', text),
  setPanelOpen: (open) => ipcRenderer.invoke('fren:setPanelOpen', open),
  quit: () => ipcRenderer.invoke('fren:quit'),
  dragStart: () => ipcRenderer.invoke('fren:dragStart'),
  dragEnd: () => ipcRenderer.invoke('fren:dragEnd'),
  onCursor: (cb) => ipcRenderer.on('fren:cursor', (_e, p) => cb(p)),
  onStateChanged: (cb) => ipcRenderer.on('fren:stateChanged', (_e, state) => cb(state)),
});
