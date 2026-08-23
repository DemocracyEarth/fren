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
    voiceStatus: async () => ({ stt: false, reason: 'not running in Electron' }),
    transcribe: async () => ({ error: 'not running in Electron' }),
    speak: async () => ({ error: 'not running in Electron' }),
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
  mic: document.getElementById('mic'),
  know: document.getElementById('know'),
  knowFiles: document.getElementById('know-files'),
  knowBtn: document.getElementById('what-i-know'),
  look: document.getElementById('look'),
  openFolder: document.getElementById('open-folder'),
};

const face = new window.FrenFace.Face(els.orb, { size: els.orb.clientWidth || 164 });
// fren's temperament: the same nudge shouldn't always get the same face.
const mood = window.FrenReactions.createReactions();
setInterval(() => mood.decay(5000), 5000);

const mic = window.FrenMic ? window.FrenMic.createMic() : null;
let voiceReady = false;      // whisper.cpp present and usable

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
let owned = 'private';   // what the renderer would show if observation were on

function setFace(name, opts) {
  owned = name;
  face.set(state.observing ? name : 'private', opts);
}

let reactionTimer = null;

/**
 * Play a spontaneous reaction, then drift back to whatever the app state
 * says. Reactions are picked from mood-weighted pools, so repeating the same
 * gesture gives a different face each time.
 */
function react(trigger) {
  if (speaking) return;
  if (!state.observing) {
    // Asleep: it stirs when you touch it, but the light stays off — motion is
    // honest here, an expression would not be.
    face.pulse(trigger === 'click' ? 'bounce' : 'squash');
    return;
  }
  const { emotion, hold } = mood.pick(trigger);
  setFace(emotion);
  clearTimeout(reactionTimer);
  reactionTimer = setTimeout(() => {
    reactionTimer = null;
    if (!speaking) setFace(emotionFor(state));
  }, hold);
}

function render(next) {
  const was = state;
  state = next;
  els.panel.hidden = !state.panelOpen;
  els.gatewayDot.classList.toggle('ok', state.gatewayOk);
  els.gatewayDot.title = state.gatewayOk ? 'connected' : 'gateway unreachable';
  els.toggle.textContent = state.observing ? 'pause watching' : 'wake up';
  // Offered only when a model that can see is configured, and only while the
  // light is on: looking at the screen while paused is precisely what the light
  // exists to rule out.
  if (els.look) els.look.hidden = !(state.canSeeScreen && state.observing);
  els.orb.setAttribute(
    'aria-label',
    `${state.panelOpen ? 'Close' : 'Open'} fren — ${state.observing ? 'watching' : 'not watching'}`
  );

  // Refresh whenever we own the face, and always when observation is off, so
  // pausing mid-reply closes the eyes immediately.
  if (!speaking || !state.observing) setFace(emotionFor(state));

  // Pausing fren during the interview ends it. Turning the light off is a
  // clear statement, and carrying on interviewing someone who just asked you to
  // stop watching them would be tone deaf.
  if (!state.observing && was.observing && setup) {
    endSetup({ skipped: true });
    addBubble('fren', "Understood — light off, questions dropped. Tap me when you want me back.");
  }

  // Waking up is worth a little physical reaction.
  if (state.observing && !was.observing) {
    // The line above deliberately does not touch the face mid-reply, so that a
    // arriving answer is not stomped. But that also means waking up during a
    // reply would leave fren dark while the observer is running, which breaks
    // the one invariant that is not negotiable. Re-apply what we already own:
    // it lights up without changing which expression is showing.
    if (speaking) setFace(owned);
    mood.note('wake');
    face.pulse('stretch');            // it uncurls as the light comes on
    setTimeout(() => face.pulse('bounce'), 180);
  }
  if (state.mascot === 'idea' && was.mascot !== 'idea') { mood.note('idea'); face.pulse('bounce'); }
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

/**
 * Play fren's reply and drive the mouth from the audio's own amplitude, so the
 * lips match the voice instead of miming. Resolves when playback ends, or
 * immediately with false if there is no voice configured.
 */
/** Set while audio is playing, so a reply can be cut short. */
let audioStop = null;

async function playVoice(audioBuffer) {
  const ctx = new AudioContext();
  let raf = 0;
  try {
    // A context created without a gesture can start suspended, in which case
    // nothing plays and 'ended' never arrives.
    if (ctx.state === 'suspended') await ctx.resume();
    const decoded = await ctx.decodeAudioData(audioBuffer.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(ctx.destination);

    const samples = new Uint8Array(analyser.frequencyBinCount);
    const pump = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) {
        const d = (v - 128) / 128;
        sum += d * d;
      }
      // RMS, lifted a little so quiet speech still moves the mouth.
      const rms = Math.sqrt(sum / samples.length);
      face.setSpeechLevel(Math.min(1, rms * 3.2));
      raf = requestAnimationFrame(pump);
    };

    // THIS is what killed the microphone. If 'ended' never fires -- a
    // suspended context, a device change, an audio stack hiccup -- this promise
    // stays pending forever. speak() then never resolves, sendMessage's
    // `finally` never runs, `awaitingReply` stays true, and startTalking()
    // returns early for the rest of the session. One missed event, and voice
    // input is dead until restart. So it cannot be allowed to wait forever.
    await new Promise((resolve) => {
      const done = () => { clearTimeout(guard); resolve(); };
      const guard = setTimeout(done, (decoded.duration + 2) * 1000);
      src.onended = done;
      // Interrupting stops the source, which fires 'ended' and settles this.
      audioStop = () => { try { src.stop(); } catch { done(); } };
      src.start();
      pump();
    });
    return true;
  } finally {
    audioStop = null;
    cancelAnimationFrame(raf);
    face.setSpeechLevel(null);
    ctx.close();
  }
}

