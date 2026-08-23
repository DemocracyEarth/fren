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
  dayQuick: document.getElementById('day-quick'),
  history: document.getElementById('history'),
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  content: document.getElementById('content'),
  patternCount: document.getElementById('side-pattern-count'),
  autoCount: document.getElementById('side-auto-count'),
  routineCount: document.getElementById('side-routine-count'),
  status: document.querySelector('#side-status span'),
  statusBtn: document.getElementById('side-status'),
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
function dayButton(d) {
  const b = el('button', 'side-item');
  b.dataset.day = d.day;
  b.append(el('span', null, dayLabel(d.day)));
  if (d.memories) b.append(el('span', 'sub', String(d.memories)));
  b.addEventListener('click', () => showDay(d.day));
  return b;
}

async function loadSidebar() {
  let days = [];
  try { days = await window.fren.days(); } catch { days = [] }

  // Today is always offered, even before anything has been recorded in it.
  if (!days.some((d) => d.day === todayKey())) {
    days.unshift({ day: todayKey(), memories: 0 });
  }

  // Today and yesterday are pinned above the sections, because they are what
  // this window is opened for and they must not move as history accumulates.
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yKey = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  const pinned = new Set([todayKey(), yKey]);

  els.dayQuick.textContent = '';
  for (const key of [todayKey(), yKey]) {
    const found = days.find((d) => d.day === key);
    // Yesterday only appears if something happened in it; today always does.
    if (found) els.dayQuick.appendChild(dayButton(found));
    else if (key === todayKey()) els.dayQuick.appendChild(dayButton({ day: key, memories: 0 }));
  }

  // Everything older, all of it. This used to render days.slice(0, 14) while
  // fetching sixty, so anything past a fortnight simply could not be reached.
  const earlier = days.filter((d) => !pinned.has(d.day));
  els.dayList.textContent = '';
  for (const d of earlier) els.dayList.appendChild(dayButton(d));
  if (els.history) els.history.hidden = earlier.length === 0;

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
    els.content.appendChild(el('h2', 'sec', 'Stills'));
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
    els.content.appendChild(el('h2', 'sec', 'What you were doing'));
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

  let list = [];
  try { list = await window.fren.automations(); } catch { list = []; }

  // Drafts that have not been kept yet still live on the suggestion.
  const all = await suggestions();
  const unkept = all.filter((x) => x.draft && x.draft.script &&
    !list.some((a) => a.suggestionId === x.id));

  els.subtitle.textContent = list.length || unkept.length
    ? `${list.length} kept${unkept.length ? `, ${unkept.length} drafted` : ''}`
    : 'Nothing drafted yet';

  if (!list.length && !unkept.length) {
    els.content.appendChild(blank(
      'Nothing drafted yet',
      'Ask fren to automate something it noticed and the draft appears here. ' +
      'Nothing runs until you have read it and approved it, and nothing is ' +
      'scheduled until it has already run once by hand.'
    ));
    return;
  }

  for (const a of list) els.content.appendChild(automationCard(a));

  for (const s of unkept) {
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    head.append(el('b', null, s.pattern || 'draft'));
    card.append(head);
    if (s.draft.approach) card.append(el('p', null, s.draft.approach));
    card.append(el('pre', null, s.draft.script));
    const actions = el('div', 'row-actions');
    const keep = el('button', 'mini primary', 'Keep this');
    keep.addEventListener('click', async () => {
      await window.fren.keepAutomation(s.id);
      cachedSuggestions = null;
      showAutomations();
      refreshCounts();
    });
    actions.append(keep);
    card.append(actions);
    els.content.appendChild(card);
  }
}

/**
 * One kept automation, and the three gates it has to pass.
 *
 * The interface makes the state legible rather than just offering buttons: you
 * can see whether it is approved, whether it has ever run, and whether it is
 * scheduled — because "why won't this run?" should be answerable by looking.
 */
