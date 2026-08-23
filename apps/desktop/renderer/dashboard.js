'use strict';
/**
 * The dashboard.
 *
 * Reads back what fren has stored: a day at a time, and the patterns drawn
 * across them. Everything shown here already exists on disk — this window adds
 * no capability, it only makes what was recorded legible.
 *
 * All rendering goes through textContent and createElement, never innerHTML.
 * Almost everything on screen is derived from window titles, which are
 * attacker-influenced content: a page can name its own tab.
 */
const els = {
  dayList: document.getElementById('day-list'),
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  content: document.getElementById('content'),
  patternCount: document.getElementById('side-pattern-count'),
  autoCount: document.getElementById('side-auto-count'),
  routineCount: document.getElementById('side-routine-count'),
  status: document.querySelector('#side-status span'),
};

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** "Today", "Yesterday", or a written date. */
function dayLabel(key) {
  const t = todayKey();
  if (key === t) return 'Today';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yKey = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  if (key === yKey) return 'Yesterday';
  const [yy, mm, dd] = key.split('-').map(Number);
  return new Date(yy, mm - 1, dd).toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function blank(headline, detail) {
  const wrap = el('div', 'blank');
  wrap.append(el('strong', null, headline), el('span', null, detail));
  return wrap;
}

let current = { kind: 'day', key: todayKey() };

// ------------------------------------------------------------------ days --
async function loadSidebar() {
  let days = [];
  try { days = await window.fren.days(); } catch { days = [] }

  // Today is always offered, even before anything has been recorded in it.
  const keys = days.map((d) => d.day);
  if (!keys.includes(todayKey())) {
    days.unshift({ day: todayKey(), memories: 0 });
  }

  els.dayList.textContent = '';
  for (const d of days.slice(0, 14)) {
    const b = el('button', 'side-item');
    b.dataset.day = d.day;
    b.append(el('span', null, dayLabel(d.day)));
    if (d.memories) b.append(el('span', 'sub', String(d.memories)));
    b.addEventListener('click', () => showDay(d.day));
    els.dayList.appendChild(b);
  }
  markActive();
}

function markActive() {
  for (const b of document.querySelectorAll('.side-item')) {
    const on = (current.kind === 'day' && b.dataset.day === current.key) ||
               (current.kind !== 'day' && b.dataset.section === current.kind);
    b.classList.toggle('on', on);
  }
}

async function showDay(key) {
  current = { kind: 'day', key };
  markActive();
  els.title.textContent = dayLabel(key);
  els.content.textContent = '';

  let data = { memories: [], shots: [] };
  try { data = await window.fren.day(key); } catch { /* show the empty state */ }

  const { memories, shots } = data;
  const rows = collapse(memories);
  els.subtitle.textContent = memories.length
    ? `${rows.length} ${rows.length === 1 ? 'stretch' : 'stretches'}` +
      (rows.length !== memories.length ? ` from ${memories.length} summaries` : '') +
      (shots.length ? ` · ${shots.length} stills` : '')
    : 'Nothing recorded';

  if (!memories.length && !shots.length) {
    els.content.appendChild(blank(
      'Nothing from this day',
      'fren only records while its light is on, and it summarises every couple ' +
      'of minutes. A day it spent paused stays empty, which is the point.'
    ));
    return;
  }

  if (shots.length) {
    els.content.appendChild(el('div', 'sec', 'Stills'));
    const grid = el('div', 'shots');
    for (const s of shots) {
      const fig = el('figure', 'shot');
      const img = document.createElement('img');
      img.src = s.url;
      img.alt = '';                    // decorative: the caption carries it
      img.loading = 'lazy';
      const cap = el('figcaption');
      cap.append(el('b', null, s.activeApp || 'unknown'));
      if (s.windowTitle) cap.append(el('span', null, s.windowTitle.slice(0, 40)));
      cap.append(el('time', null, hhmm(s.ts)));
      fig.append(img, cap);
      grid.appendChild(fig);
    }
    els.content.appendChild(grid);
  }

  if (memories.length) {
    els.content.appendChild(el('div', 'sec', 'What you were doing'));
    const tl = el('div', 'tl');
    for (const m of collapse(memories)) {
      const row = el('div', 'tl-row');
      const time = el('div', 'tl-time', `${hhmm(m.tsStart)} – ${hhmm(m.tsEnd)}`);
      if (m.repeats > 1) {
        time.append(el('span', 'tl-repeat', `×${m.repeats}`));
      }
      row.append(time);
      row.append(el('p', 'tl-text', m.activity));
      if (m.apps && m.apps.length) {
        const apps = el('div', 'tl-apps');
        for (const a of m.apps.slice(0, 6)) apps.append(el('span', 'app-tag', a));
        row.appendChild(apps);
      }
      tl.appendChild(row);
    }
    els.content.appendChild(tl);
  }
}

/**
 * Merge runs of identical summaries into one row.
 *
 * A long day produces a great many summaries that say the same thing, and 233
 * identical lines is not a record of a day — it is a wall. Collapsing them into
 * one row spanning the whole stretch, with a count, turns that back into
 * something readable without hiding anything: the times and the number are both
 * still there.
 */
function collapse(memories) {
  const out = [];
  for (const m of memories) {
    const last = out[out.length - 1];
    if (last && last.activity === m.activity) {
      last.tsEnd = m.tsEnd;
      last.repeats += 1;
      // Keep whichever app set is richer, so the merged row is not poorer than
      // the rows it replaced.
      if ((m.apps || []).length > (last.apps || []).length) last.apps = m.apps;
      continue;
    }
    out.push({ ...m, repeats: 1 });
  }
  return out;
}

// -------------------------------------------------------------- patterns --
function patternCard(s) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('b', null, 'fren noticed'));
  if (s.ts) {
    const t = el('time', null,
      new Date(s.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' · ' + hhmm(s.ts));
    head.append(t);
  }
  card.append(head, el('p', null, s.message));
  if (s.pattern) {
    const named = el('div', 'named');
    named.append(el('span', null, s.pattern));
    card.appendChild(named);
  }
  return card;
}