/** Whether the last reply was actually audible, rather than only typed. */
let spokeAloud = false;

/**
 * Set while a reply is being delivered. Calling it cuts the reply short: the
 * text completes instantly and any audio stops. This is what makes it possible
 * to talk over fren instead of waiting for it to finish.
 */
let cutReplyShort = null;

/** fren says it out loud: the mouth moves while the words arrive. */
async function speak(text) {
  const bubble = addBubble('fren', '');
  speaking = true;
  setFace('talking');

  // Fetch the audio before typing so the words and the voice line up. If
  // there's no voice configured this just returns null and we type silently.
  let audio = null;
  try {
    const res = await window.fren.speak(text);
    if (res && res.audio) audio = res.audio;
  } catch { /* stay quiet rather than fail the reply */ }
  spokeAloud = !!audio;

  face.startTalking();
  const spoken = audio ? playVoice(audio).catch(() => false) : null;

  return new Promise((resolve) => {

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      bubble.textContent = text;
      finish();
      return;
    }

    let i = 0;
    let cut = false;
    cutReplyShort = () => {
      cut = true;
      if (audioStop) audioStop();
    };
    const step = () => {
      // A few characters per frame keeps long answers from dragging.
      if (cut) { bubble.textContent = text; return finish(); }
      i += Math.max(1, Math.round(text.length / 90));
      bubble.textContent = text.slice(0, i);
      scrollDown();
      if (i < text.length) return setTimeout(step, 26);
      finish();
    };
    setTimeout(step, 90);

    async function finish() {
      cutReplyShort = null;
      if (spoken) await spoken;     // let the voice finish before settling
      bubble.textContent = text;
      face.stopTalking();
      // Settle through a reaction rather than snapping back — and not the
      // same one every time.
      const { emotion, hold } = mood.pick('reply');
      speaking = false;
      setFace(emotion);
      clearTimeout(reactionTimer);
      reactionTimer = setTimeout(() => {
        reactionTimer = null;
        setFace(emotionFor(state));
      }, hold);
      setTimeout(resolve, 120);
    }
  });
}

/**
 * First run. fren introduces itself and asks a few things, because it is about
 * to spend all day watching someone it knows nothing about.
 *
 * It runs while fren is DARK, and says so. That is not a limitation to work
 * around — it is the most important thing to demonstrate at the very first
 * meeting: the light is off, so nothing is being recorded, and starting is the
 * user's decision to make rather than a default they have to discover and undo.
 */