function automationCard(a) {
  const card = el('div', 'card');

  const head = el('div', 'card-head');
  head.append(el('b', null, a.name));
  head.append(el('time', null, a.language || 'script'));
  card.append(head);

  // The three gates, stated.
  const approved = a.approvedHash && a.approvedHash === a.currentHash;
  const gates = el('div', 'gates');
  gates.append(gate('Approved', approved,
    a.approvedHash && !approved ? 'script changed since approval' : ''));
  gates.append(gate('Run by hand', a.verified));
  gates.append(gate('Scheduled', !!(a.schedule && a.schedule.enabled)));
  card.append(gates);

  if (!a.scan.safe) {
    const warn = el('p', 'warn',
      'fren will refuse to run this: ' + a.scan.blocked.join('; ') + '.');
    card.append(warn);
  }

  card.append(el('pre', null, a.script));

  const actions = el('div', 'row-actions');

  if (!approved) {
    const ok = el('button', 'mini primary', 'I have read this — approve');
    ok.disabled = !a.scan.safe;
    ok.addEventListener('click', async () => {
      // The hash of what was RENDERED, so approving something that changed
      // underneath is refused rather than silently accepted.
      const res = await window.fren.approveAutomation(a.id, a.currentHash);
      if (res && res.error) return alertInline(card, res.error);
      showAutomations();
    });
    actions.append(ok);
  } else {
    const runBtn = el('button', 'mini primary', a.verified ? 'Run now' : 'Run now (first time)');
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      const res = await window.fren.runAutomation(a.id);
      showAutomations();
      if (res && res.output) alertInline(card, res.output);
    });
    actions.append(runBtn);

    if (a.verified) {
      const sched = el('button', 'mini',
        a.schedule && a.schedule.enabled ? 'Stop the schedule' : 'Run this on a schedule');
      sched.addEventListener('click', async () => {
        const on = !(a.schedule && a.schedule.enabled);
        const s = a.schedule || { hour: 9, minute: 0, days: [1, 2, 3, 4, 5] };
        await window.fren.scheduleAutomation(a.id, { ...s, enabled: on });
        showAutomations();
        refreshCounts();
      });
      actions.append(sched);
    }

    const revoke = el('button', 'mini', 'Withdraw approval');
    revoke.addEventListener('click', async () => {
      await window.fren.revokeAutomation(a.id);
      showAutomations();
      refreshCounts();
    });
    actions.append(revoke);
  }

  const del = el('button', 'mini danger', 'Delete');
  del.addEventListener('click', async () => {
    await window.fren.deleteAutomation(a.id);
    showAutomations();
    refreshCounts();
  });
  actions.append(del);
  card.append(actions);

  if (a.schedule && a.schedule.enabled && a.nextRun) {
    card.append(el('p', 'caveat', whenNext(a.nextRun)));
  }

  // Every run, kept. Something that runs unattended should leave a record.
  if (a.runs && a.runs.length) {
    const d = el('details', 'last');
    d.append(el('summary', null, `${a.runs.length} recent run${a.runs.length === 1 ? '' : 's'}`));
    for (const r of a.runs) {
      // 'started' is the slot-claim written before the work. If one is still
      // showing, the run is in flight rather than finished.
      if (r.status === 'started') continue;
      const line = el('div', 'run');
      line.append(el('span', `dot ${r.status}`, ''));
      line.append(el('span', null,
        `${new Date(r.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ` +
        `${hhmm(r.ts)} · ${r.trigger} · ${r.status}`));
      d.append(line);
      if (r.output) d.append(el('pre', 'run-out', r.output));
    }
    card.append(d);
  }

  return card;
}

function gate(label, passed, note) {
  const g = el('span', `gate ${passed ? 'on' : 'off'}`);
  g.append(el('i', null, passed ? '✓' : '·'));
  g.append(el('span', null, note ? `${label} — ${note}` : label));
  return g;
}

function alertInline(card, text) {
  const old = card.querySelector('.inline-note');
  if (old) old.remove();
  const p = el('p', 'caveat inline-note', text);
  card.append(p);
}


const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Every weekday at 09:00", in words rather than as a cron line. */
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
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return `Next: today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Next: tomorrow at ${time}`;
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
      refreshCounts();
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

/**
 * The numbers beside each destination.
 *
 * Each one must be what you will find when you click it. The Automations badge
 * counted every suggestion carrying a draft, while the page lists automations
 * you have kept plus drafts that still have a script and have not been kept —
 * so the badge read 5 over a page showing three things, and the difference was
 * drafts already promoted to automations, counted twice.
 */
