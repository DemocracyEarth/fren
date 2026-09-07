'use strict';
/**
 * The thinking-out-loud stream — fren's thought bubbles.
 *
 * proactive.js decides the RARE moment worth interrupting for. This is the
 * opposite: the ordinary, constant sign of life. When the owner's activity
 * meaningfully changes — a new app, a new site — and no more often than a gentle
 * floor, it asks the model for one short first-person thought and hands it to
 * the UI as a thought bubble. There is no "worth it" gate: the whole point is
 * visible attention, so a plain thought is a fine thought. It runs ONLY while
 * the light is on, and it logs that it thought, never what it thought.
 *
 * Everything is injected, so the clockwork tests without Electron or a model.
 */
const DEFAULTS = {
  settleMs: 3500,          // let activity land before narrating about it
  minIntervalMs: 40 * 1000, // a floor between thoughts — presence, not chatter
  keep: 6,                 // recent thoughts kept, to seed 'previous' and dedup
};

function createNarrator({
  gateway,
  state,
  getBrowser = () => null,
  soulFor = () => '',
  onThought = null,
  log = console.log,
  now = () => Date.now(),
  options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...options };
  let latest = null;   // most recent activity signal
  let lastKey = '';    // the context we last narrated about
  let lastAt = 0;      // when we last emitted a thought
  let settleTimer = null;
  let busy = false;
  const recent = [];   // recent thought texts

  function contextKey(sig) {
    if (!sig) return '';
    // By URL, not domain, so moving around one site keeps producing thoughts
    // while a re-render of the same page does not.
    if (sig.kind === 'browser') return 'web:' + (sig.url || sig.domain || '?');
    // A selection is its own thing — a new highlight is worth a fresh thought
    // even on a page already narrated, but the same highlight is not.
    if (sig.kind === 'selection') return 'sel:' + (sig.url || sig.domain || '?') + '|' + String(sig.selection || '').slice(0, 32);
    if (sig.kind === 'app') return 'app:' + (sig.app || '?');
    return sig.kind || '';
  }

  function activityLine(sig) {
    if (!sig) return '';
    if (sig.kind === 'browser') {
      return `browsing ${sig.domain || 'the web'}${sig.pageTitle ? ` — "${sig.pageTitle}"` : ''}`;
    }
    if (sig.kind === 'selection') {
      return `reading ${sig.domain || 'a page'}${sig.pageTitle ? ` — "${sig.pageTitle}"` : ''}, and just highlighted some of the text`;
    }
    if (sig.kind === 'app') return `in ${sig.app || 'an app'}${sig.title ? ` — ${sig.title}` : ''}`;
    if (sig.kind === 'back') return 'just back at the computer';
    return '';
  }

  function arm(ms) {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { fire().catch(() => {}); }, Math.max(0, ms));
    if (settleTimer.unref) settleTimer.unref();
  }

  async function fire() {
    settleTimer = null;
    if (busy) return;
    if (!state.get().observing) return;          // light off: no thoughts, ever
    const sig = latest;
    if (!sig) return;
    const key = contextKey(sig);
    if (key && key === lastKey) return;          // nothing new to think about
    const wait = opts.minIntervalMs - (now() - lastAt);
    if (wait > 0) { arm(wait); return; }         // too soon — defer, keep the signal

    busy = true;
    try {
      const out = await gateway.narrate({
        activity: activityLine(sig),
        // The live page (and any selection) go to the model for browser and
        // selection thoughts, so the thought can be about the actual text.
        browser: (sig.kind === 'browser' || sig.kind === 'selection') ? getBrowser() : null,
        soul: soulFor(),
        previous: recent.slice(-4),
      });
      lastKey = key;
      lastAt = now();
      const text = String((out && out.thought) || '').trim();
      if (!text) return;
      recent.push(text);
      while (recent.length > opts.keep) recent.shift();
      log('[narrator] thought');                 // PRIVACY: never log the text
      if (onThought) onThought({ text, kind: sig.kind, at: lastAt });
    } catch (err) {
      log(`[narrator] no thought: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    /** An activity signal — {kind:'app',app,title} | {kind:'browser',domain,pageTitle} | {kind:'back'}. */
    note(sig) {
      if (!sig) return;
      latest = sig;
      if (!state.get().observing) return;
      if (contextKey(sig) === lastKey) return;   // same place — let it be
      arm(opts.settleMs);
    },
    stop() { if (settleTimer) clearTimeout(settleTimer); settleTimer = null; },
    recent: () => recent.slice(),
    fire,                // for tests: settle now, without the timer
  };
}

module.exports = { createNarrator, DEFAULTS };
