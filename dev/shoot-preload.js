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
  // Enough of the soul files to see the view rendered.
  getSuggestions: async () => ([
    { ts: Date.now() - 3600e3, pattern: 'export dashboard numbers into the weekly sheet',
      message: 'You have exported the dashboard numbers into the weekly sheet seven times this week, always the same three columns.' },
    { ts: Date.now() - 26 * 3600e3, pattern: 'generate the PDF report',
      message: 'The PDF report gets rebuilt by hand most mornings, right after you check the campaign metrics.' },
  ]),
  readSoul: async () => ({
    dir: '/Users/you/Library/Application Support/fren',
    files: [
      { name: 'SOUL.md', title: 'Who fren tries to be',
        text: '# SOUL\n\n## How to talk to Santi\n\n> warmer and conversational is fine.\n\n_Their words. Follow them._\n' },
      { name: 'USER.md', title: 'What you told it about yourself',
        text: '# USER\n\n**Name:** Santi\n\n**Working on:** building fren\n' },
      { name: 'MEMORY.md', title: 'Durable facts', text: '' },
    ],
    logs: [{ name: '2026-08-22.md', bytes: 2200 }],
  }),
  readLog: async () => '# 2026-08-22\n\n- **20:22** working in Claude, checking WhatsApp\n',
  openDataFolder: async () => ({ ok: true }),

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
