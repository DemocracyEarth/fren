'use strict';

// Inert stub so the page still renders in a plain browser for design work.
if (!window.fren) {
  window.fren = {
    getState: async () => ({ observing: true, mascot: 'watching', panelOpen: false, gatewayOk: true }),
    toggleObservation: async () => {},
    chat: async () => ({ reply: 'Running outside Electron, so this is a canned reply.' }),
    setPanelOpen: async () => {},
    quit: async () => {},
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

const face = new window.FrenFace.Face(els.orb, { size: 120 });

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

function render(next) {
  const was = state;
  state = next;
  document.body.dataset.state = state.mascot;
  els.panel.hidden = !state.panelOpen;
  els.gatewayDot.classList.toggle('ok', state.gatewayOk);
  els.gatewayDot.title = state.gatewayOk ? 'connected' : 'gateway unreachable';
  els.toggle.textContent = state.observing ? 'pause watching' : 'wake up';

  if (!speaking) face.set(emotionFor(state));

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
    face.set('talking');
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
      face.set('happy');
      setTimeout(() => {
        speaking = false;
        face.set(emotionFor(state));
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
  face.set('listening');
  face.pulse('nod');
  setTimeout(() => { if (awaitingReply) face.set('thinking'); }, 420);

  try {
    const res = await window.fren.chat(question);
    const reply = typeof res === 'string' ? res : (res && res.reply) || '(no reply)';
    showTyping(false);
    await speak(reply);
  } catch (err) {
    showTyping(false);
    speaking = false;
    face.set('oops');
    face.pulse('shake');
    addBubble('fren', 'Something went wrong: ' + (err && err.message ? err.message : String(err)));
    setTimeout(() => face.set(emotionFor(state)), 1600);
  } finally {
    awaitingReply = false;
    els.send.disabled = false;
    speaking = false;
  }
}

els.orb.addEventListener('click', async () => {
  const nextOpen = !state.panelOpen;
  face.pulse('bounce');
  await window.fren.setPanelOpen(nextOpen);   // main resizes the window first
  state.panelOpen = nextOpen;
  els.panel.hidden = !nextOpen;
  if (nextOpen) els.input.focus();
});

// The character notices the cursor.
els.orb.addEventListener('mouseenter', () => { if (!speaking && state.observing) face.set('curious'); });
els.orb.addEventListener('mouseleave', () => { if (!speaking) face.set(emotionFor(state)); });

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
  window.fren.onStateChanged(render);          // subscribe before the first fetch
  render(await window.fren.getState());
  face.set(emotionFor(state), { immediate: true });
})();
