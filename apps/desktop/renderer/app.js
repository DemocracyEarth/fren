'use strict';

// Inert stub so the page still renders in a plain browser for styling work.
if (!window.fren) {
  window.fren = {
    getState: async () => ({ observing: false, mascot: 'sleeping', panelOpen: false, gatewayOk: false }),
    toggleObservation: async () => {},
    chat: async () => 'stub reply — fren is not running inside Electron.',
    setPanelOpen: async () => {},
    quit: async () => {},
    onStateChanged: () => {},
  };
}

const els = {
  orb: document.getElementById('orb'),
  eyes: document.querySelector('.eyes'),
  panel: document.getElementById('panel'),
  statusText: document.getElementById('status-text'),
  gatewayDot: document.getElementById('gateway-dot'),
  toggle: document.getElementById('toggle-observe'),
  quit: document.getElementById('quit'),
  messages: document.getElementById('messages'),
  typing: document.getElementById('typing'),
  form: document.getElementById('input-row'),
  input: document.getElementById('chat-input'),
};

// Mascot state is owned by main; this is only the last snapshot we rendered.
let state = { observing: false, mascot: 'sleeping', panelOpen: false, gatewayOk: false };
let blinkTimer = null;
let awaitingReply = false;

function render(next) {
  state = next;
  document.body.dataset.state = state.mascot;
  els.panel.hidden = !state.panelOpen;
  els.statusText.textContent = state.observing ? 'watching' : 'sleeping';
  els.gatewayDot.classList.toggle('ok', state.gatewayOk);
  els.toggle.textContent = state.observing ? 'pause watching' : 'wake up';
  syncBlink();
}

// Natural blink: only while watching, at a randomized 3-7s cadence.
function syncBlink() {
  if (state.mascot === 'watching') {
    if (blinkTimer === null) scheduleNextBlink();
  } else {
    clearTimeout(blinkTimer);
    blinkTimer = null;
    els.eyes.classList.remove('blink');
  }
}

function scheduleNextBlink() {
  blinkTimer = setTimeout(() => {
    els.eyes.classList.add('blink');
    setTimeout(() => {
      els.eyes.classList.remove('blink');
      if (state.mascot === 'watching') {
        scheduleNextBlink();
      } else {
        blinkTimer = null;
      }
    }, 150);
  }, 3000 + Math.random() * 4000);
}

function scrollMessages() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addBubble(who, text) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + who;
  bubble.textContent = text;
  els.messages.insertBefore(bubble, els.typing); // #typing stays last
  scrollMessages();
}

function showTyping(on) {
  els.typing.hidden = !on;
  if (on) scrollMessages();
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || awaitingReply) return;
  els.input.value = '';
  addBubble('user', text);
  awaitingReply = true;
  showTyping(true);
  try {
    const reply = await window.fren.chat(text);
    const replyText = typeof reply === 'string' ? reply : (reply && reply.text) || '(no reply)';
    addBubble('fren', replyText);
  } catch (err) {
    addBubble('fren', 'something went wrong: ' + (err && err.message ? err.message : String(err)));
  } finally {
    awaitingReply = false;
    showTyping(false);
  }
}

els.orb.addEventListener('click', async () => {
  const nextOpen = !state.panelOpen;
  await window.fren.setPanelOpen(nextOpen); // main resizes the window first
  state.panelOpen = nextOpen;
  els.panel.hidden = !nextOpen;
  if (nextOpen) els.input.focus();
});

els.toggle.addEventListener('click', () => {
  window.fren.toggleObservation(); // main broadcasts the resulting state
});

els.quit.addEventListener('click', () => {
  window.fren.quit();
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

(async function init() {
  window.fren.onStateChanged(render); // subscribe before the first fetch
  render(await window.fren.getState());
})();