const SETUP_STEPS = [
  {
    key: 'name',
    // "your fren" — the name is friend worn down, and it should introduce
    // itself as one rather than as a product.
    ask: () => "Hi. I'm your fren.\n\n" +
               "Not a typo — friend, worn down to the part that matters. " +
               "I live down here in the corner.\n\n" +
               "My light is on, which means I'm watching what you're doing. " +
               "Tap me whenever you want that to stop.\n\n" +
               "First though — hold me and tell me what to call you.",
  },
  {
    key: 'work',
    ask: (a) => `Good to meet you, ${a.name}. What are you working on at the moment?`,
  },
  // The next two are the ones that matter. They do not describe the user —
  // they define fren, and they are written into SOUL.md as instructions the
  // model is told to follow. This is the difference between a companion with a
  // personality chosen for you and one you chose.
  {
    key: 'tone',
    ask: () => "Now some things about me, so I don't have to guess.\n\n" +
               "How should I talk to you? Short and factual, warmer and more " +
               "conversational, dry — however you'd actually like it.",
    pulse: 'nod',
  },
  {
    key: 'initiative',
    ask: () => "And when I notice something — a pattern, something repeated — " +
               "should I say so straight away, or stay quiet until you ask?",
    pulse: 'squash',
  },
  {
    key: 'goals',
    ask: () => "Last one. What would genuinely be useful from me? I watch which " +
               "apps and windows you use, and look for things worth mentioning.",
  },
];

let setup = null;      // { step, answers } while the interview is running
let profile = null;    // what the user told fren about itself, once known

async function runSetupIfNeeded() {
  try { profile = await window.fren.getProfile(); } catch { /* first run */ }
  // `skipped` counts as answered: having declined once, being asked again on
  // every launch would be nagging.
  if (profile && (profile.name || profile.skipped)) return false;

  setup = { step: 0, answers: {} };
  // Voice first. The chat panel opens when the user asks for it and not
  // before — fren talks, and holding it is how you answer. The exception is
  // when there is no voice available at all, in which case typing is the only
  // way to reply and the panel has to be there.
  if (!voiceReady) await setPanel(true);
  await askSetupStep();
  return true;
}

async function askSetupStep() {
  const step = SETUP_STEPS[setup.step];
  showSkip(true);
  // Move before speaking. fren opens the conversation rather than sitting
  // inert waiting to be discovered, and a small physical beat before each
  // question reads as thinking rather than as a form advancing.
  face.pulse(step.pulse || 'bounce');
  await new Promise((r) => setTimeout(r, 260));
  await speak(step.ask(setup.answers));
  // Keeping the panel shut only works if fren can actually be HEARD. With no
  // voice configured, a closed panel and a silent orb is nothing at all — so
  // the first unheard question opens the panel and the interview is read
  // instead.
  if (setup && !spokeAloud && !state.panelOpen) await setPanel(true);
}

/**
 * An escape hatch, because an introduction that cannot be declined is an
 * interrogation. Without this, every message typed while setup was pending
 * would be swallowed as an answer -- ask fren a real question during setup and
 * it would be filed as your name.
 */
function showSkip(on) {
  let el = document.getElementById('skip-setup');
  if (!on) { if (el) el.remove(); return; }
  if (el) return;
  // Lives in the panel, so it is only visible to someone who opened it. The
  // other exits — saying "skip", or just pausing fren — do not need it.
  el = document.createElement('button');
  el.id = 'skip-setup';
  el.className = 'chip';
  el.textContent = 'skip this';
  el.addEventListener('click', () => endSetup({ skipped: true }));
  els.messages.insertBefore(el, els.typing);
  scrollDown();
}

/** Leave the interview, for whatever reason, and stop capturing input. */
async function endSetup(saved) {
  if (!setup) return;
  setup = null;
  showSkip(false);
  // Keep the live copy current: `initiative` decides whether fren volunteers
  // what it notices, and it has to be readable long after setup is over.
  profile = saved;
  try { await window.fren.setProfile(saved); } catch { /* not worth failing over */ }
}

