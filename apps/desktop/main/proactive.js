'use strict';
/**
 * Moments — when a companion decides to speak first.
 *
 * patterns.js watches for repeated work worth automating; curiosity.js asks
 * questions to know its owner. This third watcher is about TIMING: it watches
 * for the moments when saying something is natural rather than intrusive —
 * you just sat back down, you have been deep in one topic for half an hour,
 * or simply enough interesting activity has piled up — and only then asks the
 * gateway whether there is anything actually worth saying. The model's bar
 * ("would a thoughtful friend interrupt?") lives in the suggest meta-prompt;
 * the gates here decide whether to even ask.
 *
 * Like its siblings, every gate fails toward silence, and everything is
 * injected so node can test the clockwork without Electron or a model.
 */
const { fingerprint } = require('./patterns');
const intelligence = require('../../../packages/intelligence');

const DEFAULTS = {
  tickMs: 30 * 1000,                 // the idle poll and moment clock
  awayMinMs: 8 * 60 * 1000,          // gone this long = "away"
  backActiveMs: 60 * 1000,           // idle under this = "back"
  readingWindowMs: 45 * 60 * 1000,   // the trail considered for deep reading
  readingSpanMs: 18 * 60 * 1000,     // sustained this long...
  readingMinPages: 3,                // ...across at least this many pages...
  readingShare: 0.6,                 // ...mostly in one place
  checkInMs: 30 * 60 * 1000,         // how often a routine look is even possible
  checkInChance: 0.4,                // and how often it actually happens then
  warmupMs: 10 * 60 * 1000,          // never in a session's first minutes
  cooldownMs: 45 * 60 * 1000,        // between ANY two suggestions
  maxPerDay: 5,
  momentCooldownMs: {                // per-moment, on top of the global one
    'welcome-back': 2 * 60 * 60 * 1000,
    'deep-reading': 3 * 60 * 60 * 1000,
    'check-in': 60 * 60 * 1000,
  },
  maxRemembered: 40,                 // topics kept for dedup
};

const SETTING_KEY = 'proactive';
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function loadState(memory) {
  try {
    const raw = memory.getSetting(SETTING_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      lastAt: Number(s.lastAt) || 0,
      day: String(s.day || ''),
      today: Number(s.today) || 0,
      moments: s.moments && typeof s.moments === 'object' ? s.moments : {},
      topics: Array.isArray(s.topics) ? s.topics : [],
    };
  } catch {
    return { lastAt: 0, day: '', today: 0, moments: {}, topics: [] };
  }
}

function saveState(memory, s) {
  try { memory.setSetting(SETTING_KEY, JSON.stringify(s)); } catch { /* not fatal */ }
}

