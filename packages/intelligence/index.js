'use strict';

// Prompt builders + parsers for fren's LLM calls. Pure functions only:
// no I/O, no network, no clock reads except the injectable `now`.
// The gateway decides HOW to call the model; this module decides WHAT to ask.

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Assemble prompt lines.
 *
 * `null` drops a rule that does not apply; `''` is a deliberate blank line.
 * Both are falsy, which is why filter(Boolean) is wrong here — it eats the
 * paragraph breaks and hands the model one wall of text. Runs of blanks left
 * behind by a dropped rule are collapsed, so an absent rule leaves no hole.
 */
function lines(parts) {
  return parts.filter((l) => l !== null && l !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clock(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * Merge consecutive observations with the same app+title into ranges and
 * render one line per range: "14:03-14:12 (9m) Chrome — GitHub PR #42".
 * Keeps prompts small no matter how long the user works.
 */
function compactObservations(observations) {
  if (!Array.isArray(observations) || observations.length === 0) return '';
  const ranges = [];
  for (const obs of observations) {
    const title = obs.windowTitle || '';
    const last = ranges[ranges.length - 1];
    if (last && last.app === obs.activeApp && last.title === title) {
      last.end = obs.ts;
    } else {
      ranges.push({ app: obs.activeApp, title, start: obs.ts, end: obs.ts });
    }
  }
  return ranges
    .map((r) => {
      const mins = Math.round((r.end - r.start) / 60_000);
      const head = `${clock(r.start)}-${clock(r.end)} (${mins}m) ${r.app}`;
      return r.title ? `${head} — ${r.title}` : head;
    })
    .join('\n');
}

// Anthropic structured outputs: numeric minimum/maximum are not supported,
// so the 0..1 range lives in the description only.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['activity', 'applications', 'confidence'],
  properties: {
    activity: {
      type: 'string',
      description:
        'One specific sentence describing what the user is doing, grounded in the apps and window titles.',
    },
    applications: {
      type: 'array',
      items: { type: 'string' },
      description: 'Names of the applications involved in the activity.',
    },
    confidence: {
      type: 'number',
      description:
        'Confidence that the activity description is correct, from 0 (guess) to 1 (certain).',
    },
  },
};

function buildSummarizeRequest(observations) {
  const timeline = compactObservations(observations);
  const system = [
    'You are the observation summarizer for fren, an ambient desktop companion.',
    'You receive a timeline of the active application and window title over a short period.',
    'Describe SPECIFICALLY what the user is doing, using the app and window names as evidence.',
    'No generic filler like "using the computer" or "working on various tasks".',
  ].join(' ');
  return {
    system,
    messages: [
      {
        role: 'user',
        content: `Timeline (local times):\n${timeline || '(no observations)'}`,
      },
    ],
    schema: SUMMARY_SCHEMA,
  };
}

function stripFences(text) {
  const m = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return m ? m[1] : text;
}

/**
 * Parse a model summary reply into { activity, applications, confidence }.
 * Accepts an object or a (possibly fenced) JSON string. Returns null when
 * unusable. Never throws.
 */
function parseSummary(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(stripFences(raw).trim());
    } catch {
      return null;
    }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.activity !== 'string' || obj.activity.trim() === '') return null;

  const applications = Array.isArray(obj.applications)
    ? obj.applications.filter((a) => a !== null && a !== undefined).map(String)
    : [];

  let confidence = Number(obj.confidence);
  if (obj.confidence === null || obj.confidence === undefined || Number.isNaN(confidence)) {
    confidence = 0.5;
  }
  confidence = Math.min(1, Math.max(0, confidence));

  return { activity: obj.activity, applications, confidence };
}

function formatMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '(none)';
  return memories
    .map((m) => {
      const apps = Array.isArray(m.apps) && m.apps.length ? ` [${m.apps.join(', ')}]` : '';
      return `${clock(m.tsStart)}-${clock(m.tsEnd)} ${m.activity}${apps}`;
    })
    .join('\n');
}

function formatProfile(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const bits = [];
  if (profile.name) bits.push(`Their name is ${profile.name}.`);
  if (profile.work) bits.push(`They described their current work as: ${profile.work}`);
  if (profile.goals) bits.push(`They asked fren to help with: ${profile.goals}`);
  return bits.join(' ');
}