async function refreshCounts() {
  cachedSuggestions = null;
  const all = await suggestions();
  const live = all.filter((s) => s.status !== 'dismissed').length;

  let kept = [];
  try { kept = await window.fren.automations(); } catch { kept = []; }
  const unkept = all.filter((x) => x.draft && x.draft.script &&
    !kept.some((a) => a.suggestionId === x.id));
  const automations = kept.length + unkept.length;

  let routineCount = 0;
  try { routineCount = (await window.fren.routines()).filter((r) => r.enabled).length; } catch { /* none */ }

  const set = (elm, n) => {
    if (!elm) return;
    elm.textContent = String(n);
    elm.hidden = !n;
  };
  set(els.patternCount, live);
  set(els.autoCount, automations);
  set(els.routineCount, routineCount);
}

let cachedSuggestions = null;
async function suggestions() {
  if (cachedSuggestions) return cachedSuggestions;
  try { cachedSuggestions = await window.fren.getSuggestions(); } catch { cachedSuggestions = []; }
  return cachedSuggestions;
}

// ---------------------------------------------------------------- memory --

/**
 * Everything fren holds about you, verbatim.
 *
 * Verbatim matters. A companion that has formed views about you which you
 * cannot inspect is not a companion, and paraphrasing its own notes back would
 * defeat the point of keeping them in Markdown where you can edit them.
 */
/**
 * How the files are shown, remembered between visits.
 *
 * Reading is the common case, so the rendered view leads. But these files are
 * meant to be EDITED, and editing them means knowing where the blank lines and
 * the exact characters are — so the source is one click away and the choice
 * sticks. Defaulting to source would show most people a wall of hashes; hiding
 * source would break the promise that you can see exactly what is written.
 */
let mdView = 'read';
try { mdView = localStorage.getItem('frenMdView') === 'source' ? 'source' : 'read'; } catch { /* fine */ }

function fileCard(name, title, text) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('b', null, name), el('time', null, title));

  const toggle = el('div', 'view-toggle');
  const body = el('div', 'file-body');

  const paint = () => {
    body.textContent = '';
    const src = String(text || '').trim();
    if (!src) {
      const empty = el('pre', 'muted', 'Nothing written yet.');
      body.appendChild(empty);
      return;
    }
    if (mdView === 'read') {
      body.appendChild(window.FrenMarkdown.render(src));
    } else {
      body.appendChild(el('pre', null, src));
    }
    for (const b of toggle.children) b.classList.toggle('on', b.dataset.view === mdView);
  };

  for (const [view, label] of [['read', 'Reading'], ['source', 'Source']]) {
    const b = el('button', 'view-btn', label);
    b.type = 'button';
    b.dataset.view = view;
    b.addEventListener('click', () => {
      mdView = view;
      try { localStorage.setItem('frenMdView', view); } catch { /* not worth failing over */ }
      // Every card follows, so the two never disagree about which view is on.
      for (const other of document.querySelectorAll('.card .file-body')) {
        if (other._repaint) other._repaint();
      }
    });
    toggle.appendChild(b);
  }

  body._repaint = paint;
  head.appendChild(toggle);
  card.append(head, body);
  paint();
  return card;
}

async function showMemory() {
  current = { kind: 'memory' };
  markActive();
  els.title.textContent = 'Memory';
  els.content.textContent = '';

  let data = null;
  try {
    data = await window.fren.readSoul();
  } catch (err) {
    els.subtitle.textContent = '';
    els.content.appendChild(blank('I could not read my own files',
      (err && err.message) ? err.message : String(err)));
    return;
  }

  els.subtitle.textContent =
    'Plain files on disk. Edit them and the change takes effect on your next message.';

  for (const f of data.files) els.content.appendChild(fileCard(f.name, f.title, f.text));

  // Listed rather than dumped: there is one per day, and they are the only
  // thing here that fren wrote by itself.
  const logs = el('div', 'card');
  const lhead = el('div', 'card-head');
  lhead.append(el('b', null, 'memory/'), el('time', null,
    data.logs.length ? `${data.logs.length} days` : 'nothing yet'));
  logs.appendChild(lhead);
  if (!data.logs.length) {
    logs.appendChild(el('p', 'caveat', 'What fren observed, once it has watched for a while.'));
  }
  for (const log of data.logs) {
    const b = el('button', 'log-row', `${log.name}  ·  ${Math.max(1, Math.round(log.bytes / 1024))} KB`);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const text = await window.fren.readLog(log.name);
      // A day's log gets the same two views as everything else here.
      b.replaceWith(fileCard(log.name, 'what fren observed', text || ''));
    });
    logs.appendChild(b);
  }
  els.content.appendChild(logs);

  const open = el('button', 'wide-btn', 'Open the folder');
  open.type = 'button';
  open.addEventListener('click', () => window.fren.openDataFolder());
  els.content.appendChild(open);
}