async function showPatterns() {
  current = { kind: 'patterns' };
  markActive();
  els.title.textContent = 'Patterns';
  els.content.textContent = '';

  const all = await suggestions();
  const live = all.filter((s) => s.status !== 'dismissed');
  els.subtitle.textContent = live.length
    ? `${live.length} noticed`
    : 'Nothing noticed yet';

  if (!live.length) {
    els.content.appendChild(blank(
      'Nothing noticed yet',
      'fren looks across the last few hours for a sequence you repeat, and it ' +
      'would rather say nothing than guess. A pattern has to happen several ' +
      'separate times before it appears here.'
    ));
    return;
  }
  for (const s of live) els.content.appendChild(patternCard(s));
}

// ----------------------------------------------------------- automations --
async function showAutomations() {
  current = { kind: 'automations' };
  markActive();
  els.title.textContent = 'Automations';
  els.content.textContent = '';

  const all = await suggestions();
  const drafted = all.filter((s) => s.draft);
  els.subtitle.textContent = drafted.length
    ? `${drafted.length} drafted`
    : 'Nothing drafted yet';

  if (!drafted.length) {
    els.content.appendChild(blank(
      'Nothing drafted yet',
      'Ask fren to automate something it noticed and the draft appears here. ' +
      'fren writes them; it never runs them.'
    ));
    return;
  }

  for (const s of drafted) {
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    head.append(el('b', null, s.pattern || 'automation'));
    card.append(head);

    const d = s.draft;
    if (!d.feasible) {
      card.append(el('p', null, d.caveats || 'This one cannot be automated from what fren saw.'));
      els.content.appendChild(card);
      continue;
    }
    if (d.approach) card.append(el('p', null, d.approach));
    if (d.steps && d.steps.length) {
      const ol = el('ol');
      for (const step of d.steps) ol.append(el('li', null, step));
      card.append(ol);
    }
    if (d.script) {
      card.append(el('pre', null, d.script));
      // Said next to the script, every time, not buried in a doc.
      card.append(el('p', 'warn', 'fren has not run this, and cannot. Read it before you do.'));
    }
    if (d.caveats) card.append(el('p', 'caveat', d.caveats));
    els.content.appendChild(card);
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "every weekday at 09:00", in words rather than as a cron line. */
function describeWhen(r) {
  const time = `${pad(r.hour)}:${pad(r.minute)}`;
  if (!r.days || !r.days.length) return `Every day at ${time}`;
  const set = [...r.days].sort().join(',');
  if (set === '1,2,3,4,5') return `Every weekday at ${time}`;
  if (set === '0,6') return `Weekends at ${time}`;
  if (r.days.length === 1) return `Every ${DAY_NAMES[r.days[0]]} at ${time}`;
  return `${r.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')} at ${time}`;
}

function whenNext(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return `Next: today at ${time}`;
  if (isTomorrow) return `Next: tomorrow at ${time}`;
  return `Next: ${d.toLocaleDateString(undefined, { weekday: 'short' })} at ${time}`;
}

async function showRoutines() {
  current = { kind: 'routines' };
  markActive();
  els.title.textContent = 'Routines';
  els.content.textContent = '';

  let list = [];
  try { list = await window.fren.routines(); } catch { list = []; }
  const on = list.filter((r) => r.enabled).length;
  els.subtitle.textContent = list.length
    ? `${list.length} set up${on !== list.length ? `, ${on} active` : ''}`
    : 'Nothing scheduled';

  if (!list.length) {
    els.content.appendChild(blank(
      'Nothing scheduled',
      'Tell fren when you want something — "every weekday at nine, tell me what ' +
      'I did yesterday" — and it appears here. A routine asks fren a question ' +
      'and reads the answer back; it does not run commands.'
    ));
    return;
  }

  for (const r of list) {
    const card = el('div', 'card');

    const head = el('div', 'card-head');
    head.append(el('b', null, r.name));
    head.append(el('time', null, describeWhen(r)));
    card.append(head);

    card.append(el('p', null, r.prompt));

    const meta = el('div', 'named');
    meta.append(el('span', null, r.enabled ? whenNext(r.nextRun) : 'Paused'));
    if (r.lastRun) {
      meta.append(el('span', 'dim',
        `Last ran ${new Date(r.lastRun).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`));
    }
    card.append(meta);

    if (r.lastText) {
      const d = el('details', 'last');
      d.append(el('summary', null, 'What it said last time'));
      d.append(el('p', null, r.lastText));
      card.append(d);
    }

    const actions = el('div', 'row-actions');
    const toggle = el('button', 'mini', r.enabled ? 'Pause' : 'Resume');
    toggle.addEventListener('click', async () => {
      await window.fren.setRoutineEnabled(r.id, !r.enabled);
      showRoutines();
    });
    const del = el('button', 'mini danger', 'Delete');
    del.addEventListener('click', async () => {
      await window.fren.deleteRoutine(r.id);
      showRoutines();
      refreshCounts();
    });
    actions.append(toggle, del);
    card.append(actions);

    els.content.appendChild(card);
  }
}

async function refreshCounts() {
  cachedSuggestions = null;
  const all = await suggestions();
  const live = all.filter((s) => s.status !== 'dismissed').length;
  const drafted = all.filter((s) => s.draft).length;
  let routineCount = 0;
  try { routineCount = (await window.fren.routines()).filter((r) => r.enabled).length; } catch { /* none */ }

  const set = (elm, n) => {
    if (!elm) return;
    elm.textContent = String(n);
    elm.hidden = !n;
  };
  set(els.patternCount, live);
  set(els.autoCount, drafted);
  set(els.routineCount, routineCount);
}

let cachedSuggestions = null;
async function suggestions() {
  if (cachedSuggestions) return cachedSuggestions;
  try { cachedSuggestions = await window.fren.getSuggestions(); } catch { cachedSuggestions = []; }
  return cachedSuggestions;
}

const SECTIONS = {
  patterns: showPatterns,
  automations: showAutomations,
  routines: showRoutines,
};
for (const b of document.querySelectorAll('.side-item[data-section]')) {
  b.addEventListener('click', () => SECTIONS[b.dataset.section]());
}

// ------------------------------------------------------------------ boot --
(async function init() {
  if (!window.fren) {
    els.content.appendChild(blank(
      'I cannot reach my own controls',
      'The preload bridge did not load, so there is nothing to show. Restarting fren should fix it.'
    ));
    return;
  }

  const paint = (state) => {
    document.body.dataset.watching = state && state.observing ? '1' : '0';
    if (els.status) els.status.textContent = state && state.observing ? 'watching' : 'paused';
  };
  window.fren.onStateChanged(paint);
  try { paint(await window.fren.getState()); } catch { /* leave it paused */ }

  await loadSidebar();

  await refreshCounts();
  await showDay(todayKey());
})();