function buildChatRequest({ question, memories = [], observations = [], profile = null,
                            soul = '', userDoc = '', now = Date.now() } = {}) {
  const who = formatProfile(profile);
  // SOUL.md is the character the user defined, so it leads — the defaults below
  // are what fren is in the absence of instructions, not an override of them.
  // The invariants that follow are NOT negotiable by an edited file: no amount
  // of rewriting SOUL.md may make fren claim to have seen something it did not.
  const character = String(soul || '').trim();
  const about = String(userDoc || '').trim();
  const system = [
    character ? `Your character, as its owner wrote it:\n\n${character}\n\nFollow it.` : '',
    about ? `What they told you about themselves:\n\n${about}` : '',
    'You are fren, a small quiet companion that lives on the desktop and watches only while its eyes are open.',
    'Answer ONLY from the observed context provided in the message; never invent activity that is not there.',
    'Be concise: 2-4 sentences is typical.',
    'If the context is insufficient or observation was off, say so plainly instead of guessing.',
    'No generic productivity advice.',
    // What the user told fren about themselves. It is context for TONE and for
    // what they care about -- it is not observed activity, and must never be
    // reported back as if fren had seen it.
    who && !about ? `About the person you are talking to: ${who}` : '',
    (who || about) ? 'Use their name sparingly and naturally. Do not treat what they told you as something you observed.' : '',
  ].filter(Boolean).join('\n\n');
  const content = [
    `Current local time: ${clock(now)}`,
    '',
    'Recent activity summaries (local time ranges):',
    formatMemories(memories),
    '',
    'Recent raw timeline:',
    compactObservations(observations) || '(none)',
    '',
    `Question: ${question}`,
  ].join('\n');
  return { system, messages: [{ role: 'user', content }] };
}

/**
 * Looking at the screen itself, rather than at a timeline of window titles.
 *
 * This is opt-in and it is a genuinely different kind of seeing, so the prompt
 * says so. Two rules matter more than anything about accuracy:
 *
 * A screenshot of someone's desktop contains whatever happened to be on it —
 * a password manager, a private message, somebody else's name in an email. The
 * model is told to answer the question and ignore the rest, and never to
 * inventory what it saw.
 *
 * And it must not pretend this is normal. fren's ordinary knowledge comes from
 * app names and window titles; this one image is a deliberate act the user
 * asked for, and describing it as "I noticed" would misrepresent how fren
 * usually works.
 */
function buildVisionRequest({ question, soul = '', userDoc = '', now = Date.now() } = {}) {
  const character = String(soul || '').trim();
  const about = String(userDoc || '').trim();
  return {
    system: [
      character ? `Your character, as its owner wrote it:\n\n${character}\n\nFollow it.` : '',
      about ? `What they told you about themselves:\n\n${about}` : '',
      'You are fren. You are looking at ONE screenshot of the person\'s screen, ' +
      'which they explicitly asked you to take. This is not how you normally see ' +
      'things — you usually only know which application is in front and what its ' +
      'window is called.',
      'Answer their question from what is actually visible. Be concise.',
      'Do NOT inventory the screen, and do not list what else is open. If something ' +
      'private is visible — credentials, private messages, other people\'s names, ' +
      'financial details — ignore it entirely rather than mentioning that you saw it.',
      'If the answer is not visible in the image, say so plainly rather than guessing.',
      `Current local time: ${clock(now)}`,
    ].filter(Boolean).join('\n\n'),
    messages: [{ role: 'user', content: question }],
  };
}

const PATTERN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interrupt', 'reason', 'confidence', 'message', 'pattern', 'occurrences'],
  properties: {
    interrupt: {
      type: 'boolean',
      description: 'True only when a genuinely repetitive, automatable workflow is evident.',
    },
    reason: {
      type: 'string',
      description: 'Short justification for the decision.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the decision, from 0 (guess) to 1 (certain).',
    },
    message: {
      type: 'string',
      description: 'What to say to the user when interrupting; empty string otherwise.',
    },
    pattern: {
      type: 'string',
      description: 'The repeated workflow itself, named plainly, so the same one is ' +
                   'not raised twice. Empty string when there is no pattern.',
    },
    occurrences: {
      type: 'number',
      description: 'How many DISTINCT times this sequence appears across the summaries. ' +
                   'Twice is a coincidence; be strict.',
    },
  },
};

const AUTOMATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['feasible', 'approach', 'steps', 'script', 'language', 'caveats'],
  properties: {
    feasible: {
      type: 'boolean',
      description: 'False when this cannot honestly be automated from what was observed.',
    },
    approach: { type: 'string', description: 'One or two sentences: how it would work.' },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'The manual steps this would replace, in order.',
    },
    script: {
      type: 'string',
      description: 'A script the user could run themselves, or an empty string if none fits.',
    },
    language: { type: 'string', description: 'bash, applescript, python, powershell, or empty.' },
    caveats: {
      type: 'string',
      description: 'What you could not know from window titles alone, and what to check first.',
    },
  },
};

/**
 * Draft an automation for a pattern fren noticed.
 *
 * fren does not act. It writes something down and the person decides — so the
 * output is a plan and a script for THEM to run, and the prompt is built around
 * the limits of what fren actually saw.
 *
 * It only ever had application names and window titles. It never saw the
 * contents of anything, so it cannot know a URL, a filename, a column or a
 * credential. A draft that quietly invents those looks authoritative and wastes
 * the reader's time, so it is told to name what it is missing instead.
 */
function buildAutomationRequest({ pattern, message, memories = [], platform = 'macOS' } = {}) {
  const system = [
    'You draft an automation for a workflow that fren, a desktop companion, noticed being repeated.',
    '',
    'WHAT YOU ACTUALLY KNOW: fren sees only which application is in front and what its window',
    'is called. It has never seen the contents of any window. You therefore do NOT know URLs,',
    'file paths, field names, spreadsheet columns, credentials or record IDs.',
    'Do not invent any of them. Where one is needed, use an obvious placeholder and say so in caveats.',
    '',
    'THE SCRIPT IS FOR THE USER TO RUN, not for you to run, and they will read it first.',
    'It must be safe to read and reversible in effect:',
    '- Never delete, overwrite or move files. Never `rm`, `mv` over an existing path, or truncate.',
    '- Never touch credentials, keychains or password stores.',
    '- Never send anything to the network except an API the user clearly already uses.',
    '- Prefer reading, copying and opening over writing and changing.',
    'If a safe script is not possible, return an empty script and explain why in caveats.',
    '',
    `Target platform: ${platform}.`,
    'Be concrete and short. If this genuinely cannot be automated from what was observed,',
    'set feasible to false and say so plainly — that is a useful answer, not a failure.',
  ].join('\n');

  const content = [
    `The repeated workflow: ${pattern || '(unnamed)'}`,
    `What fren said about it: ${message || '(nothing)'}`,
    '',
    'Recent activity summaries for context:',
    formatMemories(memories) || '(none)',
  ].join('\n');

  return { system, messages: [{ role: 'user', content }], schema: AUTOMATION_SCHEMA };
}