function createProactiveWatcher({
  memory,
  gateway,
  state,
  idleSeconds = () => 0,             // powerMonitor in the app, a knob in tests
  getBrowser = () => null,
  soulFor = () => '',
  profileFor = () => null,
  onSuggestion = null,
  canSpeak = () => true,
  log = console.log,
  random = Math.random,
  now = () => Date.now(),
  options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...options, momentCooldownMs: { ...DEFAULTS.momentCooldownMs, ...(options.momentCooldownMs || {}) } };
  let timer = null;
  let thinking = false;
  const startedAt = now();

  // The away/back edge. `awaySince` is when the idle stretch began, which is
  // now minus how long the machine says it has been idle.
  let wasAway = false;
  let awayStartedAt = 0;

  // The reading trail: one entry per PAGE_OPENED, oldest dropped past the
  // window. Nothing but domain, kind and time — the content stays in the
  // sensor and is fetched fresh if a moment actually fires.
  let trail = [];

  function gate(moment) {
    const t = now();
    const s = loadState(memory);
    if (!state.get().observing) return 'not watching';
    if (t - startedAt < opts.warmupMs) return 'still settling in';
    if (!canSpeak()) return 'busy talking';
    if (t - s.lastAt < opts.cooldownMs) return 'spoke recently';
    if (s.day === dayOf(t) && s.today >= opts.maxPerDay) return 'enough for today';
    const last = Number(s.moments[moment]) || 0;
    if (t - last < (opts.momentCooldownMs[moment] || 0)) return 'this moment came up recently';
    return null;
  }

  /** The reading trail, reduced: is there a sustained thread, and of what? */
  function readingNow() {
    const t = now();
    trail = trail.filter((e) => t - e.ts <= opts.readingWindowMs);
    if (trail.length < opts.readingMinPages) return null;
    const span = t - trail[0].ts;
    if (span < opts.readingSpanMs) return null;
    const tally = {};
    for (const e of trail) {
      const key = e.domain || e.kind || '?';
      tally[key] = (tally[key] || 0) + 1;
    }
    const [top, count] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (count / trail.length < opts.readingShare) return null;
    const kind = (trail.find((e) => e.domain === top) || trail[0]).kind || 'pages';
    return { domain: top, kind, pages: trail.length, minutes: span / 60000 };
  }

  /** A page event from the browser sensor. Cheap on purpose: called a lot. */
  function noteBrowser(ctx) {
    if (!ctx || !ctx.tab || !ctx.tab.domain || (ctx.page && ctx.page.excluded)) return;
    const kind = intelligence.classifyPage({
      url: ctx.tab.url, domain: ctx.tab.domain,
      contentType: (ctx.page || {}).contentType,
    });
    trail.push({ domain: ctx.tab.domain, kind, ts: now() });
    if (trail.length > 300) trail.shift();
  }

  /** Ask the gateway whether this moment holds anything worth saying. */
  async function consider(moment, extra = {}, force = false) {
    if (thinking) return null;
    const blocked = force ? null : gate(moment);
    if (blocked) { return null; }

    const t = now();
    thinking = true;
    state.beginWork();
    try {
      const found = await gateway.suggest({
        moment,
        memories: memory.getRecentMemories({ sinceMs: t - 5 * 60 * 60 * 1000 }),
        observations: memory.getRecentObservations({ limit: 40 })
          .map(({ ts, activeApp, windowTitle }) => ({ ts, activeApp, windowTitle })),
        browser: getBrowser(),
        profile: profileFor(),
        soul: soulFor(),
        ...extra,
      });
      if (!found || !found.worth || !found.message) return null;

      // The same topic worded differently is the usual way a repeat gets
      // through; the fingerprint catches it across restarts.
      const print = fingerprint(found.about || found.message);
      const s = loadState(memory);
      if (print && s.topics.some((p) => p === print)) {
        log('[proactive] dropped a repeat');
        return null;
      }
      const sameDay = s.day === dayOf(t);
      saveState(memory, {
        lastAt: t,
        day: dayOf(t),
        today: sameDay ? s.today + 1 : 1,
        moments: { ...s.moments, [moment]: t },
        topics: [...s.topics, print].filter(Boolean).slice(-opts.maxRemembered),
      });

      // PRIVACY: derived from observed activity — log that a moment spoke,
      // never what it said.
      log(`[proactive] ${moment}: something worth saying`);
      if (onSuggestion) onSuggestion({ message: found.message, moment });
      return found;
    } catch (err) {
      log(`[proactive] let it pass: ${err.message}`);
      return null;
    } finally {
      thinking = false;
      state.endWork();
    }
  }

  let lastCheckInAt = startedAt;

  /** One turn of the clock: the away edge, the reading trail, the check-in. */
  async function tick() {
    const t = now();
    const idleMs = idleSeconds() * 1000;

    // Away is an edge, not a level: fire once, on the way BACK.
    if (!wasAway && idleMs >= opts.awayMinMs) {
      wasAway = true;
      awayStartedAt = t - idleMs;
      trail = [];                       // the thread was broken by leaving
    } else if (wasAway && idleMs <= opts.backActiveMs) {
      const awayMinutes = (t - awayStartedAt) / 60000;
      wasAway = false;
      await consider('welcome-back', { awayMinutes });
      return;                           // one moment per tick is plenty
    }
    if (wasAway) return;                // nobody is here to talk to

    const reading = readingNow();
    if (reading) {
      const before = loadState(memory);
      await consider('deep-reading', { reading });
      // Whether or not it spoke, this thread has been considered — do not
      // reconsider the same trail every 30 seconds.
      if (loadState(memory).lastAt === before.lastAt) trail = [];
    }

    if (t - lastCheckInAt >= opts.checkInMs && idleMs < 2 * 60 * 1000) {
      lastCheckInAt = t;
      if (random() <= opts.checkInChance) await consider('check-in');
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, opts.tickMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    noteBrowser,
    tick,                // for tests: one turn of the clock, awaited
    consider,            // for tests and for a future "suggest me something"
  };
}

module.exports = { createProactiveWatcher, DEFAULTS, SETTING_KEY };