// -------------------------------------------------------------- settings --

/** One switch, with the sentence explaining what it actually does. */
function switchRow(id, title, detail, checked, onChange) {
  const row = el('label', 'switch-row');
  const box = el('input');
  box.type = 'checkbox';
  box.id = id;
  box.checked = !!checked;
  const text = el('span');
  text.append(el('strong', null, title), document.createTextNode(detail));
  row.append(box, text);
  box.addEventListener('change', async () => {
    const want = box.checked;
    // Show what actually got saved, not what was clicked — a switch that lies
    // about a failed write is worse than one that refuses to move.
    try { box.checked = await onChange(want); } catch { box.checked = !want; }
  });
  return row;
}

/**
 * Ids people are actually likely to want, offered as suggestions.
 *
 * A suggestion list, never a closed set — the field takes anything that looks
 * like an id, because these change and a hard-coded dropdown would rot into a
 * list of models you can no longer pick. Each of these was checked against the
 * live API rather than remembered.
 */
const KNOWN_MODELS = {
  deepseek: [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    // Still accepted, and what older setups will have.
    'deepseek-chat',
    'deepseek-reasoner',
  ],
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
};
const KNOWN_VOICE_MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'];

/**
 * One overridable setting: what is in effect, and a field to change it.
 *
 * The placeholder is the LIVE default rather than invented text, so an empty
 * field reads as "whatever fren is already using" instead of "nothing". That is
 * the whole trick to making optional settings feel safe — you can always see
 * what you get by leaving it alone.
 */
function fieldRow(id, title, detail, value, placeholder, options, onSave) {
  const row = el('div', 'field-row');
  const head = el('label', 'field-head');
  head.setAttribute('for', id);
  head.append(el('strong', null, title), el('span', null, detail));

  const line = el('div', 'field-line');
  const input = el('input');
  input.type = 'text';
  input.id = id;
  input.value = value || '';
  input.placeholder = placeholder ? `${placeholder}  (in use now)` : 'using the default';
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (options && options.length) {
    const list = el('datalist');
    list.id = `${id}-list`;
    for (const o of options) list.appendChild(el('option', null, o));
    input.setAttribute('list', list.id);
    line.appendChild(list);
  }

  const state = el('span', 'field-state');
  const paint = (saved) => {
    // Show what was KEPT, not what was typed: a value fren rejected has to look
    // rejected, or you spend an evening wondering why nothing changed.
    input.value = saved || '';
    state.textContent = saved ? 'yours' : 'default';
    state.className = 'field-state' + (saved ? ' on' : '');
  };

  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    state.textContent = '…';
    try { paint(await onSave(input.value.trim())); }
    catch { state.textContent = 'could not save'; }
  };
  input.addEventListener('change', save);
  input.addEventListener('blur', save);

  const clear = el('button', 'field-clear', 'reset');
  clear.type = 'button';
  clear.title = 'Go back to the default';
  clear.addEventListener('click', async () => { input.value = ''; await save(); });

  line.append(input, state, clear);
  row.append(head, line);
  paint(value);
  return row;
}

/**
 * The two decisions fren makes on its own, in one place.
 *
 * Both govern behaviour rather than notes, which is why they are not in
 * SOUL.md: that file is read by the model, and neither of these is a matter of
 * interpretation. They are switches, and they should look like switches.
 */
const hex6 = (n) => '#' + Number(n).toString(16).padStart(6, '0');

/**
 * What colour fren is.
 *
 * Swatches show the actual base tone, so what you click is what you get. The
 * free picker is offered because six is not everyone's six — but it clamps,
 * and the note says why rather than silently correcting the choice: an orb
 * drained of colour would be indistinguishable from a sleeping one, and asleep
 * is how this app says it has stopped watching.
 */
