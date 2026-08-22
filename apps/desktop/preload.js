const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fren', {
  getState: () => ipcRenderer.invoke('fren:getState'),
  toggleObservation: () => ipcRenderer.invoke('fren:toggleObservation'),
  chat: (text) => ipcRenderer.invoke('fren:chat', text),
  setPanelOpen: (open) => ipcRenderer.invoke('fren:setPanelOpen', open),
  quit: () => ipcRenderer.invoke('fren:quit'),
  getProfile: () => ipcRenderer.invoke('fren:getProfile'),
  setProfile: (p) => ipcRenderer.invoke('fren:setProfile', p),
  extractSetup: (p) => ipcRenderer.invoke('fren:extractSetup', p),
  dragStart: () => ipcRenderer.invoke('fren:dragStart'),
  dragEnd: () => ipcRenderer.invoke('fren:dragEnd'),
  onCursor: (cb) => ipcRenderer.on('fren:cursor', (_e, p) => cb(p)),
  voiceStatus: () => ipcRenderer.invoke('fren:voiceStatus'),
  transcribe: (bytes) => ipcRenderer.invoke('fren:transcribe', bytes),
  speak: (text) => ipcRenderer.invoke('fren:speak', text),
  onStateChanged: (cb) => ipcRenderer.on('fren:stateChanged', (_e, state) => cb(state)),
});
