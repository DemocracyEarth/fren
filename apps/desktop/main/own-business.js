'use strict';
/**
 * fren doing what it was told about itself, and saying so.
 *
 * The chat window recognises the sentence (renderer/own-business.js); this is
 * what happens next. It holds no state and reaches nothing on its own: every
 * deed goes through a function main hands in, and those are the same functions
 * the IPC handlers run, so a setting changed by saying it and a setting changed
 * any other way cannot come to mean different things. That also makes this
 * file testable without Electron, which matters because its replies are
 * promises ("I won't read github.com from now on") and a promise should be
 * checked.
 *
 * apply() resolves { say, rows?, chips?, refresh? }:
 *   say     — fren's reply, in its voice. Short, because it is spoken.
 *   rows    — lines under the reply, each { text, chips }. Read, not spoken.
 *   chips   — buttons for the whole reply.
 *   refresh — what the chat window caches and should read again.
 *
 * A chip is { label, call, args, confirm?, then?, done? }: `call` names an
 * entry the chat window already has (setRoutineEnabled, deleteRoutine, …), so
 * a click does exactly what that entry always did. Anything that destroys
 * something is a chip, and never a sentence: sentences get misheard.
 */
const OB = require('../renderer/own-business.js');
const palette = require('../renderer/face/palette.js');
const { isExcluded, DEFAULT_EXCLUSIONS } = require('./browser-sensor');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "today at 14:00", "tomorrow at 09:00", "Monday at 09:00". Local time. */
function whenText(ts, now = Date.now()) {
  const d = new Date(ts);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(new Date(now))) / 86400000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]} at ${time}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${time}`;
}

const DELETE = { label: 'Delete', confirm: 'Yes, delete it', then: 'redraw' };

function routineRow(r, now) {
  const state = !r.enabled ? 'Paused.' : r.nextRun ? `Next: ${whenText(r.nextRun, now)}.` : '';
  return {
    text: `${clip(r.name, 60)} — asks "${clip(r.prompt, 140)}" ${OB.describeWhen(r)}. ${state}`.trim(),
    chips: [
      { label: r.enabled ? 'Pause' : 'Resume', call: 'setRoutineEnabled', args: [r.id, !r.enabled], then: 'redraw' },
      { ...DELETE, call: 'deleteRoutine', args: [r.id] },
    ],
  };
}

function automationRow(a, now) {
  const what = clip(a.body && a.body.instruction, 140).replace(/[.!?]+$/, '');
  const state = a.enabled
    ? (a.nextRunAt ? `Next: ${whenText(a.nextRunAt, now)}.` : '')
    : a.pausedByRuntime ? `Stopped: ${clip(a.pausedByRuntime, 120)}.` : 'Paused.';
  return {
    text: `${clip(a.name, 60)} — ${a.describe || 'when asked'}${what ? `: ${what}` : ''}. ${state}`.trim(),
    chips: [
      { label: a.enabled ? 'Pause' : 'Resume', call: 'patchAgentAutomation', args: [a.id, { enabled: !a.enabled }], then: 'redraw' },
      { label: 'Run now', call: 'runAgentAutomation', args: [a.id], then: 'keep', done: "Running it now. I'll say what comes back." },
      { ...DELETE, call: 'deleteAgentAutomation', args: [a.id] },
    ],
  };
}

const NOTES_CHIP = { label: 'Open my notes folder', call: 'openDataFolder', args: [], then: 'keep' };
const MAX_LISTED = 12;

function createOwnBusiness(d) {
  const now = () => (d.now ? d.now() : Date.now());

  async function everythingRunning() {
    const routines = d.routines();
    let automations = [];
    let reached = true;
    try { automations = (await d.automations()) || []; } catch { reached = false; }
    if (!Array.isArray(automations)) { automations = []; reached = false; }
    return { routines, automations, reached };
  }

  /** Which site "this site" is, or the reply that says fren cannot tell. */
  function siteFor(domain) {
    const site = String(domain || d.currentDomain() || '').toLowerCase().replace(/^www\./, '');
    if (site) return { site };
    return { say: 'I can\'t see a page right now, so I don\'t know which site you mean. Say its name — "don\'t read example.com".' };
  }

  const verbs = {
    watch({ on }) {
      if (!!on === !!d.watching()) return { say: on ? "I'm already watching." : "I'm not watching — my light is off." };
      d.setWatching(!!on);
      return { say: on ? 'Okay — watching again.' : 'Okay — not watching.' };
    },

    async running() {
      const { routines, automations, reached } = await everythingRunning();
      const rows = [...routines.map((r) => routineRow(r, now())), ...automations.map((a) => automationRow(a, now()))];
      const missing = reached ? '' : " I couldn't reach my automations just now, so this is only the routines.";
      if (!rows.length) return { say: reached ? 'Nothing running right now.' : "No routines — and I couldn't reach my automations just now." };
      return { say: `${plural(rows.length, 'thing', 'things')} running.${missing}`, rows };
    },

    /** What fren runs, by name, so "pause the stretch one" can be recognised. No reply. */
    async names() {
      const { routines, automations } = await everythingRunning();
      return { say: '', names: [...routines, ...automations].map((x) => String(x.name || '')).filter(Boolean) };
    },

    exclude({ domain }) {
      const { site, say } = siteFor(domain);
      if (!site) return { say };
      const mine = d.browser().exclusions;
      if (isExcluded(site, [...DEFAULT_EXCLUSIONS, ...mine])) return { say: `I already don't read ${site}.` };
      const saved = d.setBrowser({ exclusions: [...mine, site] });
      if (!saved.includes(site)) return { say: `"${site}" doesn't look like a site's name to me.` };
      return {
        say: `I won't read ${site} from now on.`,
        chips: [{ label: 'Undo', call: 'ownBusiness', args: ['include', { domain: site }, ''] }],
      };
    },

    include({ domain }) {
      const { site, say } = siteFor(domain);
      if (!site) return { say };
      if (isExcluded(site, DEFAULT_EXCLUSIONS)) {
        return { say: `${site} is on the short list I never read — banks, passwords, that kind of place. It stays there.` };
      }
      const mine = d.browser().exclusions;
      const covering = mine.filter((p) => isExcluded(site, [p]));
      if (!covering.length) return { say: `I wasn't skipping ${site}.` };
      d.setBrowser({ exclusions: mine.filter((p) => !covering.includes(p)) });
      return { say: `Okay — I can read ${covering.join(' and ')} again.` };
    },

    readPages({ on }) {
      d.setBrowser({ readPage: !!on });
      return { say: on ? 'Okay — reading pages again.' : "Okay — I'll see which page you're on, but not what's on it." };
    },

    readSelections({ on }) {
      d.setBrowser({ readSelection: !!on });
      return { say: on ? "Okay — I'll read what you select again." : "Okay — I won't read what you select." };
    },

    awareness({ on }) {
      d.setBrowser({ awareness: !!on });
      return { say: on ? 'Okay — I can see your browser again.' : "Okay — I'm out of your browser." };
    },

    colour({ name }) {
      const preset = OB.resolveColour(name, palette.PRESETS);
      if (!preset) {
        const list = palette.PRESETS.map((p) => p.name.toLowerCase());
        const can = `I can be ${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}.`;
        return { say: name ? `I don't have "${clip(name, 30)}". ${can}` : can };
      }
      d.setColour(preset.hex);
      return { say: preset.hex === palette.DEFAULT_HEX ? 'Back to ember.' : `${preset.name} it is.` };
    },

    wakeOnLaunch({ on }) {
      d.setWakeOnLaunch(!!on);
      return { say: on ? "Okay — I'll wake up with my light on when you launch me." : "Okay — I'll start dark, and wait until you say so." };
    },

    volunteer({ on }) {
      const res = d.setVolunteer(!!on);
      // The chat window decides whether to speak from ITS copy of the profile,
      // so the change is not real until it reads the profile again.
      if (!res || !!res.volunteer !== !!on) return { say: "I couldn't change that just now." };
      return {
        say: on
          ? "Okay — I'll say so when I notice something."
          : "Okay — I won't speak up on my own. If I notice something I'll hop; right-click me to hear it.",
        refresh: ['profile'],
      };
    },

    async remember({ note }) {
      const res = await d.remember(String(note || ''));
      return { say: res && res.kept ? "I'll remember that." : "I didn't keep that — either I already have it, or it isn't the kind of thing I hold on to." };
    },

    knows() {
      const facts = d.facts();
      if (!facts.length) return { say: 'Nothing yet, beyond what you told me when we met. Say "remember that …" and I will.', chips: [NOTES_CHIP] };
      const shown = facts.slice(-MAX_LISTED);
      return {
        say: facts.length > shown.length
          ? `I've kept ${facts.length} things about you. These are the latest; the rest are in my notes.`
          : `I've kept ${plural(facts.length, 'thing', 'things')} about you.`,
        rows: shown.map((f) => ({ text: OB.factText(f), chips: [] })),
        chips: [NOTES_CHIP],
      };
    },

    forget({ query }) {
      const found = OB.matchFacts(d.facts(), query).slice(-MAX_LISTED);
      if (!found.length) return { say: "I don't have a note like that. Ask me what I know about you to see what I've kept." };
      return {
        say: found.length === 1 ? 'This is the note I have. Forget it?' : 'These are the notes that could be. Which one?',
        rows: found.map((f) => ({
          text: OB.factText(f),
          chips: [{ label: 'Forget this', call: 'ownBusiness', args: ['forgetFact', { fact: f }, ''], then: 'drop' }],
        })),
      };
    },

    /** Only ever reached from a "Forget this" chip: the argument is the bullet itself. */
    forgetFact({ fact }) {
      const res = d.forgetFact(String(fact || ''));
      return { say: res && res.removed ? 'Forgotten.' : "I couldn't find that note any more." };
    },

    forgetConversation() {
      return {
        say: "Forget this whole conversation? It can't be brought back.",
        chips: [
          { label: 'Yes, forget it', call: 'clearMessages', args: [], then: 'wipe', done: 'Gone.' },
          { label: 'Keep it' },
        ],
      };
    },

    patterns() {
      const open = d.patterns().filter((s) => s && s.status !== 'dismissed' && s.message).slice(-5).reverse();
      if (!open.length) return { say: "Nothing I'd call a pattern yet." };
      return {
        say: `${plural(open.length, 'thing', 'things')} I've noticed lately.`,
        rows: open.map((s) => ({
          text: clip(s.message, 300),
          chips: [{ label: 'Not useful', call: 'dismissSuggestion', args: [s.id], then: 'drop' }],
        })),
      };
    },
  };

  /** Never throws: a failed deed is something fren says, not a broken chat. */
  async function apply(verb, args) {
    const fn = Object.prototype.hasOwnProperty.call(verbs, verb) ? verbs[verb] : null;
    if (!fn) return { say: "I didn't follow that." };
    try {
      return await fn(args && typeof args === 'object' ? args : {});
    } catch (err) {
      return { say: `I couldn't do that: ${(err && err.message) || 'something went wrong'}.` };
    }
  }

  return { apply };
}

module.exports = { createOwnBusiness, whenText, routineRow, automationRow };
