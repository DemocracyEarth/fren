'use strict';
/**
 * Being curious about someone.
 *
 * This is deliberately NOT patterns.js. That one looks for a repeated sequence
 * worth automating and speaks in order to be useful. This one asks a question
 * in order to know the person better, and the answer is the whole point: what
 * comes back gets written into MEMORY.md, so fren's picture of its owner grows
 * from conversation rather than from surveillance.
 *
 * The interview on first launch is the same idea at a single moment. This just
 * lets it continue, slowly, for as long as fren is around.
 *
 * The entire design problem is frequency. Something on your desktop that
 * interrupts to chat is the classic thing people turn off within a day, and a
 * companion that has been turned off knows nothing about anyone. So the bar is
 * set where a question is rare enough to be welcome:
 *
 *   - a long cooldown, and a hard ceiling per day
 *   - never while fren is already doing something, or mid-conversation
 *   - never twice about the same thing, across restarts
 *   - never at all if the user said during setup not to interrupt
 *   - a wide random jitter, so it is not a metronome
 *
 * Every one of those gates fails toward silence.
 */
const { fingerprint } = require('./patterns');

const DEFAULTS = {
  intervalMs: 9 * 60 * 1000,          // how often to consider it at all
  lookbackMs: 5 * 60 * 60 * 1000,     // a day's shape, not a moment's
  minMemories: 5,
  cooldownMs: 100 * 60 * 1000,        // at least this long between questions
  maxPerDay: 3,
  warmupMs: 25 * 60 * 1000,           // never in the first minutes of a session
  // The chance of even looking, per interval. Restraint you can feel: without
  // it, a question always arrives the moment the cooldown expires, and anything
  // that regular reads as a scheduler rather than as someone wondering.
  chance: 0.35,
  maxRemembered: 60,                  // topics kept for dedup
};

const SETTING_KEY = 'curiosity';
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * What has been asked already, kept in the settings table.
 *
 * On disk rather than in memory because restarting fren is not a reason to be
 * asked the same question again — and because "it asked me this yesterday" is
 * exactly the thing that makes something feel like a script.
 */
function loadState(memory) {
  try {
    const raw = memory.getSetting(SETTING_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      asked: Array.isArray(s.asked) ? s.asked : [],
      lastAskedAt: Number(s.lastAskedAt) || 0,
      day: String(s.day || ''),
      today: Number(s.today) || 0,
    };
  } catch {
    return { asked: [], lastAskedAt: 0, day: '', today: 0 };
  }
}

function saveState(memory, s) {
  try { memory.setSetting(SETTING_KEY, JSON.stringify(s)); } catch { /* not fatal */ }
}

function createCuriosityWatcher({
  memory,
  gateway,
  state,
  soulFor = () => '',
  profileFor = () => null,
  onQuestion = null,
  canAsk = () => true,
  log = console.log,
  random = Math.random,
  now = () => Date.now(),
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  let timer = null;
  let thinking = false;
  const startedAt = now();

  /** Did the user tell fren, during setup, that it may interrupt? */
  function invited() {
    const p = profileFor();
    // Absent means the interview never happened. Assume no: an uninvited
    // interruption from something you have not configured is the worst first
    // impression available.
    return !!(p && p.volunteer);
  }

  function why() {
    const t = now();
    const s = loadState(memory);
    if (t - startedAt < opts.warmupMs) return 'still settling in';
    if (!state.get().observing) return 'not watching';
    if (!invited()) return 'not invited to interrupt';
    if (!canAsk()) return 'busy talking';
    if (t - s.lastAskedAt < opts.cooldownMs) return 'asked recently';
    if (s.day === dayOf(t) && s.today >= opts.maxPerDay) return 'enough for today';
    return null;
  }

  async function consider(force = false) {
    if (thinking) return null;
    const blocked = force ? null : why();
    if (blocked) return null;
    if (!force && random() > opts.chance) return null;

    const t = now();
    const memories = memory.getRecentMemories({ sinceMs: t - opts.lookbackMs });
    if (memories.length < opts.minMemories) return null;

    thinking = true;
    state.beginWork();
    try {
      const s = loadState(memory);
      const found = await gateway.curious({
        memories,
        profile: profileFor(),
        soul: soulFor(),
        asked: s.asked.map((a) => a.about).filter(Boolean),
      });
      if (!found || !found.ask || !found.question) return null;

      // The model was told what it has already asked, but a fingerprint match
      // catches the same thing worded differently, which is the usual way a
      // repeat gets through.
      const print = fingerprint(found.about || found.question);
      if (print && s.asked.some((a) => a.print === print)) {
        log('[curiosity] dropped a repeat');
        return null;
      }

      const sameDay = s.day === dayOf(t);
      saveState(memory, {
        asked: [...s.asked, { print, about: found.about, ts: t }].slice(-opts.maxRemembered),
        lastAskedAt: t,
        day: dayOf(t),
        today: sameDay ? s.today + 1 : 1,
      });

      // PRIVACY: the question is derived from window titles. Record that one
      // was asked; never write what it was to the log.
      log('[curiosity] asking about something');
      if (onQuestion) onQuestion({ question: found.question, about: found.about });
      return found;
    } catch (err) {
      log(`[curiosity] gave up on this one: ${err.message}`);
      return null;
    } finally {
      thinking = false;
      state.endWork();
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { consider().catch(() => {}); }, opts.intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    consider,            // force=true skips the gates, for tests and for "ask me something"
    why,                 // why it is staying quiet, for the dashboard
  };
}

module.exports = { createCuriosityWatcher, DEFAULTS, SETTING_KEY };