async function colourPicker() {
  const P = window.FrenPalette;
  const wrap = el('div', 'setting-block');
  wrap.append(el('strong', null, 'What colour fren is'));

  let current = null;
  try { current = await window.fren.getOrbColour(); } catch { /* default */ }
  const active = current || P.DEFAULT_HEX;

  const row = el('div', 'swatches');
  const custom = el('input');

  const mark = (hex) => {
    for (const s of row.children) s.classList.toggle('on', Number(s.dataset.hex) === Number(hex));
    custom.value = hex6(P.usable(hex));
  };

  const choose = async (hex) => {
    const usable = P.usable(hex);
    mark(usable);
    try { await window.fren.setOrbColour(usable); } catch { /* it stays as it was */ }
  };

  for (const preset of P.PRESETS) {
    const tones = P.tonesFrom(preset.hex);
    const b = el('button', 'swatch');
    b.type = 'button';
    b.dataset.hex = String(preset.hex);
    b.title = preset.name + (preset.note ? ' — ' + preset.note : '');
    // The dot is the tone the orb will actually wear, lit the way it is lit.
    const dot = el('span', 'swatch-dot');
    dot.style.background =
      `radial-gradient(circle at 34% 30%, ${hex6(tones.excited.color)}, ${hex6(tones.base.color)} 62%)`;
    b.append(dot, el('span', 'swatch-name', preset.name));
    b.addEventListener('click', () => choose(preset.hex));
    row.appendChild(b);
  }
  wrap.appendChild(row);

  const customRow = el('label', 'custom-colour');
  custom.type = 'color';
  custom.addEventListener('change', () => {
    const n = parseInt(custom.value.replace('#', ''), 16);
    if (Number.isFinite(n)) choose(n);
  });
  customRow.append(custom, el('span', null, 'or pick your own'));
  wrap.appendChild(customRow);

  wrap.appendChild(el('p', 'caveat',
    'Very pale or very washed-out colours are nudged back into range. fren says it has '
    + 'stopped watching by draining its colour away, so an orb that already looked drained '
    + 'would have nothing left to say it with.'));

  mark(active);
  return wrap;
}

async function showSettings() {
  current = { kind: 'settings' };
  markActive();
  els.title.textContent = 'Settings';
  els.subtitle.textContent = 'What fren is allowed to do without being asked.';
  els.content.textContent = '';

  let profile = null;
  let wake = true;
  try { profile = await window.fren.getProfile(); } catch { /* never set up */ }
  try { wake = await window.fren.getWakeOnLaunch(); } catch { /* default */ }

  els.content.appendChild(switchRow(
    'set-wake',
    'Wake up when you launch me',
    ' My light comes on as soon as I open, which means I am watching. ' +
    'Turn this off and I will wait in the dark until you tap me.',
    wake,
    async (on) => (await window.fren.setWakeOnLaunch(on)).wakeOnLaunch,
  ));

  els.content.appendChild(switchRow(
    'set-volunteer',
    'Let me interrupt you',
    ' Every so often I ask about something you are working on, and keep what I ' +
    'learn in MEMORY.md. A few times a day at most.',
    profile && profile.volunteer,
    async (on) => {
      const res = await window.fren.setVolunteer(on);
      return !!(res && res.volunteer);
    },
  ));

  els.content.appendChild(await colourPicker());

  if (!profile) {
    els.content.appendChild(el('p', 'caveat',
      'You have not been through the introduction yet, so fren will not interrupt ' +
      'you whatever this says — it has not been invited.'));
  }

  await showProviderSettings();
}

/**
 * Which model thinks, which voice speaks, which ear listens.
 *
 * All of it optional. fren ships working, and every field here is empty until
 * someone wants something different — the placeholder shows what is running
 * right now, so leaving a field alone is a visible choice rather than a blank.
 */
