'use strict';
/**
 * fren's soul: plain Markdown files on disk that survive the database.
 *
 * The split follows OpenClaw's, because it draws the right line — identity is
 * not the same thing as facts about the user, and neither is the same thing as
 * what was observed:
 *
 *   SOUL.md    who fren is: tone, boundaries, how it collaborates. Written from
 *              the first-run interview, so the user defines the character
 *              rather than inheriting one.
 *   USER.md    who the user is: name, work, what they want help with.
 *   MEMORY.md  curated durable facts, and an index of the daily logs.
 *   memory/YYYY-MM-DD.md   what fren observed that day, appended as it goes.
 *
 * Markdown rather than rows in the database, for one reason: the user can open
 * these, read exactly what fren believes about them, edit it, and delete it. A
 * companion that has formed opinions about you in a binary file you cannot read
 * is a worse thing than one that has not formed any.
 *
 * Nothing here touches the network.
 */
const fs = require('node:fs');
const path = require('node:path');

const FILES = { soul: 'SOUL.md', user: 'USER.md', memory: 'MEMORY.md', logs: 'memory' };

function paths(dir) {
  return {
    soul: path.join(dir, FILES.soul),
    user: path.join(dir, FILES.user),
    memory: path.join(dir, FILES.memory),
    logs: path.join(dir, FILES.logs),
  };
}

const stamp = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Keep a user's own words out of Markdown structure. */
function clean(text, max = 600) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/^#+\s*/gm, '')      // no injected headings
    .trim()
    .slice(0, max);
}

/**
 * Turn the interview answers into fren's character.
 *
 * The tone and initiative answers become RULES rather than notes, because they
 * are instructions the user gave about how to be treated, and the model should
 * read them as binding.
 */
function renderSoul(a, now = Date.now()) {
  const tone = clean(a.tone);
  const initiative = clean(a.initiative);
  return `# SOUL

Who fren is. Written from the first conversation with ${clean(a.name, 80) || 'the user'} on ${stamp(now)}.
Edit this file freely — it is read at the start of every conversation, and
whatever it says here is what fren tries to be.

## Character

fren is a small companion that lives on the desktop. It watches only while its
light is on, it says what it actually noticed rather than what sounds useful,
and it would rather say "I don't know" than fill the silence.

## How to talk to ${clean(a.name, 80) || 'them'}

${tone ? `> ${tone}\n\n_Their words. Follow them._` : '_Not specified. Default to brief and plain._'}

## When to speak up

${initiative ? `> ${initiative}\n\n_Their words. Follow them._` : '_Not specified. Default to staying quiet unless asked._'}

## Boundaries

- Never claim to have seen something that is not in the observed context.
- Never imply the light was on when it was off.
- Do not give generic productivity advice. If there is nothing worth saying,
  say nothing.
`;
}

function renderUser(a, now = Date.now()) {
  const rows = [
    ['Name', clean(a.name, 80)],
    ['Working on', clean(a.work)],
    ['Wants help with', clean(a.goals)],
  ].filter(([, v]) => v);
  return `# USER

What ${clean(a.name, 80) || 'the user'} told fren about themselves on ${stamp(now)}.
This is what they SAID, not what fren observed — the two are kept apart on
purpose, and fren must never report one as the other.

${rows.map(([k, v]) => `**${k}:** ${v}`).join('\n\n') || '_Nothing recorded._'}
`;
}

function renderMemoryIndex(now = Date.now()) {
  return `# MEMORY

Durable facts worth keeping, and an index of the daily logs in \`memory/\`.
Started ${stamp(now)}.

Daily logs hold what fren observed. This file holds what turned out to matter.

## Facts

_Nothing yet._

## Days

_See \`memory/\` — one file per day._
`;
}

/** Write the soul files. Called once, when the interview finishes. */
function writeSoul(dir, answers, now = Date.now()) {
  const p = paths(dir);
  fs.mkdirSync(p.logs, { recursive: true });
  fs.writeFileSync(p.soul, renderSoul(answers, now), 'utf8');
  fs.writeFileSync(p.user, renderUser(answers, now), 'utf8');
  if (!fs.existsSync(p.memory)) fs.writeFileSync(p.memory, renderMemoryIndex(now), 'utf8');
  return p;
}

/**
 * The character and the user, as text for the prompt. Read fresh every time so
 * that editing SOUL.md takes effect on the next message rather than the next
 * launch — that is most of what makes the file worth having.
 */
function readContext(dir) {
  const p = paths(dir);
  const read = (f) => {
    try { return fs.readFileSync(f, 'utf8').slice(0, 4000); } catch { return ''; }
  };
  return { soul: read(p.soul), user: read(p.user) };
}

/** Append one observed line to today's log. */
function appendDailyLog(dir, text, now = Date.now()) {
  const p = paths(dir);
  fs.mkdirSync(p.logs, { recursive: true });
  const file = path.join(p.logs, `${stamp(now)}.md`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${stamp(now)}\n\nWhat fren observed. Local times.\n\n`, 'utf8');
  }
  const time = new Date(now).toTimeString().slice(0, 5);
  fs.appendFileSync(file, `- **${time}** ${clean(text, 400)}\n`, 'utf8');
  return file;
}

function hasSoul(dir) {
  try { return fs.statSync(paths(dir).soul).size > 0; } catch { return false; }
}

module.exports = {
  paths, writeSoul, readContext, appendDailyLog, hasSoul,
  renderSoul, renderUser, renderMemoryIndex, FILES,
};
