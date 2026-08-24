// Single source of truth for app state. The privacy invariant (eyes open <=>
// observation running) is structural here: `mascot` is computed, and no
// non-sleeping look is possible unless `observing` is true.
const listeners = new Set();

const base = {
  observing: false,
  canSeeScreen: false,   // a vision-capable model is configured
  panelOpen: false,
  // Which side of the orb the panel grows from. Main decides it from the room
  // on screen; the renderer flips the stage to match.
  panelBelow: false,
  gatewayOk: false,
};

let busyCount = 0; // in-flight LLM work (chat, summarize)
let ideaUntil = 0; // transient "just understood something" flash
let ideaTimer = null;

function mascot() {
  if (!base.observing) return 'sleeping'; // eyes never open while paused
  if (busyCount > 0) return 'thinking';
  if (Date.now() < ideaUntil) return 'idea';
  return 'watching';
}

function get() {
  return { ...base, mascot: mascot() };
}

function emit() {
  const snapshot = get();
  for (const fn of listeners) fn(snapshot);
}

function set(patch) {
  Object.assign(base, patch);
  emit();
}

function beginWork() {
  busyCount += 1;
  emit();
}

function endWork() {
  busyCount = Math.max(0, busyCount - 1);
  emit();
}

function flashIdea(ms = 2500) {
  ideaUntil = Date.now() + ms;
  clearTimeout(ideaTimer);
  ideaTimer = setTimeout(emit, ms + 20); // re-emit so the flash visibly ends
  if (ideaTimer.unref) ideaTimer.unref();
  emit();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { get, set, subscribe, beginWork, endWork, flashIdea };