async function finishSetup() {
  const answers = { ...setup.answers };

  // Decide once, here, whether fren may speak up — rather than guessing at the
  // sentence every time it notices something. The model reads it the way a
  // person would; a keyword test does not.
  let volunteer = false;
  if (answers.initiative) {
    try {
      const res = await window.fren.extractSetup({
        field: 'initiativeMode',
        question: 'Should fren raise things on its own, or wait to be asked?',
        answer: answers.initiative,
      });
      volunteer = /volunteer/i.test((res && res.value) || '');
    } catch { /* unclear means wait: see the rule */ }
  }

  const profile = { ...answers, volunteer, completedAt: Date.now() };
  await endSetup(profile);
  face.pulse('stretch');
  await speak(
    `Thanks, ${answers.name}. I've written that down as SOUL.md — it's how I'll ` +
    `try to be. You can open it and change it any time, and I'll read it fresh ` +
    `on the next thing you say.\n\n` +
    `Hold me to talk; you don't need this panel open. And I only watch while my ` +
    `light is on, so tap me when you're ready for me to start.`
  );
}

const SKIP_WORDS = /^(skip|no|nope|not now|later|pass|nothing|no thanks)\.?$/i;

async function handleSetupAnswer(answer) {
  // Saying "skip" out loud has to work, because with the panel closed the chip
  // is not on screen to be clicked.
  if (SKIP_WORDS.test(answer.trim())) {
    await endSetup({ skipped: true });
    await speak("Fine by me. Hold me any time you want to talk.");
    return;
  }

  const step = SETUP_STEPS[setup.step];
  // People do three different things when asked a question: answer it, ask one
  // back, or correct something you got wrong earlier. Treating all three as
  // answers is how "I said my name was Santi, not this entire sentence" ended
  // up recorded as someone's job.
  let out = { kind: 'answer', value: answer, corrects: '', reply: '' };
  try {
    const res = await window.fren.extractSetup({
      field: step.key,
      question: step.ask(setup.answers),
      answer,
      asked: setup.answers,
    });
    if (res) out = { ...out, ...res };
  } catch { /* keep the raw answer rather than lose it */ }

  if (out.kind === 'question') {
    // Answer them, then ask again. Pressing on with the script would be the
    // rudest possible response to someone taking an interest.
    if (out.reply) await speak(out.reply);
    return askSetupStep();
  }

  if (out.kind === 'correction' && out.corrects && out.corrects !== step.key) {
    // Fix what they actually meant, acknowledge it, and re-ask what is still
    // outstanding rather than counting the correction as this answer.
    setup.answers[out.corrects] = out.value;
    await speak(`Sorry — noted, ${out.corrects} is "${out.value}".`);
    return askSetupStep();
  }

  setup.answers[step.key] = out.value || answer;
  setup.step += 1;
  if (setup.step < SETUP_STEPS.length) return askSetupStep();
  return finishSetup();
}

/** Something said while fren was still busy. Answered next, never dropped. */
let queued = null;

async function sendMessage(text) {
  const question = (text ?? els.input.value).trim();
  if (!question) return;
  // Speaking again while a reply is in flight used to discard what was said
  // outright -- the transcription happened, the words went nowhere. Hold it
  // instead and answer it when the current one finishes.
  if (awaitingReply) {
    queued = question;
    els.input.value = '';
    addBubble('user', question);
    vlog('queued-while-busy');
    return;
  }
  addBubble('user', question);
  // During setup the answers are for fren, not for the model.
  if (setup) return handleSetupAnswer(question);
  awaitingReply = true;
  els.send.disabled = true;
  showTyping(true);

  mood.note('chat');
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
    // Belt and braces. The audio guard above should make speak() always
    // settle, but `awaitingReply` gates the microphone, so a bug anywhere in
    // the speaking path must not be able to disable voice input permanently.
    await Promise.race([
      speak(reply),
      new Promise((r) => setTimeout(r, 90_000)),
    ]);
  } catch (err) {
    clearTimeout(thinkingTimer);
    showTyping(false);
    speaking = false;
    mood.note('error');
    setFace('oops');
    face.pulse('shake');
    addBubble('fren', 'Something went wrong: ' + (err && err.message ? err.message : String(err)));
    setTimeout(() => setFace(emotionFor(state)), 1600);
  } finally {
    awaitingReply = false;
    els.send.disabled = false;
    speaking = false;
    vlog('reply:complete');
    if (queued) {
      const next = queued;
      queued = null;
      // Already shown as a bubble when it was queued.
      setTimeout(() => sendMessage(next), 0);
    }
  }
}

