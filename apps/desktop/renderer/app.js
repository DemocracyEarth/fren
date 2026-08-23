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
  watch: document.getElementById('watch'),
  watchLabel: document.getElementById('watch-label'),
  watchSay: document.getElementById('watch-say'),
  dashDot: document.getElementById('dash-dot'),
  quit: document.getElementById('quit'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  typing: document.getElementById('typing'),
  form: document.getElementById('input-row'),
  input: document.getElementById('chat-input'),
  send: document.getElementById('send'),
  mic: document.getElementById('mic'),
  inputRow: document.getElementById('input-row'),
  look: document.getElementById('look'),
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

/**
 * What tapping the orb will do right now.
 *
 * "Tap to wake" was true when every launch started dark. It launches awake now,
 * so the same words would describe the opposite of what the tap does — and this
 * tooltip is the one place that says, in words, whether fren is watching.
 */
function orbVerb() {
  return state.observing ? 'Watching — tap to pause' : 'Asleep — tap to wake';
}

// The first state broadcast describes how fren STARTED, not something that
// just happened to it. Transitions are only transitions after that.
let firstRender = true;

function render(next) {
  const was = state;
  state = next;
  els.panel.hidden = !state.panelOpen;
  els.gatewayDot.classList.toggle('down', !state.gatewayOk);
  els.gatewayDot.title = state.gatewayOk ? 'connected' : 'gateway unreachable';
  // The most important fact in the window, in words. The orb says it too, but
  // the orb may be behind whatever you are working on.
  document.body.dataset.watching = state.observing ? '1' : '0';
  paintWatch();
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

  // Waking up is worth a little physical reaction — but only when it is
  // actually waking. Starting awake makes the FIRST broadcast a false->true
  // edge, so without this fren performs "you just woke me" on every launch and
  // the gesture stops meaning anything.
  if (state.observing && !was.observing && !firstRender) {
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
  firstRender = false;
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
  // Audio coming back is not the same as audio being heard. A muted machine
  // plays it perfectly and silently, so ask the system rather than assume.
  let audible = !!audio;
  if (audible) {
    try { audible = !(await window.fren.audioSilenced()); } catch { /* assume audible */ }
  }
  spokeAloud = audible;
  if (!audible && !state.panelOpen) {
    // Nothing will be heard, so the words have to be readable instead.
    await setPanel(true);
  }

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
    ask: () => "What would genuinely be useful from me? I watch which " +
               "apps and windows you use, and look for things worth mentioning.",
  },
  // Asked last, and asked plainly. By this point fren has been lit through the
  // whole introduction, so the question is about something already visible
  // rather than a permission buried in a checkbox nobody reads.
  {
    key: 'wake',
    ask: () => "Last one, about this light. I've had it on since we started, " +
               "which is me watching.\n\n" +
               "Should I wake up like this every time you launch me, or start " +
               "dark and wait until you tap me?",
    pulse: 'nod',
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

  // The same read-it-like-a-person treatment as `initiative`: "start dark" and
  // "wait until I tap you" are the same answer, and no keyword test gets that.
  let wakeOnLaunch = true;
  if (answers.wake) {
    try {
      const res = await window.fren.extractSetup({
        field: 'wakeMode',
        question: 'Should fren be awake and watching when it launches, or start dark until tapped?',
        answer: answers.wake,
      });
      const said = (res && res.value) || '';
      // Trust an answer we got; keep the default only when there was none. The
      // classifier already resolves its own ambiguity toward "dark".
      if (said) wakeOnLaunch = /awake/i.test(said);
    } catch { /* no answer at all keeps the default they were just shown */ }
  }
  try { await window.fren.setWakeOnLaunch(wakeOnLaunch); } catch { /* not worth failing over */ }
  if (!wakeOnLaunch && state.observing) {
    // Honour it immediately rather than at the next launch. Being told "start
    // dark" and staying lit for the rest of the session reads as not listening.
    try { await window.fren.toggleObservation(); } catch { /* the setting still holds */ }
  }

  const profile = { ...answers, volunteer, completedAt: Date.now() };
  await endSetup(profile);
  face.pulse('stretch');
  await speak(
    `Thanks, ${answers.name}. I've written that down as SOUL.md — it's how I'll ` +
    `try to be. You can open it and change it any time, and I'll read it fresh ` +
    `on the next thing you say.\n\n` +
    `Hold me to talk; you don't need this panel open. ` +
    (wakeOnLaunch
      ? `I'll be awake and watching whenever you launch me — tap me any time to stop.`
      : `I'll start dark from now on, so tap me when you want me watching.`)
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

/**
 * Does this even look like scheduling?
 *
 * A cheap gate before an expensive one. Classifying every message with the
 * model would add a call and a second of latency to every question asked, to
 * catch something people say rarely — so the model is only consulted when the
 * words suggest repetition at a time. Missing an unusual phrasing costs one
 * retry; taxing every message costs everything.
 */
const SCHEDULE_HINT =
  /\b(every|each|daily|weekly|remind me|routine|schedule)\b|\bevery ?day\b|\bmornings?\b|\bevenings?\b/i;

function looksScheduled(text) {
  return SCHEDULE_HINT.test(text) && /\b(at|every|each|daily|weekly|morning|evening|afternoon|remind)\b/i.test(text);
}

/** Ask main whether that was a routine; if it was, it has been created. */
async function tryRoutine(text) {
  let res = null;
  try { res = await window.fren.maybeRoutine(text); } catch { return false; }
  if (!res || !res.isRoutine || !res.routine) return false;

  const r = res.routine;
  await speak(
    `Done — I'll ask myself "${r.prompt}" ${describeWhen(r)}, and read the answer back.\n\n` +
    `You can see it under Routines in the full window, and turn it off there.`
  );
  return true;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "every weekday at 09:00", in words. */
function describeWhen(r) {
  const time = `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`;
  if (!r.days || !r.days.length) return `every day at ${time}`;
  const set = [...r.days].sort().join(',');
  if (set === '1,2,3,4,5') return `every weekday at ${time}`;
  if (set === '0,6') return `at weekends at ${time}`;
  if (r.days.length === 1) return `every ${DAY_NAMES[r.days[0]]} at ${time}`;
  return `on ${r.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')} at ${time}`;
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
  // If fren asked something, this is the answer — see if it taught anything.
  learnFrom(question);
  // "every weekday at nine, tell me what I did" is not a question to answer
  // once — it is a routine to set up.
  if (looksScheduled(question) && await tryRoutine(question)) return;
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
// Any of these means the session has started for real, and a greeting still in
// flight has missed its moment. Deliberately NOT mouseenter: moving the pointer
// across the orb is not the user doing something.
for (const [el, ev] of [[els.orb, 'mousedown'], [els.input, 'keydown'], [els.send, 'click'], [els.mic, 'pointerdown']]) {
  if (el) el.addEventListener(ev, () => { userActed = true; }, { once: true, capture: true });
}

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
/**
 * Scroll on fren to make it bigger or smaller.
 *
 * Scroll up and it grows and rolls toward you; scroll down and it shrinks and
 * rolls back. The size is remembered, so whatever you leave it at is what you
 * get next launch.
 *
 * Three things have to happen together or it does not read as one object:
 * the WINDOW resizes (the canvas cannot draw outside it), the CANVAS resizes,
 * and the sphere ROLLS. The roll is what turns a resize into a movement — the
 * same reason a ball getting closer also turns.
 *
 * Wheel events arrive far faster than a window can be resized, so the gesture
 * accumulates into a target and is drained one resize at a time. The draining
 * is clocked by the resize itself finishing, not by a frame callback: that
 * self-limits to exactly what the main process can absorb, and it keeps
 * working when the window is occluded — requestAnimationFrame does not run at
 * all on a hidden window, which would leave the size stuck wherever the last
 * visible frame left it.
 */
const ORB_BASE_PX = 123;        // #orb at scale 1, from styles.css
const ZOOM_PER_NOTCH = 0.0016;  // deltaY is in pixels, and varies wildly by device

let orbScale = 1;
let scaleMin = 0.65;
let scaleMax = 2;
let wantScale = null;           // set by the wheel, drained by pumpScale
let scaleBusy = false;          // a resize is in flight

function applyOrbScale(s) {
  document.documentElement.style.setProperty('--orb-scale', String(s));
  if (face && face.resize) face.resize(ORB_BASE_PX * s);
}

async function pumpScale() {
  if (scaleBusy || wantScale === null) return;
  scaleBusy = true;
  try {
    // Keep draining: more notches almost always arrive while a resize is in
    // flight, and stopping after one would make a long scroll feel like it
    // dropped most of the gesture.
    while (wantScale !== null) {
      const next = wantScale;
      wantScale = null;
      if (Math.abs(next - orbScale) < 0.001) continue;
      orbScale = next;
      applyOrbScale(orbScale);
      // Main owns the window and the saved value, and it clamps — so believe
      // what it reports back rather than what was asked for.
      try {
        const r = await window.fren.setOrbScale(orbScale);
        if (r) {
          scaleMin = r.min;
          scaleMax = r.max;
          if (Math.abs(r.scale - orbScale) > 0.001) { orbScale = r.scale; applyOrbScale(orbScale); }
        }
      } catch { /* the canvas already moved; the window will catch up */ }
    }
  } finally {
    scaleBusy = false;
  }
}

els.orb.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Exponential, so one notch feels the same at every size — a linear step
  // would crawl when small and leap when large.
  const next = Math.min(scaleMax, Math.max(scaleMin,
    orbScale * Math.exp(-e.deltaY * ZOOM_PER_NOTCH)));
  // At the stops the size cannot move, and a ball that keeps spinning against
  // a wall it is not passing looks broken rather than playful.
  if (Math.abs(next - orbScale) > 0.0005 && face && face.roll) {
    face.roll(-e.deltaY * 0.09);
  }
  wantScale = next;
  pumpScale();
}, { passive: false });

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
/**
 * Two short tones: rising when the microphone opens, falling when it closes.
 *
 * Synthesised rather than shipped as files — it is four lines of Web Audio, and
 * the project has no build step to bundle assets through. Quiet on purpose:
 * this is a confirmation, not an alert, and it will be heard many times a day.
 */
function blip(up) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(up ? 620 : 480, t);
    osc.frequency.exponentialRampToValueAtTime(up ? 880 : 340, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.15);
    osc.onended = () => { try { ctx.close(); } catch { /* already closed */ } };
  } catch { /* a missing tone is not worth failing a recording over */ }
}

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
    // The face brightens with the level, so it is visibly hearing YOU rather
    // than merely having changed state.
    await mic.start((level) => face.setListening(level));
    vlog('startTalking:recording');
    // Opening the microphone is asynchronous, and the button can be released
    // before it finishes. Without this check the recorder would start with
    // nobody holding it and keep listening until the next press.
    if (!wantRecording) { mic.cancel(); face.setListening(null); setFace(emotionFor(state)); return; }
    blip(true);
    els.mic.classList.add('recording');
    // The face IS the feedback when talking from the orb -- there may be no
    // panel open to show anything else.
    setFace('listening');
    face.pulse('nod');
  } catch (err) {
    els.mic.classList.remove('recording');
    face.setListening(null);
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
    face.setListening(null);
    // Only worth reporting when a recording was expected. Otherwise this is an
    // ordinary release and the log fills up with it.
    if (expected) vlog('stop:nothing-recording');
    return;
  }
  stopping = true;
  blip(false);
  face.setListening(null);
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
 * The one control that both states and changes whether fren is watching.
 *
 * At rest it reads as the state; under the pointer it reads as what clicking
 * will do. Two words for one control, but never both at once — which is what
 * made the old pair (a label saying "paused" beside a button saying "wake up")
 * something you had to stop and parse.
 */
/**
 * A dot on the dashboard button when something is waiting there.
 *
 * The Patterns tab used to carry a count, and removing it took away the only
 * way fren could say "I found something" without speaking. It goes here
 * instead, on the one door left to the place patterns now live — a dot rather
 * than a number, because the exact count is not the point at a glance and this
 * button is 26px wide.
 */
async function markUnread() {
  if (!els.dashDot) return;
  try {
    const list = await window.fren.getSuggestions();
    els.dashDot.hidden = !list.some((s) => s.status !== 'dismissed');
  } catch { /* leave it as it was */ }
}

function paintWatch() {
  if (!els.watch) return;
  const on = !!state.observing;
  // ALWAYS the state, never the action. An earlier version swapped this to the
  // verb on hover, which was wrong for a specific reason: Dashboard and quit
  // both sit to the right of this control, so every trip to either drags the
  // pointer across it — and a watching machine reading "pause" under a resting
  // cursor is exactly the misreading that merging the label and the button was
  // meant to end. It also broke Label in Name: the accessible name said
  // "Watching" while the visible word said "pause", so voice control matched
  // nothing. Hover now says the control is actionable; the tooltip says what
  // the action is.
  els.watchLabel.textContent = on ? 'watching' : 'paused';
  els.watch.setAttribute('aria-checked', on ? 'true' : 'false');
  els.watch.setAttribute('aria-label',
    on ? 'Watching your screen. Turn off to stop.' : 'Not watching. Turn on to start.');
  els.watch.title = on
    ? 'fren is watching — click to pause'
    : 'fren is paused — click to start watching';
  // Capture can start or stop without this button being pressed — from the orb,
  // or by main at launch. Unannounced, the one fact that matters most in this
  // window is the one a screen reader never hears.
  if (els.watchSay) {
    const said = on ? 'fren is now watching your screen' : 'fren has stopped watching';
    if (els.watchSay.textContent !== said) els.watchSay.textContent = said;
  }
}

// The panel is for talking; the dashboard is for reading back properly. With
// the tabs gone this is the only way through, so it is a real button rather
// than a link tucked in a corner.
const dashBtn = document.getElementById('open-dash');
if (dashBtn) {
  dashBtn.addEventListener('click', () => {
    window.fren.openDashboard();
    // Whatever was waiting is about to be on screen.
    if (els.dashDot) els.dashDot.hidden = true;
  });
}

els.watch.addEventListener('click', () => window.fren.toggleObservation());
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

/**
 * Hello.
 *
 * Deliberately not awaited by anything: a greeting that delays the first frame
 * has already cost more than it is worth. It arrives when it arrives, and if
 * anything else has started in the meantime it does not arrive at all — being
 * greeted over the top of something is worse than not being greeted.
 *
 * It does NOT go through speak(). speak() force-opens the panel when the words
 * will not be heard, which is correct for an answer you asked for and wrong
 * here: the panel is always closed at launch, so a muted machine or a failed
 * voice call would resize the window over whatever you were doing, every single
 * launch. A greeting is the one thing that must never take the screen.
 *
 * So the bubble is always written, the face always moves, and the words are
 * only spoken if there is something to hear them.
 */
const GREET_DEADLINE_MS = 10_000;

async function greetQuietly(text) {
  if (!text || setup || speaking || awaitingReply || userActed) return;
  // A hello that arrives after you have started working is not a hello.
  if (Date.now() - bootAt > GREET_DEADLINE_MS) return;

  addBubble('fren', text);         // read it whenever the panel is opened
  els.orb.title = text;            // and on hover in the meantime
  face.pulse('bounce');

  let audible = false;
  try { audible = !(await window.fren.audioSilenced()); } catch { /* assume not */ }
  // Checked BEFORE the call, not after: speaking into a muted machine spends a
  // paid voice request on nothing.
  if (!audible || userActed) return;

  try {
    const res = await window.fren.speak(text);
    if (res && res.audio) {
      face.startTalking();
      await playVoice(res.audio).catch(() => {});
      face.stopTalking();
    }
  } catch { /* a silent hello is still a hello */ }
}

// When this window came up, and whether the user has done anything since. A
// greeting is only welcome before either of those has moved on.
const bootAt = Date.now();
let userActed = false;

let pendingSuggestion = null;

/**
 * Curiosity, from fren's side.
 *
 * A suggestion is something fren wants to DO for you; a question is something
 * it wants to KNOW about you, and the two should not feel the same. This one
 * arrives with the curious face rather than the realization one.
 *
 * It does NOT force the panel open. speak() already opens it when nothing will
 * be heard — no voice configured, or a muted machine — which is exactly the
 * case where an unread question would be unanswerable. When fren can be heard,
 * the panel staying shut is the whole point of it being voice-first.
 *
 * Whatever is said next is treated as the answer. It usually is; when it is
 * not, the model weighing the answer says so and nothing is kept.
 */
let answeringQuestion = null;
let answerWindowTimer = null;
const ANSWER_WINDOW_MS = 8 * 60 * 1000;

async function onCurious({ question }) {
  // Never over a conversation in progress. There is no queue for this: a
  // question that has waited is a question about something you have already
  // moved on from, and stale curiosity reads worse than none.
  if (!question || speaking || awaitingReply || setup) return;

  mood.note('idea');
  setFace('curious');
  face.pulse('nod');

  answeringQuestion = question;
  clearTimeout(answerWindowTimer);
  // Anything said long enough afterwards is a new conversation, not an answer.
  answerWindowTimer = setTimeout(() => { answeringQuestion = null; }, ANSWER_WINDOW_MS);

  await speak(question);
}

/** Take what the answer taught, quietly and in the background. */
function learnFrom(answer) {
  if (!answeringQuestion) return;
  const asked = answeringQuestion;
  answeringQuestion = null;
  clearTimeout(answerWindowTimer);
  // Deliberately not awaited: the reply must not wait on fren's bookkeeping.
  window.fren.learn(asked, answer).catch(() => {});
}

async function onSuggestion({ message }) {
  // Show it on the tab regardless of whether it is spoken: noticing is
  // visible, interrupting is opt-in.
  markUnread();
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
    ? `${orbVerb()} · hold to talk · drag to move`
    : `${orbVerb()} · drag to move`;
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
  window.fren.onCurious(onCurious);
  // Restore the size fren was left at. Before the greeting, so it is already
  // the right size the first time it moves.
  try {
    const s = await window.fren.getOrbScale();
    if (s) {
      scaleMin = s.min;
      scaleMax = s.max;
      orbScale = s.scale;
      applyOrbScale(orbScale);
    }
  } catch { /* the default size is fine */ }

  window.fren.greeting()
    .then((g) => (g && g.text ? greetQuietly(g.text) : null))
    .catch(() => {});
  // A routine came round: say it the same way any other reply is said.
  window.fren.onRoutineRan(async ({ name, text }) => {
    if (!text || speaking || awaitingReply) return;
    addBubble('user', name);
    await speak(text);
  });
  window.fren.onStateChanged(render);          // subscribe before the first fetch
  render(await window.fren.getState());
  setFace(emotionFor(state), { immediate: true });

  els.orb.title = voiceReady
    ? `${orbVerb()} · hold to talk · drag to move`
    : `${orbVerb()} · drag to move`;

  markUnread();

  await runSetupIfNeeded();
})();