async function showProviderSettings() {
  let cfg = null;
  try { cfg = await window.fren.getProviders(); } catch { /* below */ }
  if (!cfg) {
    els.content.appendChild(el('p', 'caveat', 'I could not read my own settings.'));
    return;
  }
  const live = cfg.inEffect || {};
  const set = async (patch) => window.fren.setProviders(patch);

  els.content.appendChild(el('h2', 'sec', 'The model that thinks'));
  if (!cfg.inEffect) {
    els.content.appendChild(el('p', 'caveat',
      'My thinking half is not answering right now, so I cannot show you what is ' +
      'in effect — but anything you set here will still be waiting when it is.'));
  }
  els.content.appendChild(fieldRow(
    'set-chat-model', 'Model',
    live.provider
      ? ` Whichever model ${live.provider} should answer with. Leave it empty and I use the one fren was started with.`
      : ' Whichever model your provider should answer with. Leave it empty for the default.',
    cfg.chosen.chatModel, live.model,
    KNOWN_MODELS[live.provider] || [],
    async (v) => (await set({ chatModel: v })).chatModel,
  ));

  els.content.appendChild(el('h2', 'sec', 'The voice that speaks'));
  if (!live.voice) {
    els.content.appendChild(el('p', 'caveat',
      'No voice is configured, so I answer in writing. These do nothing until one is.'));
  }
  els.content.appendChild(fieldRow(
    'set-voice-id', 'Voice',
    ' An ElevenLabs voice id. Copy it from the voice\u2019s page in their app \u2014 it is the long string in the URL, not the name.',
    cfg.chosen.voiceId, live.voiceId, [],
    async (v) => (await set({ voiceId: v })).voiceId,
  ));
  els.content.appendChild(fieldRow(
    'set-voice-model', 'Voice model',
    ' Flash is the quickest and the cheapest. Multilingual is worth it if you want me speaking something other than English.',
    cfg.chosen.voiceModel, live.voiceModel, KNOWN_VOICE_MODELS,
    async (v) => (await set({ voiceModel: v })).voiceModel,
  ));

  els.content.appendChild(el('h2', 'sec', 'The ear that listens'));
  const w = cfg.whisper || {};
  els.content.appendChild(el('p', 'caveat', w.ready
    ? 'Your microphone is transcribed here on this machine, by whisper.cpp. The audio never leaves it.'
    : `Speech to text is unavailable — ${w.reason || 'whisper.cpp was not found'}.`));
  els.content.appendChild(fieldRow(
    'set-whisper-lang', 'Language',
    ' Two letters, like es or fr. Empty means detect it, which is where short clips get names wrong.',
    cfg.chosen.whisperLang, 'auto', ['en', 'es', 'fr', 'de', 'it', 'pt'],
    async (v) => (await set({ whisperLang: v })).whisperLang,
  ));
  els.content.appendChild(fieldRow(
    'set-whisper-model', 'Model file',
    ' The full path to a ggml .bin model. A larger one hears better and thinks slower. Rejected unless the file is really there.',
    cfg.chosen.whisperModel, w.model || '', [],
    async (v) => (await set({ whisperModel: v })).whisperModel,
  ));

  const note = el('div', 'card');
  note.appendChild(el('div', 'card-head')).append(el('b', null, 'About keys'));
  note.appendChild(el('p', null,
    'API keys are not here on purpose. This window belongs to the part of fren ' +
    'that watches your screen, and that part deletes every provider key from its ' +
    'own environment when it starts \u2014 so there is nowhere here to put one, ' +
    'which is the point. Keys live in the .env file, which only the gateway reads. ' +
    'The same goes for provider addresses: where a key gets sent is not a setting.'));
  els.content.appendChild(note);
}

const SECTIONS = {
  patterns: showPatterns,
  automations: showAutomations,
  routines: showRoutines,
  memory: showMemory,
  settings: showSettings,
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
    const on = !!(state && state.observing);
    if (els.status) els.status.textContent = on ? 'watching' : 'paused';
    if (els.statusBtn) {
      els.statusBtn.setAttribute('aria-checked', on ? 'true' : 'false');
      els.statusBtn.title = on ? 'fren is watching — click to pause'
                               : 'fren is paused — click to start watching';
      els.statusBtn.setAttribute('aria-label',
        on ? 'Watching. Turn off to stop watching.' : 'Not watching. Turn on to start watching.');
    }
  };
  if (els.statusBtn) {
    els.statusBtn.addEventListener('click', async () => {
      try { paint(await window.fren.toggleObservation()); } catch { /* it stays as it was */ }
    });
  }
  window.fren.onStateChanged(paint);
  try { paint(await window.fren.getState()); } catch { /* leave it paused */ }

  await loadSidebar();

  await refreshCounts();
  await showDay(todayKey());
})();