async function setPanel(open) {
  await window.fren.setPanelOpen(open);       // main resizes the window first
  state.panelOpen = open;
  els.panel.hidden = !open;
  if (open) els.input.focus();
}

/**
 * Say something that must not be missed. Voice can now be used with the panel
 * closed, so a bubble alone is invisible — anything the user needs to see has
 * to bring the panel with it.
 */
async function surface(text) {
  addBubble('fren', text);
  if (!state.panelOpen) await setPanel(true);
}

/**
 * Tapping the orb. Asleep, one tap wakes it. Awake, it toggles the chat panel.
 *
 * Waking deliberately does NOT open the panel any more: you can hold the orb
 * and talk to it without ever seeing a chat window, and forcing the transcript
 * into view made reading it feel compulsory rather than available.
 */
async function activateOrb() {
  face.pulse('bounce');
  if (!state.observing) {
    mood.note('wake');
    await window.fren.toggleObservation();    // main flips it and broadcasts
    return;
  }
  // If fren has been sitting on something, that is what a tap is for.
  if (await deliverPendingSuggestion()) return;
  react('click');
  await setPanel(!state.panelOpen);
}

// Kept for the keyboard path and anything else that just wants the panel.
async function togglePanel() {
  react('click');
  await setPanel(!state.panelOpen);
}

/**
 * The orb takes three gestures, and talking is the one that matters most.
 *
 *   tap        -> wake, or toggle the chat panel once awake
 *   hold       -> TALK. Speak while held, release to send.
 *   press+drag -> carry fren somewhere else on screen
 *
 * Holding the character itself to speak to it is the whole point: voice should
 * not require finding a small button inside a panel that has to be opened
 * first. The chat panel is for reading back what was said, and is optional.
 *
 * Main owns the window position, so it is also what tells us whether a gesture
 * turned out to be a drag.
 */
const HOLD_TO_TALK_MS = 320;
const DRAG_SLOP_PX = 11;     // above trackpad tremor: below this, holding still
                             // must not be mistaken for an intention to move

let pressing = false;
let holdTimer = null;
let talkingFromOrb = false;
let dragging = false;
let pressAt = { x: 0, y: 0 };

function cancelHold() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
}

/**
 * Three gestures share one button, so they have to be told apart by what the
 * hand actually does rather than by a stopwatch.
 *
 * The previous version began the drag on mousedown and, 320ms later, asked
 * whether the window had moved. That put the two gestures in direct conflict:
 * pressing and holding still is how you START a careful drag, and it is also
 * exactly how you begin talking — so a slow drag became a recording, while a
 * quick one meant the window chased the cursor for a third of a second before
 * anyone had expressed an intention.
 *
 * MOVEMENT is the signal. Move past a few pixels and it is a drag, whenever
 * that happens. Stay put for the hold and it is speech. The drag does not
 * begin at all until movement proves it, so holding still never moves the orb.
 */
els.orb.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  pressing = true;
  dragging = false;
  talkingFromOrb = false;
  pressAt = { x: e.screenX, y: e.screenY };
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (!pressing || dragging) return;
    talkingFromOrb = true;
    startTalking();
  }, HOLD_TO_TALK_MS);
});

window.addEventListener('mousemove', (e) => {
  if (!pressing || dragging || talkingFromOrb) return;
  if (Math.hypot(e.screenX - pressAt.x, e.screenY - pressAt.y) < DRAG_SLOP_PX) return;
  // Moving means carrying it. Main takes the cursor offset from here, so the
  // orb keeps its position under the pointer instead of jumping.
  dragging = true;
  cancelHold();
  window.fren.dragStart();
});

window.addEventListener('mouseup', async () => {
  if (!pressing) return;
  pressing = false;
  cancelHold();
  if (talkingFromOrb) {
    talkingFromOrb = false;
    stopTalkingAndSend();
    return;
  }
  if (dragging) {
    dragging = false;
    await window.fren.dragEnd();     // put it down where it was left
    return;
  }
  activateOrb();                     // a tap: nothing moved, nothing was said
});

// Keyboard activation still opens the panel (detail 0 == not a mouse click).
els.orb.addEventListener('click', (e) => { if (e.detail === 0) activateOrb(); });

