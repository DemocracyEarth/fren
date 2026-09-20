const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fren', {
  getState: () => ipcRenderer.invoke('fren:getState'),
  toggleObservation: () => ipcRenderer.invoke('fren:toggleObservation'),
  chat: (text) => ipcRenderer.invoke('fren:chat', text),
  setPanelOpen: (open) => ipcRenderer.invoke('fren:setPanelOpen', open),
  // Which corner the panel WOULD open into, without opening it.
  aimPanel: () => ipcRenderer.invoke('fren:aimPanel'),
  // The orb's tooltip — its own little window, never a resize of this one.
  setHint: (open, info) => ipcRenderer.invoke('fren:setHint', open, info),
  // Browser awareness: the first-run offer to set it up. Its switches and its
  // exclusions are changed by asking (ownBusiness below), never from here.
  openBrowserExtension: () => ipcRenderer.invoke('fren:openBrowserExtension'),
  onBrowserSetup: (cb) => ipcRenderer.on('fren:browserSetup', (_e, s) => cb(s)),
  onBrowserConnected: (cb) => ipcRenderer.on('fren:browserConnected', () => cb()),
  dismissBrowserSetup: () => ipcRenderer.invoke('fren:dismissBrowserSetup'),
  // A look tuned in an earlier version, still worn. Read only.
  getOrbLook: () => ipcRenderer.invoke('fren:getOrbLook'),
  quit: () => ipcRenderer.invoke('fren:quit'),
  getProfile: () => ipcRenderer.invoke('fren:getProfile'),
  setProfile: (p) => ipcRenderer.invoke('fren:setProfile', p),
  extractSetup: (p) => ipcRenderer.invoke('fren:extractSetup', p),
  openDataFolder: () => ipcRenderer.invoke('fren:openDataFolder'),
  lookAtScreen: (text) => ipcRenderer.invoke('fren:lookAtScreen', text),
  audioSilenced: () => ipcRenderer.invoke('fren:audioSilenced'),
  messages: () => ipcRenderer.invoke('fren:messages'),
  clearMessages: () => ipcRenderer.invoke('fren:clearMessages'),
  maybeRoutine: (t) => ipcRenderer.invoke('fren:maybeRoutine', t),
  setRoutineEnabled: (id, on) => ipcRenderer.invoke('fren:setRoutineEnabled', id, on),
  deleteRoutine: (id) => ipcRenderer.invoke('fren:deleteRoutine', id),
  onRoutineRan: (cb) => ipcRenderer.on('fren:routineRan', (_e, r) => cb(r)),
  onGreet: (cb) => ipcRenderer.on('fren:greet', (_e, g) => cb(g)),
  dismissSuggestion: (id) => ipcRenderer.invoke('fren:dismissSuggestion', id),
  dragStart: () => ipcRenderer.invoke('fren:dragStart'),
  dragEnd: () => ipcRenderer.invoke('fren:dragEnd'),
  onCursor: (cb) => ipcRenderer.on('fren:cursor', (_e, p) => cb(p)),
  voiceStatus: () => ipcRenderer.invoke('fren:voiceStatus'),
  transcribe: (bytes) => ipcRenderer.invoke('fren:transcribe', bytes),
  speak: (text) => ipcRenderer.invoke('fren:speak', text),
  onStateChanged: (cb) => ipcRenderer.on('fren:stateChanged', (_e, state) => cb(state)),
  onSuggestion: (cb) => ipcRenderer.on('fren:suggestion', (_e, s) => cb(s)),
  // A passing thought for the thought-bubble stream: {text, kind, at}.
  onNarration: (cb) => ipcRenderer.on('fren:narration', (_e, t) => cb(t)),
  // Conversation mode: the session ticket, and the agent's questions, answered
  // from fren's memory and senses in main. See docs/voice-agent.md.
  voice: {
    session: () => ipcRenderer.invoke('fren:voice.session'),
    lookAround: (focus) => ipcRenderer.invoke('fren:voice.lookAround', focus),
    recall: (question) => ipcRenderer.invoke('fren:voice.recall', question),
    remember: (note) => ipcRenderer.invoke('fren:voice.remember', note),
    said: (role, text) => ipcRenderer.invoke('fren:voice.said', role, text),
    // The global hotkey (main registers it): open the line, or close it.
    onToggle: (cb) => ipcRenderer.on('fren:voice.toggle', () => cb()),
    // The wake word was heard (main's on-device detector): open the line.
    onWake: (cb) => ipcRenderer.on('fren:voice.wake', () => cb()),
    // Whether a line is open — main stands the wake word down meanwhile.
    state: (open) => ipcRenderer.invoke('fren:voice.state', !!open),
    // What may truthfully be said about the wake word: { armed, phrase, alias,
    // paused, micBlocked, canConverse, hotkey }. Asked once, then pushed on change.
    wakeStatus: () => ipcRenderer.invoke('fren:voice.wakeStatus'),
    onWakeStatus: (cb) => ipcRenderer.on('fren:voice.wakeStatus', (_e, s) => cb(s)),
    // fren's one explanation of the wake word: the text the first time it is
    // asked for while true, null ever after.
    intro: () => ipcRenderer.invoke('fren:voice.intro'),
  },
  // How a held suggestion ended: 'heard' or 'faded'. Feeds the pace governor.
  suggestionOutcome: (kind) => ipcRenderer.invoke('fren:suggestionOutcome', kind),
  onCurious: (cb) => ipcRenderer.on('fren:curious', (_e, q) => cb(q)),
  learn: (question, answer) => ipcRenderer.invoke('fren:learn', question, answer),
  greeting: () => ipcRenderer.invoke('fren:greeting'),
  getOrbScale: () => ipcRenderer.invoke('fren:getOrbScale'),
  setOrbScale: (s) => ipcRenderer.invoke('fren:setOrbScale', s),
  // The models pane: its own small window, opened from the chat's header.
  openSettings: () => ipcRenderer.invoke('fren:openSettings'),
  getProviders: () => ipcRenderer.invoke('fren:getProviders'),
  setProviders: (p) => ipcRenderer.invoke('fren:setProviders', p),
  getOrbColour: () => ipcRenderer.invoke('fren:getOrbColour'),
  onOrbColour: (cb) => ipcRenderer.on('fren:orbColour', (_e, hex) => cb(hex)),
  setWakeOnLaunch: (on) => ipcRenderer.invoke('fren:setWakeOnLaunch', on),
  // The secure execution environment: ask fren through it. The answer arrives
  // as events, not as the return value.
  run: (text) => ipcRenderer.invoke('fren:run', text),
  // Everything Core reports, to every window: runs, messages, automations,
  // permission requests, the environment's state.
  onCoreEvent: (cb) => ipcRenderer.on('fren:coreEvent', (_e, ev) => cb(ev)),
  // Automations that run an agent in the secure execution environment: made
  // from a sentence, and paused, run or deleted from the cards fren shows.
  automationIntent: (text) => ipcRenderer.invoke('fren:automationIntent', text),
  createAgentAutomation: (spec) => ipcRenderer.invoke('fren:createAgentAutomation', spec),
  patchAgentAutomation: (id, patch) => ipcRenderer.invoke('fren:patchAgentAutomation', id, patch),
  deleteAgentAutomation: (id) => ipcRenderer.invoke('fren:deleteAgentAutomation', id),
  runAgentAutomation: (id) => ipcRenderer.invoke('fren:runAgentAutomation', id),
  // What an agent asked to be allowed to do, and the answer. An unanswered
  // request is a no.
  permissionRequests: (status) => ipcRenderer.invoke('fren:permissionRequests', status),
  decidePermission: (id, decision, opts) => ipcRenderer.invoke('fren:decidePermission', id, decision, opts),
  // fren's own business, already recognised from the owner's own words by the
  // chat window (renderer/own-business.js): do it, and say what happened.
  ownBusiness: (verb, args, heard) => ipcRenderer.invoke('fren:ownBusiness', verb, args, heard),
});