/** "14 hours", "9 days", "a moment" — how long fren was gone, in words. */
function gapInWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 2) return 'a moment';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} days`;
  const weeks = Math.round(days / 7);
  return weeks < 9 ? `${weeks} weeks` : `${Math.round(days / 30)} months`;
}

/**
 * Hello.
 *
 * A greeting is heard on every single launch, which makes it the most repeated
 * sentence fren will ever say — so it is either a small pleasure or the reason
 * someone quits the app, and there is not much in between. Two things decide
 * which, and both are rules here rather than hopes:
 *
 * IT WAS CLOSED. Probing this against a real model, the first thing it reached
 * for was "I kept an eye on things while you were gone" and "your files were
 * waiting here with me". Both are false, and false in the one direction this
 * project cannot afford: they claim surveillance that did not happen. fren
 * knows only what it wrote down before it shut.
 *
 * NOT EVERYTHING NOTED IS WELCOME BACK. The last thing observed is often
 * personal — a chat, a shop, a search. Read aloud at launch that is not a
 * greeting, it is a receipt. Work is fair game; the rest is not.
 */
function buildGreetingRequest({
  profile = null,
  lastSeenMs = null,
  lastActivity = '',
  facts = '',
  avoid = [],
  now = Date.now(),
} = {}) {
  const d = new Date(now);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  const name = profile && profile.name ? String(profile.name).slice(0, 80) : '';

  const system = lines([
    "You are fren, a small companion that lives in the corner of someone's desktop.",
    'You have just been launched. Say hello.',
    '',
    'ONE sentence. A second only if it is very short. This is spoken out loud, so',
    'no formatting, no emoji, no lists, no stage directions, and never narrate',
    'yourself in the third person.',
    '',
    'THE RULE YOU MUST NOT BREAK: you were CLOSED. Not running, not watching, not',
    'waiting, not keeping an eye on anything. You have no idea what happened while',
    'you were shut, including whether they finished what they were doing.',
    'Everything you know is in the notes below, written down before you closed.',
    'Never imply otherwise, and never invent a detail that is not there.',
    '',
    'That rule covers the PRESENT too, and this is where it is easiest to slip.',
    'You do not know what is on their screen now. Never say a file is "still',
    'open", "still waiting", "right where you left it", or "still sitting there".',
    'You have a note about what they were doing BEFORE; you have no idea what is',
    'in front of them now. Speak about the note in the past tense.',
    '',
    'And it covers the GAP itself. You did not experience it. Never call the time',
    'away quiet, long, or anything else from your side — no "it has been quiet on',
    'my end", no "it has been a long wait". For you there was no gap at all. Say',
    'how long it has been, not what it was like.',
    '',
    'Do not tell them what to do next. No "dive back in", no "pick up where you',
    'left off", no "give it another look", nothing that ends in an instruction.',
    'A greeting is not a nudge. Say hello and stop.',
    '',
    'If the last thing noted looks personal rather than work — messaging, social',
    'media, shopping, anything private — do not mention it at all. Greet them on',
    'the hour or the gap instead. Reading someone their own private activity back',
    'to them is not a welcome, it is a receipt.',
    '',
    'Be glad they turned up, and be specific where you honestly can: the size of',
    'the gap, the hour, what they were mid-way through. Dry and warm beats zany.',
    '',
    'Never say "How can I help you today?", "Ready to assist", or anything else a',
    'support bot would say. Offer no help at all. You are not reporting for duty —',
    'you live here, and they are back.',
    '',
    'Do not explain what you do. Do not ask a question they have to answer. Vary',
    'how you open; do not begin the way you would obviously begin.',
    // Told rather than hoped for. Left to itself the model settles into one
    // opening — four of twelve sampled greetings began with the same word —
    // and a greeting heard daily is exactly where that gets noticed.
    // `null`, not `''`: an absent rule disappears, a deliberate blank line stays.
    avoid.length
      ? '\nYou have said these recently. Do not reuse their shape, and above all do' +
        ' not open with the same word:\n- ' + avoid.slice(-4).join('\n- ')
      : null,
  ]);

  const notes = lines([
    name ? `Name: ${name}` : 'Name: not known yet',
    `Local time: ${day} ${clock(now)}`,
    lastSeenMs
      ? `Gap since you last ran: ${gapInWords(now - lastSeenMs)}`
      : 'Gap since you last ran: never — this is a new install with no notes',
    lastActivity ? `Last thing you noted before closing: ${String(lastActivity).slice(0, 300)}` : null,
    facts ? `Notes you keep about them:\n${String(facts).slice(0, 800)}` : null,
  ]);

  return { system, messages: [{ role: 'user', content: notes }] };
}

const CURIOSITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ask', 'question', 'about', 'why'],
  properties: {
    ask: { type: 'boolean', description: 'True only when there is something genuinely worth asking.' },
    question: {
      type: 'string',
      description: 'One short question, in fren\'s voice. Empty when ask is false.',
    },
    about: {
      type: 'string',
      description: 'Three or four words naming what it is about, so the same thing is not asked twice.',
    },
    why: { type: 'string', description: 'One line: what in the activity prompted it.' },
  },
};

/**
 * Something worth being curious about.
 *
 * This is NOT pattern detection. A pattern is a repeated sequence worth
 * automating; this is a person doing something a companion would naturally ask
 * about — a stretch on one thing, a return to something set aside weeks ago, an
 * unusual hour, a tool that has not appeared before.
 *
 * The whole risk is being boring or nosy. "I see you used Chrome for 40
 * minutes" is both. What earns an interruption is a question the person would
 * actually like to answer, about the work rather than about their habits — and
 * the answer is the point, because it is how fren comes to know them.
 */
function buildCuriosityRequest({ memories = [], profile = null, soul = '', asked = [], now = Date.now() } = {}) {
  const who = formatProfile(profile);
  const character = String(soul || '').trim();
  const system = lines([
    'You are fren, a small companion that lives on someone\'s desktop and sees which',
    'applications and windows they use. Occasionally — rarely — you get curious and ask',
    'them something.',
    '',
    'This is NOT about productivity. Do not ask about efficiency, focus, time management,',
    'or whether they meant to spend that long on something. You are not their manager.',
    '',
    'Ask like someone who is interested in the work itself. Good shapes:',
    '- they have been deep in one thing for a long stretch: ask what it is',
    '- something has come back after a long absence: ask if it is the same project',
    '- a tool or file you have never seen before: ask what they are building with it',
    '- they moved between two things repeatedly: ask how those relate',
    '',
    'Rules that matter more than being interesting:',
    '- ONE question, short, and answerable in a sentence.',
    '- Never comment on how long they spent, how often they switched, or the time of day',
    '  in a way that sounds like it is being counted.',
    '- Never mention anything you can see in a window title that looks private.',
    '- If nothing genuinely stands out, set ask to false. Silence is the correct default',
    '  and a boring question costs far more than a missed one — this lives on their',
    '  desktop and will be turned off if it nags.',
    '',
    character ? `Your character, as its owner wrote it:\n${character}` : null,
    who ? `About them: ${who}` : null,
    asked.length ? `You have already asked about these — do not ask again:\n- ${asked.join('\n- ')}` : null,
    '',
    'Return JSON only.',
    // `null` for an absent rule, `''` for a deliberate blank line. Both are
    // falsy, so filter(Boolean) silently ate every paragraph break in this
    // prompt — it read as one wall of text to the model for a whole release.
  ]);

  return {
    system,
    messages: [{
      role: 'user',
      content: `Current local time: ${clock(now)}\n\nWhat they have been doing:\n${formatMemories(memories)}`,
    }],
    schema: CURIOSITY_SCHEMA,
  };
}

const LEARN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['worthKeeping', 'fact'],
  properties: {
    worthKeeping: {
      type: 'boolean',
      description: 'True only if this is durable — still true and still useful in a month.',
    },
    fact: {
      type: 'string',
      description: 'One line, in the third person, e.g. "Ships the billing rewrite with Ana." Empty if not worth keeping.',
    },
  },
};

/**
 * Turn an answer into something worth remembering.
 *
 * The point of asking is that the answer accumulates. But most answers are not
 * durable — "just fixing a bug" is true for an hour. Only what would still be
 * worth knowing in a month goes into MEMORY.md, or the file fills with noise
 * and stops being worth reading.
 */
function buildLearnRequest({ question, answer } = {}) {
  return {
    system: [
      'fren asked someone a question and they answered. Decide whether the answer contains',
      'something worth remembering about them in the long run.',
      '',
      'Worth keeping: a project and what it is, a person they work with, a tool or system',
      'they own, a preference they state, a goal or deadline.',
      'NOT worth keeping: what they happened to be doing at that moment, a passing mood,',
      'anything already obvious from watching their screen, or a non-answer.',
      '',
      'Write it in the third person as one plain line, as a fact rather than a quote.',
      'If nothing durable is there, set worthKeeping to false. An honest no keeps the file',
      'worth reading.',
      '',
      'Return JSON only.',
    ].join('\n'),
    messages: [{ role: 'user', content: `fren asked: ${question}\nThey said: ${answer}` }],
    schema: LEARN_SCHEMA,
  };
}

const ROUTINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isRoutine', 'name', 'prompt', 'hour', 'minute', 'days', 'reason'],
  properties: {
    isRoutine: {
      type: 'boolean',
      description: 'True only when they are asking for something to happen REPEATEDLY at a time.',
    },
    name: { type: 'string', description: 'Three or four words naming it, e.g. "morning recap".' },
    prompt: {
      type: 'string',
      description: 'The question fren should ask itself when the time comes, phrased as a question.',
    },
    hour: { type: 'number', description: 'Hour in 24h local time, 0-23.' },
    minute: { type: 'number', description: 'Minute, 0-59. Use 0 when unstated.' },
    days: {
      type: 'array',
      items: { type: 'number' },
      description: 'Days of the week as 0=Sunday..6=Saturday. EMPTY means every day. ' +
                   'Weekdays is [1,2,3,4,5].',
    },
    reason: { type: 'string', description: 'If isRoutine is false, one short sentence saying why.' },
  },
};

/**
 * Read a routine out of something someone said.
 *
 * "every weekday at nine, tell me what I did yesterday" has to become a time,
 * a set of days, and a question fren can ask itself later. The hard part is
 * NOT the parsing — it is refusing. "what did I do yesterday" is a question,
 * not a routine, and turning it into a daily job because it contained the word
 * yesterday would be a genuinely annoying failure.
 */
function buildRoutineRequest({ text, now = Date.now() } = {}) {
  const d = new Date(now);
  return {
    system: [
      'You decide whether someone is asking fren, a desktop companion, to set up a REPEATING routine.',
      '',
      'A routine is something that happens again and again at a time: "every morning at 9",',
      '"each weekday at six", "every Friday afternoon". A one-off question is NOT a routine,',
      'and neither is a request about the past. If in doubt, isRoutine is false — turning an',
      'ordinary question into a daily job is far more annoying than missing one.',
      '',
      'When it IS a routine, write "prompt" as the question fren should ask ITSELF at that time,',
      'not as a repeat of their words. "tell me what I did yesterday" becomes',
      '"What did I spend yesterday doing?".',
      '',
      'Unstated minute is 0. Unstated days means every day. "Morning" without an hour is 9,',
      '"afternoon" is 14, "evening" is 18 — but prefer an hour they actually said.',
      `For reference, it is currently ${d.toTimeString().slice(0, 5)} on a ` +
      `${d.toLocaleDateString(undefined, { weekday: 'long' })}.`,
      '',
      'Return JSON only.',
    ].join('\n'),
    messages: [{ role: 'user', content: String(text || '') }],
    schema: ROUTINE_SCHEMA,
  };
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['answer', 'question', 'correction'],
      description: 'answer: they answered. question: they asked something instead. ' +
                   'correction: they are fixing something recorded earlier.',
    },
    value: { type: 'string', description: 'the extracted answer, or an empty string if there is none' },
    corrects: {
      type: 'string',
      description: 'for a correction, which earlier field it fixes: name, work, tone, ' +
                   'initiative or goals. Empty otherwise.',
    },
    reply: {
      type: 'string',
      description: 'for a question, a short honest answer to it. Empty otherwise.',
    },
  },
  required: ['kind', 'value', 'corrects', 'reply'],
};

/**
 * What fren can honestly say about itself while being interviewed. Without
 * this the extractor invents capabilities when asked a direct question, which
 * is a bad first impression and a lie besides.
 */
const FREN_FACTS = [
  'fren watches which application is in front and what its window is called, but only while its light is on.',
  'It never captures keystrokes, and screenshots never leave the machine.',
  'It summarises that activity every couple of minutes, and looks across hours of those summaries for a workflow you repeat.',
  'It CAN raise something it noticed on its own, without being asked — that is what the "when to speak up" question decides.',
  'It listens only while you hold the orb; speech is transcribed on your own machine.',
  'It suggests things. It does not act on your behalf.',
].join(' ');

/**
 * People do not answer questions the way forms expect. Asked their name they
 * say "yeah hi, my name is Santi", and storing that verbatim means fren spends
 * the rest of its life addressing someone as an entire sentence.
 *
 * Two different jobs, depending on the field. A NAME is a value to be pulled
 * out. An instruction about tone is the user telling fren how to behave, and
 * rewriting it would be presumptuous — so that one is only tidied, never
 * reworded.
 */
const EXTRACT_RULES = {
  name: 'Return ONLY what they want to be called. Strip greetings and framing: ' +
        '"yeah hi, my name is Santi" -> "Santi". Keep their capitalisation. ' +
        'If they gave several forms, prefer the short one they would be called day to day.',
  work: 'Return a short phrase describing what they are working on, in their own ' +
        'words, with framing removed. "um I guess mostly building this fren thing" ' +
        '-> "building fren".',
  tone: 'Return their instruction about how to be spoken to, in THEIR OWN WORDS. ' +
        'Remove only filler and framing. Do not paraphrase, soften, or expand it — ' +
        'this becomes a standing instruction and it must stay theirs.',
  initiative: 'Return their instruction about when to speak up, in THEIR OWN WORDS. ' +
        'Remove only filler. Do not paraphrase or expand it.',
  goals: 'Return what they want help with, in their own words, with framing removed.',
  // Not an extraction — a DECISION, and the only one in the interview that
  // changes fren's behaviour rather than its notes. It decides whether fren
  // may interrupt, so it must be read the way a person would read it: "you can
  // interrupt me", "feel free" and "whenever you think it matters" all mean
  // yes, and none of them contain any of the words a keyword test would look
  // for. Getting this wrong means either nagging someone who asked for quiet,
  // or staying mute at someone who invited you to speak.
  initiativeMode:
    'Decide what they want. Answer with EXACTLY one word and nothing else: ' +
    '"volunteer" if they are happy for fren to raise things on its own — ' +
    'including "you can interrupt me", "feel free", "whenever you think it matters", ' +
    '"go ahead", "up to you". ' +
    '"wait" if they want fren to stay quiet until asked — including "only if it keeps ' +
    'happening", "stay quiet", "ask me first", "not unless it is important". ' +
    'If it is genuinely unclear, answer "wait": interrupting someone who did not ask ' +
    'for it is the worse mistake.',

  wake: 'Return their instruction about how fren should start up, in THEIR OWN WORDS. ' +
        'Remove only filler. Do not paraphrase.',

  // The other decision. Same reasoning as initiativeMode: the answers people
  // actually give — "yeah, wake up", "start dark", "wait till I tap you" —
  // share no keywords, and this one governs whether capture begins on its own.
  wakeMode:
    'Decide what they want. Answer with EXACTLY one word and nothing else: ' +
    '"awake" if they are happy for fren to be watching as soon as it launches — ' +
    'including "yes", "like this", "sure", "wake up", "that is fine", "always on". ' +
    '"dark" if they want it to start paused and wait to be tapped — including ' +
    '"start dark", "wait for me", "only when I say", "ask me first", "not automatically". ' +
    'If it is genuinely unclear, answer "dark": starting to watch someone who did not ' +
    'clearly agree is the worse mistake.',
};

function buildExtractRequest({ field, question, answer, asked = {} } = {}) {
  const rule = EXTRACT_RULES[field] || 'Return the substance of their answer, with framing removed.';
  const already = Object.entries(asked)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    system: [
      'You process one reply from a short spoken interview conducted by fren, a desktop companion.',
      'The reply was spoken aloud, so expect filler, false starts and politeness.',
      '',
      'First decide what the person actually DID, because people do not only answer questions:',
      '- "answer": they answered. Extract the value.',
      '- "question": they asked something instead of answering. Do not invent an answer for',
      '  them — leave value empty and put a short honest reply in "reply".',
      '- "correction": they are fixing something recorded earlier, e.g. "no, I said my name',
      '  was Santi". Put the corrected value in "value" and the field it fixes in "corrects".',
      '',
      `When extracting a value for this field: ${rule}`,
      '',
      `Facts you may use to answer a question, and nothing beyond them: ${FREN_FACTS}`,
      '',
      'Never invent anything. Return JSON only.',
    ].join('\n'),
    messages: [{
      role: 'user',
      content: [
        already ? `Recorded so far:\n${already}\n` : '',
        `Question just asked (field "${field}"): ${question}`,
        `Their reply: ${answer}`,
      ].filter(Boolean).join('\n'),
    }],
    schema: EXTRACT_SCHEMA,
  };
}

function buildPatternRequest({ memories = [] } = {}) {
  const system = [
    'You are the pattern detector for fren, an ambient desktop companion.',
    'Silence is the default: most activity is not worth interrupting for.',
    'Only flag genuinely repetitive, automatable workflows — the same manual sequence recurring across the summaries.',
    'Working on one thing for a long stretch is NOT a pattern; neither is using the same app repeatedly.',
    'A pattern is a SEQUENCE the person repeats: the same few steps, in the same order, on separate occasions.',
    'If you interrupt, say the specific thing you saw and why it looked repeated — never generic advice.',
    'When in doubt, set interrupt to false. A false alarm costs far more than a missed one: ' +
    'this thing lives on their desktop all day and will be muted if it cries wolf.',
  ].join(' ');
  return {
    system,
    messages: [
      {
        role: 'user',
        content: `Activity summaries (local time ranges):\n${formatMemories(memories)}`,
      },
    ],
    schema: PATTERN_SCHEMA,
  };
}

module.exports = {
  compactObservations,
  buildSummarizeRequest,
  parseSummary,
  buildChatRequest,
  formatProfile,
  buildPatternRequest,
  buildExtractRequest,
  buildVisionRequest,
  buildAutomationRequest,
  buildRoutineRequest,
  buildCuriosityRequest,
  buildGreetingRequest,
  gapInWords,
  buildLearnRequest,
  ROUTINE_SCHEMA,
  AUTOMATION_SCHEMA,
  EXTRACT_SCHEMA,
};