// The character notices the cursor.
els.orb.addEventListener('mouseenter', () => react('hover'));
els.orb.addEventListener('mouseleave', () => {
  // Let the reaction finish on its own — snapping back mid-expression is what
  // made it feel mechanical.
  if (!speaking && !reactionTimer) setFace(emotionFor(state));
});

/**
 * Hold the mic to talk. Recording only happens while the button is down, the
 * audio is transcribed by whisper on this machine, and the transcript goes
 * through the same path as anything you type.
 */
let wantRecording = false;

/**
 * Voice tracing. This path has now failed twice in ways that could not be
 * reproduced in a harness, so it says what it is doing. Main forwards these to
 * its own stdout, which means the run log shows exactly where a hold-to-talk
 * attempt stopped. Never logs audio or transcripts — only state transitions.
 */
function vlog(step, extra) {
  const state = {
    wantRecording,
    awaitingReply,
    speaking,
    recording: !!(mic && mic.isRecording()),
    voiceReady,
  };
  console.log('[voice]', step, JSON.stringify(extra ? { ...state, ...extra } : state));
}

async function startTalking() {
  vlog('startTalking:enter');
  if (!mic || !voiceReady) {
    vlog('startTalking:BLOCKED', { reason: !mic ? 'no mic' : 'voice not ready' });
    return;
  }

  // THE BUG THIS FIXES. Delivering one reply -- transcribe, think, fetch the
  // voice, type it out, say it aloud -- takes nine to fifteen seconds, and for
  // all of it `awaitingReply` was set and startTalking() returned in silence.
  // Press the orb a second after answering and nothing whatsoever happened,
  // which is indistinguishable from a broken microphone. It is also just wrong:
  // you should be able to talk over something that is talking to you.
  if (cutReplyShort) {
    vlog('startTalking:interrupting');
    cutReplyShort();
    // Cutting it short lets sendMessage's `finally` run and clear the flag,
    // well before this recording could finish.
  } else if (awaitingReply) {
    // Still waiting on the model, so there is nothing to interrupt yet. Say so
    // with a movement rather than by doing nothing.
    vlog('startTalking:BUSY-thinking');
    face.pulse('shake');
    return;
  }
  wantRecording = true;
  try {
    await mic.start();
    vlog('startTalking:recording');
    // Opening the microphone is asynchronous, and the button can be released
    // before it finishes. Without this check the recorder would start with
    // nobody holding it and keep listening until the next press.
    if (!wantRecording) { mic.cancel(); setFace(emotionFor(state)); return; }
    els.mic.classList.add('recording');
    // The face IS the feedback when talking from the orb -- there may be no
    // panel open to show anything else.
    setFace('listening');
    face.pulse('nod');
  } catch (err) {
    els.mic.classList.remove('recording');
    surface('I could not open the microphone: ' + (err && err.message ? err.message : err));
    setFace(emotionFor(state));
  }
}

let stopping = false;

async function stopTalkingAndSend() {
  // Read it before clearing it, or the check below can never be true.
  const expected = wantRecording;
  wantRecording = false;
  // Two separate window-level mouseup handlers can both land here for one
  // gesture; a second entry must not stop a recorder the first is already
  // draining.
  if (stopping) return;
  if (!mic || !mic.isRecording()) {
    // Only worth reporting when a recording was expected. Otherwise this is an
    // ordinary release and the log fills up with it.
    if (expected) vlog('stop:nothing-recording');
    return;
  }
  stopping = true;
  els.mic.classList.remove('recording');
  setFace('thinking');
  let wav = null;
  try {
    wav = await mic.stop();
  } catch (err) {
    vlog('stop:FAILED', { err: String(err && err.message || err) });
    surface('That recording did not come through cleanly.');
    setFace(emotionFor(state));
    stopping = false;
    return;
  } finally {
    stopping = false;
  }
  if (!wav) { vlog('stop:too-short'); setFace(emotionFor(state)); return; }

  vlog('transcribe:start', { bytes: wav.length });
  const res = await window.fren.transcribe(wav);
  vlog('transcribe:done', { chars: (res && res.text || '').length, error: (res && res.error) || null });
  if (res && res.error) {
    surface('I could not transcribe that: ' + res.error);
    setFace(emotionFor(state));
    return;
  }
  const text = (res && res.text ? res.text : '').trim();
  if (!text) { setFace(emotionFor(state)); return; }
  sendMessage(text);
}

