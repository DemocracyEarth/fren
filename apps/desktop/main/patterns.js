'use strict';
/**
 * Noticing things.
 *
 * This is the point of fren. Everything else — the observing, the summarising,
 * the memory — exists to reach one moment: fren spots a workflow you never told
 * it about and says something useful about it.
 *
 * Which makes restraint the hard part, not detection. A companion that
 * volunteers something every ten minutes gets muted on day one, and a muted
 * companion has failed completely. So:
 *
 *   - it looks at hours of summaries, not minutes, because a "pattern" inside
 *     one sitting is just what you happen to be doing right now
 *   - it needs several distinct sightings before it will say anything
 *   - it never raises the same thing twice
 *   - it stays quiet entirely when the user said to (SOUL.md), and when the
 *     user is clearly mid-flow
 *
 * Nothing here talks to the network directly; it goes through the gateway like
 * everything else.
 */
const DEFAULTS = {
  intervalMs: 12 * 60 * 1000,      // how often to look at all
  lookbackMs: 8 * 60 * 60 * 1000,  // how far back a pattern may span
  minMemories: 8,                  // below this there is nothing to see
  minConfidence: 0.7,              // the model's own confidence in the pattern
  minOccurrences: 3,               // a thing done twice is a coincidence
  quietAfterSuggestionMs: 45 * 60 * 1000,
};

// Function words carry no identity and differ freely between two descriptions
// of the same behaviour — "copying fields INTO the sheet" and "copying fields
// FROM the panel" are one pattern, and a length filter alone keeps both.
const STOPWORDS = new Set([
  'into', 'from', 'with', 'that', 'this', 'then', 'they', 'them', 'their', 'there',
  'when', 'what', 'which', 'while', 'each', 'same', 'again', 'over', 'onto', 'your',
  'every', 'often', 'after', 'before', 'between', 'across', 'about', 'using', 'used',
  'keeps', 'keep', 'seems', 'appears', 'user', 'user\u2019s',
]);

/** Same pattern, said differently, is still the same pattern. */
function fingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    // Crude stemming, so "copying"/"copied" and "field"/"fields" agree.
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
    .filter((w) => w.length > 2)
    .sort()
    .slice(0, 12)
    .join(' ');
}

function createPatternWatcher({
  memory,
  gateway,
  state,
  soulFor = () => '',
  onSuggestion = null,
  log = console.log,
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  let timer = null;
  let looking = false;
  let lastSuggestionAt = 0;
  const seen = new Set();

  // Anything already proposed stays proposed: restarting fren is not a reason
  // to hear the same observation again.
  try {
    for (const s of memory.getSuggestions()) seen.add(fingerprint(s.pattern || s.message));
  } catch { /* first run, no table rows yet */ }

  async function look() {
    if (looking) return;
    if (!state.get().observing) return;         // not watching, nothing to notice
    if (Date.now() - lastSuggestionAt < opts.quietAfterSuggestionMs) return;

    const memories = memory.getRecentMemories({ sinceMs: Date.now() - opts.lookbackMs });
    if (memories.length < opts.minMemories) return;

    looking = true;
    state.beginWork();
    try {
      const found = await gateway.pattern({ memories });
      if (!found || !found.interrupt) return;
      if ((found.confidence ?? 0) < opts.minConfidence) return;
      if ((found.occurrences ?? 0) < opts.minOccurrences) return;
      if (!found.message) return;

      const print = fingerprint(found.pattern || found.message);
      if (!print || seen.has(print)) return;    // already said this
      seen.add(print);

      memory.addSuggestion({
        ts: Date.now(),
        message: found.message,
        pattern: found.pattern,
      });
      lastSuggestionAt = Date.now();
      // PRIVACY: the pattern text is derived from window titles. Log that one
      // was found, never what it was.
      log(`[patterns] noticed something (confidence ${found.confidence}, ${found.occurrences}x)`);
      if (onSuggestion) onSuggestion({ message: found.message, pattern: found.pattern });
    } catch (err) {
      log(`[patterns] look failed: ${err.message}`);
    } finally {
      looking = false;
      state.endWork();
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(look, opts.intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    look,                 // exported so a test does not have to wait 12 minutes
    _seen: seen,
  };
}

module.exports = { createPatternWatcher, fingerprint, DEFAULTS };
