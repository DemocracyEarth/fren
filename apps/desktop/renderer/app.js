'use strict';

// Design-time stub for previewing in a plain browser. The real app loads over
// file://, so this can never stand in for a broken preload — and it reports
// "not observing", because a privacy fallback must fail closed.
if (!window.fren && location.protocol !== 'file:') {
  window.fren = {
    getState: async () => ({ observing: false, mascot: 'sleeping', panelOpen: false, gatewayOk: false }),
    toggleObservation: async () => {},
    chat: async () => ({ reply: 'Running outside Electron, so this is a canned reply.' }),
    setPanelOpen: async () => {},
    quit: async () => {},
    dragStart: async () => {},
    dragEnd: async () => ({ moved: false }),
    onCursor: () => {},
    onStateChanged: () => {},
  };
}

const els = {
  orb: document.getElementById('orb'),
  panel: document.getElementById('panel'),
  gatewayDot: document.getElementById('gateway-dot'),
  toggle: document.getElementById('toggle-observe'),
  quit: document.getElementById('quit'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  typing: document.getElementById('typing'),
  form: document.getElementById('input-row'),
  input: document.getElementById('chat-input'),
  send: document.getElementById('send'),
};

const face = new window.FrenFace.Face(els.orb, { size: 108 });

// Mascot state is owned by main; this is only the last snapshot we rendered.
let state = { observing: false, mascot: 'sleeping', panelOpen: false, gatewayOk: false };
let awaitingReply = false;
let speaking = false;   // while speaking, the face is ours to drive

/** Main's coarse state -> the face's vocabulary. */
function emotionFor(s) {
  if (!s.observing) return 'private';
  if (s.mascot === 'thinking') return 'thinking';
  if (s.mascot === 'idea') return 'idea';
  return 'watching';
}

/**
 * Every face change goes through here. If main says we are not observing, the
 * character looks it — no matter what the conversation is doing. (The mouth is
 * still free to move: fren can answer you without watching you.)
 */
function setFace(name, opts) {
  face.set(state.observing ? name : 'private', opts);
}

function render(next) {
  const was = state;
  state = next;
  els.panel.hidden = !state.panelOpen;
  els.gatewayDot.classList.toggle('ok', state.gatewayOk);
  els.gatewayDot.title = state.gatewayOk ? 'connected' : 'gateway unreachable';
  els.toggle.textContent = state.observing ? 'pause watching' : 'wake up';
  els.orb.setAttribute(
    'aria-label',
    `${state.panelOpen ? 'Close' : 'Open'} fren — ${state.observing ? 'watching' : 'not watching'}`
  );

  // Refresh whenever we own the face, and always when observation is off, so
  // pausing mid-reply closes the eyes immediately.
  if (!speaking || !state.observing) setFace(emotionFor(state));

  // Waking up is worth a little physical reaction.
  if (state.observing && !was.observing) face.pulse('bounce');
  if (state.mascot === 'idea' && was.mascot !== 'idea') face.pulse('bounce');
}

function scrollDown() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addBubble(who, text) {
  if (els.empty) els.empty.remove(), (els.empty = null);
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + who;
  bubble.textContent = text;
  els.messages.insertBefore(bubble, els.typing);
  scrollDown();
  return bubble;
}

function showTyping(on) {
  els.typing.hidden = !on;
  if (on) scrollDown();
}

/** fren says it out loud: the mouth moves while the words arrive. */
function speak(text) {
  return new Promise((resolve) => {
    const bubble = addBubble('fren', '');
    speaking = true;
    setFace('talking');
    face.startTalking();

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      bubble.textContent = text;
      finish();
      return;
    }

    let i = 0;
    const step = () => {
      // A few characters per frame keeps long answers from dragging.
      i += Math.max(1, Math.round(text.length / 90));
      bubble.textContent = text.slice(0, i);
      scrollDown();
      if (i < text.length) return setTimeout(step, 26);
      finish();
    };
    setTimeout(step, 90);

    function finish() {
      bubble.textContent = text;
      face.stopTalking();
      // Settle through a smile rather than snapping back.
      setFace('happy');
      setTimeout(() => {
        speaking = false;
        setFace(emotionFor(state));
        resolve();
      }, 900);
    }
  });
}

async function sendMessage(text) {
  const question = (text ?? els.input.value).trim();
  if (!question || awaitingReply) return;
  els.input.value = '';
  addBubble('user', question);
  awaitingReply = true;
  els.send.disabled = true;
  showTyping(true);

  speaking = true;          // hold the face until we've answered
  setFace('listening');
  face.pulse('nod');
  // Only show "thinking" if the answer is actually slow to arrive — and drop
  // the timer the moment it does, or it fires over the talking face.
  const thinkingTimer = setTimeout(() => setFace('thinking'), 420);

  try {
    const res = await window.fren.chat(question);
    clearTimeout(thinkingTimer);
    const reply = typeof res === 'string' ? res : (res && res.reply) || '(no reply)';
    showTyping(false);
    await speak(reply);
  } catch (err) {
    clearTimeout(thinkingTimer);
    showTyping(false);
    speaking = false;
    setFace('oops');
    face.pulse('shake');
    addBubble('fren', 'Something went wrong: ' + (err && err.message ? err.message : String(err)));
    setTimeout(() => setFace(emotionFor(state)), 1600);
  } finally {
    awaitingReply = false;
    els.send.disabled = false;
    speaking = false;
  }
}

async function togglePanel() {
  const nextOpen = !state.panelOpen;
  face.pulse('bounce');
  await window.fren.setPanelOpen(nextOpen);   // main resizes the window first
  state.panelOpen = nextOpen;
  els.panel.hidden = !nextOpen;
  if (nextOpen) els.input.focus();
}

// Press and drag to carry fren anywhere on screen; press and release without
// moving to open the panel. Main owns the window position, so it also tells us
// whether this gesture was a drag or a click.
let pressing = false;
els.orb.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  pressing = true;
  window.fren.dragStart();
});
window.addEventListener('mouseup', async () => {
  if (!pressing) return;
  pressing = false;
  const { moved } = (await window.fren.dragEnd()) || {};
  if (!moved) togglePanel();     // a click, not a reposition
});

// Keyboard activation still opens the panel (detail 0 == not a mouse click).
els.orb.addEventListener('click', (e) => { if (e.detail === 0) togglePanel(); });

// The character notices the cursor.
els.orb.addEventListener('mouseenter', () => { if (!speaking && state.observing) setFace('curious'); });
els.orb.addEventListener('mouseleave', () => { if (!speaking) setFace(emotionFor(state)); });

els.toggle.addEventListener('click', () => window.fren.toggleObservation());
els.quit.addEventListener('click', () => window.fren.quit());

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => sendMessage(chip.textContent));
}

(async function init() {
  if (!window.fren) {
    // The preload bridge didn't load. Stay in the private pose and say so —
    // never imply we're watching when we can't even reach the main process.
    els.panel.hidden = false;
    addBubble('fren', "I can't reach my own controls (preload failed to load), so I'm staying paused. Restarting fren should fix it.");
    els.input.disabled = true;
    els.send.disabled = true;
    return;
  }
  // fren glances toward the pointer while it's watching, so it reads as
  // paying attention to what you're doing.
  window.fren.onCursor((point) => {
    if (!point || !state.observing || speaking) return face.lookAway();
    face.lookAt(point.x, point.y);
  });
  window.fren.onStateChanged(render);          // subscribe before the first fetch
  render(await window.fren.getState());
  setFace(emotionFor(state), { immediate: true });
})();
