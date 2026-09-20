'use strict';
/**
 * fren's own business, recognised from the owner's own words.
 *
 * "Stop watching", "what are you running", "don't read this site", "remember
 * that I take the 8:15 train" are not questions for a model. They are things
 * said TO fren ABOUT fren, and the honest way to handle them is to do them —
 * not to let a model say "done" about a setting it cannot reach.
 *
 * So this file reads the sentence, and only the sentence. It runs before either
 * model lane sees the message, on what the person typed or dictated and on
 * nothing else. That is the whole safety argument: a model that can emit
 * actions can be talked into them by anything it READS — a page title, an
 * agent's output, a window name — and none of that text ever comes through
 * here. When nothing matches, parse() returns null and the message goes to the
 * model exactly as it always did.
 *
 * Two rules keep it from eating ordinary conversation:
 *
 *   1. The WHOLE sentence has to be the request. Every pattern is anchored at
 *      both ends, so "what is this site about" and "read the page and summarise
 *      it" never look like "don't read this site".
 *   2. A verb and an object, never a bare noun. "colour", "launch", "forget"
 *      and "this site" on their own mean nothing here.
 *
 * A miss costs one model answer. A false match costs the person their answer
 * and may change a setting, so the patterns err toward missing. The tests in
 * test/own-business.test.js are the specification; extend them first.
 *
 * Shared by the chat window (which decides) and main (which resolves colour
 * names and matches notes), hence the wrapper.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrenOwnBusiness = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /** Address and politeness off the front: "hey fren, could you please …". */
  function lead(text) {
    let t = String(text || '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.!\u2026]+$/, '');
    for (let i = 0; i < 3; i++) {
      t = t
        .replace(/^(?:hey |ok(?:ay)?,? |so,? )?fren[,:]?\s+/i, '')
        .replace(/^(?:please|ok(?:ay)?|can you|could you|would you|will you|i want you to|i'd like you to|i need you to)[,]?\s+/i, '')
        .trim();
    }
    return t;
  }

  /** And off the back, so the patterns stay small: "… for now, thanks". */
  function normalise(text) {
    let t = lead(text);
    for (let i = 0; i < 3; i++) {
      t = t.replace(/[,]?\s+(?:please|for now|right now|now|thanks|thank you)$/i, '').trim();
    }
    return t;
  }

  const DOMAIN = '((?:[a-z0-9-]+\\.)+[a-z]{2,})';
  const SITE = '(?:this|that|the current) (?:site|page|website|domain|tab)';
  const NOUN = '(?:routine|automation|reminder)s?';
  const MANAGE = "(?:pause|unpause|stop|resume|restart|delete|cancel|remove|disable|enable|kill|turn off|turn on|switch off|switch on|get rid of)";

  /** People paste URLs; a domain is what the exclusion list holds. */
  function bareDomain(s) {
    return String(s || '').toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
  }

  const re = (src) => new RegExp(`^(?:${src})$`, 'i');

  // Ordered: the first match wins. Each entry is [pattern, (match) => deed].
  const RULES = [
    // ---- the light --------------------------------------------------------
    [re("(?:stop|quit|pause) (?:watching|looking|observing)(?: me| my screen| the screen| what i'm doing)?|pause(?: yourself)?|take a break from (?:watching|looking)|(?:don't|do not) (?:watch|look)(?: at)?(?: me| my screen)?|go dark|go to sleep|(?:turn|switch) (?:your |the )?light off|(?:turn|switch) off (?:your|the) light"),
      () => ({ verb: 'watch', args: { on: false } })],
    [re("(?:resume|start|begin) (?:watching|looking|observing)(?: me| my screen)?(?: again)?|(?:watch|look) again|(?:you can|you may|it's ok(?:ay)? to) (?:look|watch)(?: again)?|unpause|wake up|(?:turn|switch) (?:your |the )?light (?:back )?on|(?:turn|switch) on (?:your|the) light"),
      () => ({ verb: 'watch', args: { on: true } })],

    // ---- what is running, and every wish to change it ---------------------
    // Asking and managing open the same card. The sentence never pauses or
    // deletes anything: the chip on the card does.
    [re(`what(?: are|'re) you running|what's running|what do you have running|what (?:${NOUN}(?: (?:and|or) ${NOUN})*) (?:do i have|have i got|are there|are (?:running|set up|active|on))|(?:show|list|tell)(?: me)? (?:my|the|your|all my|all the) ${NOUN}(?: (?:and|or) ${NOUN})*|(?:do i have|are there) any ${NOUN}(?: (?:and|or) ${NOUN})*(?: running| set up)?`),
      () => ({ verb: 'running', args: {} })],
    [re(`${MANAGE} (?:.{0,60} )?${NOUN}(?: (?:called|named|about|for|that|which|to) .{1,80})?|stop reminding me(?: .{1,80})?`),
      () => ({ verb: 'running', args: {} })],

    // ---- what the browser lets fren see -----------------------------------
    [re(`(?:don't|do not|never|stop) (?:read|reading|look at|looking at|watch|watching) ${SITE}|(?:exclude|ignore|skip) ${SITE}`),
      () => ({ verb: 'exclude', args: { domain: null } })],
    [re(`(?:(?:don't|do not|never|stop) (?:read|reading|look at|looking at)|exclude|ignore|skip) (?:https?://)?(?:www\\.)?${DOMAIN}(?:/\\S*)?`),
      (m) => ({ verb: 'exclude', args: { domain: bareDomain(m[1]) } })],
    [re(`you can (?:read|look at) ${SITE} again|(?:stop excluding|unexclude|un-exclude|start reading) ${SITE}(?: again)?`),
      () => ({ verb: 'include', args: { domain: null } })],
    [re(`you can (?:read|look at) (?:https?://)?(?:www\\.)?${DOMAIN}(?:/\\S*)? again|(?:stop excluding|unexclude|un-exclude|start reading) (?:https?://)?(?:www\\.)?${DOMAIN}(?:/\\S*)?(?: again)?`),
      (m) => ({ verb: 'include', args: { domain: bareDomain(m[1] || m[2]) } })],
    [re("(stop|quit|start|resume) reading (?:my |the )?(?:web ?)?pages?(?: content)?(?: again)?|you can read (?:my |the )?(?:web ?)?pages again"),
      (m) => ({ verb: 'readPages', args: { on: !/^(stop|quit)$/i.test(m[1] || 'start') } })],
    [re("(stop|quit|start|resume) reading (?:my |the )?(?:selections?|selected text|highlights?|what i (?:select|highlight))(?: again)?"),
      (m) => ({ verb: 'readSelections', args: { on: !/^(stop|quit)$/i.test(m[1]) } })],
    [re("(?:turn|switch) (?:browser awareness|browser reading) (off|on)|(?:turn|switch) (off|on) (?:browser awareness|browser reading)|(stop|start) (?:watching|reading|looking at) my browser(?: again)?"),
      (m) => ({ verb: 'awareness', args: { on: /^(on|start)$/i.test(m[1] || m[2] || m[3]) } })],

    // ---- colour -----------------------------------------------------------
    [re("go back to (?:orange|ember|(?:your|the) (?:normal|usual|default|original|old) colou?r)|(?:reset|restore) your colou?r|change your colou?r back"),
      () => ({ verb: 'colour', args: { name: 'default' } })],
    [re("(?:change|set|make|switch|turn) (?:your|the orb's?) colou?r (?:to|into) (?:the )?([a-z -]{2,30})"),
      (m) => ({ verb: 'colour', args: { name: m[1].trim().toLowerCase() } })],
    [re("what colou?rs (?:can you be|do you (?:have|come in)|can i (?:pick|choose)(?: from)?)"),
      () => ({ verb: 'colour', args: { name: '' } })],

    // ---- the light at launch ----------------------------------------------
    [re("(?:stop|quit) (?:waking|turning on|starting)(?: up)?(?: yourself)? (?:at|on|when) (?:launch|start ?up|i (?:launch|open|start) you)|(?:don't|do not) (?:wake|turn on|start)(?: up)? (?:at|on|when) (?:launch|start ?up|i (?:launch|open|start) you)|(?:start|launch|stay) (?:dark|asleep|paused)(?: (?:at|on) (?:launch|start ?up))?"),
      () => ({ verb: 'wakeOnLaunch', args: { on: false } })],
    [re("(?:start |go back to )?(?:waking|wake) up (?:at|on|when) (?:launch|start ?up|i (?:launch|open|start) you)(?: again)?|(?:start|launch) awake(?: (?:at|on) (?:launch|start ?up))?"),
      () => ({ verb: 'wakeOnLaunch', args: { on: true } })],

    // ---- speaking up ------------------------------------------------------
    [re("stop interrupting(?: me)?|(?:don't|do not) interrupt(?: me)?|(?:don't|do not) (?:speak|talk|say anything) unless (?:i (?:talk|speak) to you(?: first)?|i ask|spoken to)|only (?:speak|talk) when (?:i (?:talk|speak) to you|i ask|spoken to)|stop (?:speaking|talking|piping) up"),
      () => ({ verb: 'volunteer', args: { on: false } })],
    [re("you (?:can|may) (?:speak|talk|pipe) up(?: again)?|you (?:can|may) interrupt(?: me)?(?: again)?|(?:start|resume) (?:speaking|talking) up(?: again)?|feel free to (?:speak up|interrupt(?: me)?)(?: again)?"),
      () => ({ verb: 'volunteer', args: { on: true } })],

    // ---- memory -----------------------------------------------------------
    [re("(?:forget|clear|delete|erase|wipe) (?:this|the|our) (?:conversation|chat|transcript|chat history)"),
      () => ({ verb: 'forgetConversation', args: {} })],
    [re("forget (?:that|about|what i said about|the fact that) (.{3,200})"),
      (m) => (/^(?:it|that|this|them|me)$/i.test(m[1].trim()) ? null : { verb: 'forget', args: { query: m[1].trim() } })],
    [re("what do you (?:know|remember) about me|what have you (?:kept|remembered|learned|learnt|noted)(?: about me)?|what(?:'s| is) in your (?:memory|notes)|(?:show|open)(?: me)? (?:my|your) notes(?: folder)?"),
      () => ({ verb: 'knows', args: {} })],

    // ---- patterns ---------------------------------------------------------
    [re("what patterns (?:have you|did you|do you) (?:noticed?|seen?|found|find|spotted|spot)(?: lately| recently| so far)?|(?:have you )?(?:noticed|seen|found|spotted) any patterns(?: lately| recently)?|(?:show|list|tell)(?: me)?(?: about)? (?:my|the|your) patterns|any patterns(?: lately| recently)?"),
      () => ({ verb: 'patterns', args: {} })],
  ];

  // "remember that …" keeps the person's own words, case and all — and their
  // ending: "I live in Lisbon now" must not lose its "now". Without "that" it
  // has to be plainly about them ("remember I take the 8:15"), or "remember
  // the milk" becomes a note.
  const REMEMBER = /^remember(?: this)?(?:(?::| that| -) (.{3,500})| ((?:i|i'm|i've|my|we|our)\b.{3,500}))$/i;
  const NOT_A_NOTE = /^(?:to|when|how|what|why|where|who|the time)\b/i;

  /**
   * What fren was asked to do about itself, or null.
   *
   * `ctx.names` is what fren is running, by name. It lets "pause the stretch
   * one" reach the management card even though the sentence never says
   * "reminder". Nothing else about the world comes in here.
   */
  function parse(text, ctx) {
    const raw = String(text || '');
    const t = normalise(raw);
    if (!t || t.length > 300) return null;
    const asked = /\?\s*$/.test(raw.trim());
    const s = t.replace(/\?+$/, '').trim();

    for (const [pattern, make] of RULES) {
      const m = pattern.exec(s);
      if (m) return make(m);
    }

    // A question is not an instruction: "remember that time in Lisbon?"
    // "remember to …" is a reminder, which is creation and belongs to the
    // scheduling path.
    if (!asked) {
      const m = REMEMBER.exec(lead(raw));
      const note = m ? (m[1] || m[2]).trim() : '';
      if (note && !NOT_A_NOTE.test(note)) return { verb: 'remember', args: { note } };
    }

    const names = ctx && Array.isArray(ctx.names) ? ctx.names : [];
    if (names.length) {
      const m = new RegExp(`^${MANAGE} (?:the |my |that |this )?(.{2,80})$`, 'i').exec(s);
      if (m) {
        // Every word they used has to be in one name: "the music" is not
        // "Morning recap", and "it" is not anything.
        const said = words(m[1].replace(/ (?:one|thing)$/i, ''));
        if (said.length && names.some((n) => { const have = new Set(words(n)); return said.every((w) => have.has(w)); })) {
          return { verb: 'running', args: {} };
        }
      }
    }
    return null;
  }

  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  // What people call the presets when they do not know the presets have names.
  const COLOUR_WORDS = {
    orange: 'ember', amber: 'ember', normal: 'ember', default: 'ember',
    pink: 'rhubarb', red: 'rhubarb',
    purple: 'mulberry', violet: 'mulberry',
    blue: 'cornflower',
    teal: 'lagoon', turquoise: 'lagoon', cyan: 'lagoon',
    green: 'moss',
  };

  /** A preset from a word, or null. `presets` is FrenPalette.PRESETS. */
  function resolveColour(name, presets) {
    const n = key(name);
    if (!n) return null;
    const id = COLOUR_WORDS[n] || n;
    return (presets || []).find((p) => p.id === id || key(p.name) === id) || null;
  }

  const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'about', 'from', 'have', 'has', 'was', 'are', 'you', 'your', 'my', 'mine', 'i', 'im', 'me', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'it']);
  const words = (s) => key(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

  /** A note as the person reads it: no bullet, no date stamp. */
  function factText(line) {
    return String(line || '').replace(/^- /, '').replace(/\s*_\(\d{4}-\d{2}-\d{2}\)_\s*$/, '').trim();
  }

  /**
   * Which notes "forget that …" could mean: those sharing at least half of the
   * words that carry meaning. Showing two candidates is fine — each gets its
   * own chip. Guessing one and deleting it would not be.
   */
  function matchFacts(facts, query) {
    const q = words(query);
    if (!q.length) return [];
    return (facts || []).filter((f) => {
      const have = new Set(words(factText(f)));
      const hits = q.filter((w) => have.has(w)).length;
      return hits > 0 && hits / q.length >= 0.5;
    });
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

  return { parse, normalise, resolveColour, matchFacts, factText, describeWhen };
});
