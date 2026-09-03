'use strict';
/**
 * Five-field cron, the dialect automations are scheduled in.
 *
 *   ┌───────── minute        0-59
 *   │ ┌─────── hour          0-23
 *   │ │ ┌───── day of month  1-31
 *   │ │ │ ┌─── month         1-12 (or jan..dec)
 *   │ │ │ │ ┌─ day of week   0-7  (0 and 7 are Sunday; or sun..sat)
 *   * * * * *
 *
 * Each field is `*`, a number, a range `a-b`, a list `a,b,c`, or any of those
 * with a step `/n`. When BOTH day fields are restricted the classic rule
 * applies: the job runs when either matches. That is the behaviour every cron
 * a user has met; deviating from it would be a surprise dressed up as a fix.
 *
 * Times are local to this machine, which is the user's clock. The runtime
 * that eventually fires the schedule applies the same expression in the same
 * zone (see docs/runtime-architecture.md §8.3), so "9 in the morning" means
 * the same thing in the list and in the timer.
 *
 * No dependency: the parser is small, and pulling a library in for five
 * fields would be the first runtime dependency the shared package has.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'weekday', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function bad(expr, why) {
  const err = new Error(`invalid cron "${expr}": ${why}`);
  err.code = 'INVALID_CRON';
  return err;
}

function parseNumber(token, field, expr) {
  const t = token.toLowerCase();
  if (field.names) {
    const i = field.names.indexOf(t);
    if (i >= 0) return i + field.nameBase;
  }
  if (!/^\d+$/.test(t)) throw bad(expr, `"${token}" is not a number in ${field.name}`);
  return Number(t);
}

/** One field -> { any: boolean, set: Set<number> }. */
function parseField(text, field, expr) {
  const set = new Set();
  let any = false;
  for (const part of text.split(',')) {
    if (!part) throw bad(expr, `empty item in ${field.name}`);
    const [rangeText, stepText] = part.split('/');
    if (part.split('/').length > 2) throw bad(expr, `too many "/" in ${field.name}`);
    let lo;
    let hi;
    if (rangeText === '*') {
      lo = field.min;
      hi = field.max;
      if (stepText === undefined) any = true;
    } else if (rangeText.includes('-')) {
      const ends = rangeText.split('-');
      if (ends.length !== 2) throw bad(expr, `malformed range "${rangeText}" in ${field.name}`);
      const [a, b] = ends;
      lo = parseNumber(a, field, expr);
      hi = parseNumber(b, field, expr);
      if (lo > hi) throw bad(expr, `range ${rangeText} runs backwards in ${field.name}`);
    } else {
      lo = parseNumber(rangeText, field, expr);
      hi = stepText === undefined ? lo : field.max;
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw bad(expr, `bad step "${stepText}" in ${field.name}`);
    if (lo < field.min || hi > field.max) {
      throw bad(expr, `${field.name} must be within ${field.min}-${field.max}`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (field.name === 'weekday' && set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  return { any, set };
}

/**
 * Parse an expression into a matcher. Throws with code INVALID_CRON when the
 * text is not five well-formed fields, so callers can turn it into a
 * validation message rather than a crash.
 */
function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw bad(expr, `expected 5 fields, got ${fields.length}`);
  const [minute, hour, day, month, weekday] = fields.map((f, i) => parseField(f, FIELDS[i], expr));
  return { expr: fields.join(' '), minute, hour, day, month, weekday };
}

function dayMatches(parsed, d) {
  const domOk = parsed.day.set.has(d.getDate());
  const dowOk = parsed.weekday.set.has(d.getDay());
  if (parsed.day.any && parsed.weekday.any) return true;
  if (parsed.day.any) return dowOk;
  if (parsed.weekday.any) return domOk;
  return domOk || dowOk; // both restricted: either, as cron has always done
}

/**
 * The next time the expression matches, strictly after `fromMs`, in local
 * time. Returns null when nothing matches within four years (a February 30th
 * kind of expression), rather than looping forever.
 */
function nextCron(expr, fromMs = Date.now()) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = fromMs + 4 * 366 * 24 * 3600 * 1000;
  // Skip whole units at a time: months, then days, then hours, then minutes.
  while (d.getTime() <= limit) {
    if (!parsed.month.set.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(parsed, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.set.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.set.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return null;
}

/** How many times a day this can fire at most, for the fire-limit check. */
function firesPerDay(expr) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  return parsed.minute.set.size * parsed.hour.set.size;
}

/**
 * A short human description for the common shapes, and the raw expression
 * for anything else. The interface shows this next to an automation.
 */
function describeCron(expr) {
  let parsed;
  try {
    parsed = parseCron(expr);
  } catch {
    return String(expr || '');
  }
  const single = (f) => (f.set.size === 1 ? [...f.set][0] : null);
  const h = single(parsed.hour);
  const m = single(parsed.minute);
  if (h === null || m === null) return parsed.expr;
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (parsed.day.any && parsed.month.any) {
    if (parsed.weekday.any) return `every day at ${time}`;
    const days = [...parsed.weekday.set].sort();
    if (days.join(',') === '1,2,3,4,5') return `weekdays at ${time}`;
    if (days.join(',') === '0,6') return `weekends at ${time}`;
    const names = days.map((x) => DAYS[x][0].toUpperCase() + DAYS[x].slice(1));
    return `${names.join(', ')} at ${time}`;
  }
  return `${parsed.expr} (${time})`;
}

/** "today at 15:00", "tomorrow at 09:30", "on Friday at 18:00", "on 12 Sep at 10:00". */
function describeAt(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(today)) / 86400000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (days > 1 && days < 7) return `on ${DAY_NAMES[d.getDay()]} at ${time}`;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `on ${d.getDate()} ${MONTHS[d.getMonth()]} at ${time}`;
}

/** "whenever you open Figma", "whenever you are on github.com". */
function describeEvent(filter) {
  const f = filter || {};
  if (f.app) return `whenever you open ${f.app}`;
  if (f.site) return `whenever you are on ${f.site}`;
  return 'when something happens';
}

/** One line for any trigger the Automation model has. */
function describeTrigger(trigger, now = Date.now()) {
  const t = trigger || {};
  if (t.type === 'schedule') return describeCron(t.cron);
  if (t.type === 'at') return describeAt(t.at, now);
  if (t.type === 'event') return describeEvent(t.filter);
  return String(t.type || '');
}

module.exports = { parseCron, nextCron, firesPerDay, describeCron, describeAt, describeEvent, describeTrigger };