if (els.mic) {
  let holdingMic = false;
  els.mic.addEventListener('mousedown', (e) => {
    e.preventDefault();
    holdingMic = true;
    startTalking();
  });
  // Global, because the button can be released anywhere — but only while the
  // button was actually being held. Unguarded, this ran on EVERY mouse release
  // in the window, including every tap of the orb.
  window.addEventListener('mouseup', () => {
    if (!holdingMic) return;
    holdingMic = false;
    stopTalkingAndSend();
  });
  // Keyboard: hold Space on the focused mic button.
  els.mic.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startTalking(); }
  });
  els.mic.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stopTalkingAndSend(); }
  });
}

/**
 * Show the person what has been written about them.
 *
 * Verbatim, and as files rather than as a rendered summary. A companion that
 * has formed views about you which you cannot inspect is not a companion, and
 * paraphrasing its own notes back would defeat the point of keeping them in
 * Markdown in the first place.
 */
async function showWhatIKnow() {
  let data = null;
  try {
    data = await window.fren.readSoul();
  } catch (err) {
    els.knowFiles.textContent = '';
    const p = document.createElement('p');
    p.className = 'know-why';
    p.textContent = 'I could not read my own files: ' + (err && err.message ? err.message : err);
    els.knowFiles.appendChild(p);
    return;
  }
  els.knowFiles.textContent = '';

  for (const f of data.files) {
    const box = document.createElement('div');
    box.className = 'know-file';
    const h = document.createElement('h3');
    h.textContent = f.name;
    const why = document.createElement('p');
    why.className = 'know-why';
    why.textContent = f.title;
    const pre = document.createElement('pre');
    if (f.text.trim()) {
      pre.textContent = f.text;
    } else {
      pre.textContent = 'Nothing written yet.';
      pre.className = 'empty';
    }
    box.append(h, why, pre);
    els.knowFiles.appendChild(box);
  }

  // The daily logs are listed rather than dumped: there can be a lot of them,
  // and they are the one thing here fren wrote by itself.
  const days = document.createElement('div');
  days.className = 'know-file';
  const dh = document.createElement('h3');
  dh.textContent = 'memory/';
  const dw = document.createElement('p');
  dw.className = 'know-why';
  dw.textContent = data.logs.length
    ? `What fren observed, one file per day — ${data.logs.length} so far`
    : 'What fren observes, once it has watched for a while';
  days.append(dh, dw);

  const list = document.createElement('div');
  list.id = 'know-days';
  for (const log of data.logs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${log.name}  ·  ${Math.max(1, Math.round(log.bytes / 1024))} KB`;
    b.addEventListener('click', async () => {
      const text = await window.fren.readLog(log.name);
      const pre = document.createElement('pre');
      pre.textContent = text || 'Empty.';
      b.replaceWith(pre);
    });
    list.appendChild(b);
  }
  days.appendChild(list);
  els.knowFiles.appendChild(days);
}

async function toggleWhatIKnow() {
  const showing = !els.know.hidden;
  if (showing) {
    els.know.hidden = true;
    els.messages.hidden = false;
    els.knowBtn.innerHTML = '&#9776;';
    els.knowBtn.title = 'What fren has written about you';
    return;
  }
  await showWhatIKnow();
  els.know.hidden = false;
  els.messages.hidden = true;
  els.knowBtn.innerHTML = '&#8592;';
  els.knowBtn.title = 'Back to the conversation';
}

if (els.knowBtn) els.knowBtn.addEventListener('click', toggleWhatIKnow);
if (els.openFolder) {
  els.openFolder.addEventListener('click', async () => {
    const r = await window.fren.openDataFolder();
    if (r && !r.ok) surface('I could not open the folder: ' + r.error);
  });
}

/**
 * Look at the screen — once, because this button was pressed.
 *
 * There is no setting to leave on. Every capture is its own deliberate act,
 * which is a stronger guarantee than a toggle someone enabled last month and
 * has since forgotten about. The button only exists at all when a model that
 * can see is configured.
 *
 * fren's ORDINARY knowledge still comes from app names and window titles, and
 * observed screenshots still never leave the machine. This is a separate,
 * narrower thing, and it says so when it does it.
 */
async function lookAtScreen() {
  if (awaitingReply) return;
  const question = els.input.value.trim() || 'What am I looking at?';
  els.input.value = '';
  addBubble('user', question);
  // Say plainly that a screenshot is being sent, every time. Doing this
  // quietly would be the wrong habit for this product to have.
  const note = addBubble('fren', 'Taking one look at your screen…');
  awaitingReply = true;
  els.send.disabled = true;
  els.look.disabled = true;
  speaking = true;
  setFace('focused');

  try {
    const res = await window.fren.lookAtScreen(question);
    note.remove();
    speaking = false;
    if (res && res.error) {
      surface("I couldn't look: " + res.error);
      setFace(emotionFor(state));
      return;
    }
    await speak((res && res.reply) || '(nothing came back)');
  } catch (err) {
    note.remove();
    speaking = false;
    surface("I couldn't look: " + (err && err.message ? err.message : err));
    setFace(emotionFor(state));
  } finally {
    awaitingReply = false;
    els.send.disabled = false;
    els.look.disabled = false;
    speaking = false;
  }
}

if (els.look) els.look.addEventListener('click', lookAtScreen);

els.toggle.addEventListener('click', () => window.fren.toggleObservation());
els.quit.addEventListener('click', () => window.fren.quit());

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => sendMessage(chip.textContent));
}

/**
 * fren noticed something.
 *
 * Whether it says so out loud is the user's decision, taken during setup and
 * recorded in SOUL.md. Someone who said "only if I keep repeating something,
 * otherwise stay quiet" has asked not to be interrupted, and a companion that
 * ignores that answer made the question dishonest.
 *
 * The reserved behaviour is not silence, though — it lights up with an idea and
 * waits. Noticing is visible; interrupting is opt-in.
 */
function volunteersOutLoud() {
  // Decided by the model when the interview finished, because reading "you can
  // interrupt me" as permission is a language problem, not a keyword problem.
  // Anything unstated or undecidable stays reserved.
  return !!(profile && profile.volunteer);
}

let pendingSuggestion = null;

async function onSuggestion({ message }) {
  if (!message || speaking || awaitingReply) { pendingSuggestion = message; return; }
  pendingSuggestion = message;
  mood.note('idea');
  setFace('realization');
  face.pulse('bounce');

  if (volunteersOutLoud()) {
    pendingSuggestion = null;
    await speak(message);
    return;
  }
  // Reserved: hold the thought and look like it. Tapping fren, or asking it
  // anything, delivers it.
  els.orb.title = 'fren noticed something — tap to hear it';
}

/** Deliver whatever fren has been sitting on, if anything. */
async function deliverPendingSuggestion() {
  if (!pendingSuggestion || speaking || awaitingReply) return false;
  const message = pendingSuggestion;
  pendingSuggestion = null;
  els.orb.title = voiceReady
    ? 'Tap to wake · hold to talk · drag to move'
    : 'Tap to wake · drag to move';
  await speak(message);
  return true;
}

// Every so often, with nothing prompting it, fren has a passing thought.
function scheduleWander() {
  setTimeout(() => {
    if (!speaking && state.observing && !reactionTimer) react('idle');
    scheduleWander();
  }, 14000 + Math.random() * 26000);
}
scheduleWander();

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
  // Voice is optional: without whisper installed the mic button explains why.
  try {
    const v = await window.fren.voiceStatus();
    voiceReady = !!(v && v.stt);
    if (els.mic) {
      els.mic.disabled = !voiceReady;
      els.mic.title = voiceReady ? 'Hold to talk' : `Voice unavailable — ${v && v.reason}`;
    }
  } catch {
    if (els.mic) els.mic.disabled = true;
  }

  window.fren.onSuggestion(onSuggestion);
  window.fren.onStateChanged(render);          // subscribe before the first fetch
  render(await window.fren.getState());
  setFace(emotionFor(state), { immediate: true });

  els.orb.title = voiceReady
    ? 'Tap to wake · hold to talk · drag to move'
    : 'Tap to wake · drag to move';

  await runSetupIfNeeded();
})();
