// Dev-only bridge for dev/shoot.js, so the renderer can be captured in any
// state without running the real main process.
const { contextBridge } = require('electron');
const s = JSON.parse(process.env.FREN_SHOT_STATE || '{}');
const state = {
  observing: s.observing !== false,
  mascot: s.mascot || 'watching',
  panelOpen: s.panelOpen !== false,
  gatewayOk: s.gatewayOk !== false,
};
contextBridge.exposeInMainWorld('fren', {
  getState: async () => state,
  toggleObservation: async () => state,
  chat: async () => ({ reply: 'ok' }),
  setPanelOpen: async () => {},
  quit: async () => {},
  dragStart: async () => {},
  dragEnd: async () => ({ moved: false }),
  onCursor: () => {},
  voiceStatus: async () => ({ stt: false, reason: 'harness' }),
  transcribe: async () => ({ error: 'harness' }),
  speak: async () => ({ error: 'harness' }),
  onStateChanged: () => {},
});
