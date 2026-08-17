// Single source of truth for app state. The observer, summarizer, IPC handlers
// and renderer all read from here. The privacy invariant (eyes open <=> capture
// running) holds because `observing` is only ever changed together with the
// observer start/stop calls in index.js.
const listeners = new Set();

const state = {
  observing: false,
  mascot: 'sleeping', // 'sleeping' | 'watching' | 'thinking' | 'idea'
  panelOpen: false,
  gatewayOk: false,
};

function get() {
  return { ...state };
}

function set(patch) {
  Object.assign(state, patch);
  const snapshot = get();
  for (const fn of listeners) fn(snapshot);
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { get, set, subscribe };
