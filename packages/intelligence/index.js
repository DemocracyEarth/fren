'use strict';

// Prompt builders + parsers for fren's LLM calls. Pure functions only:
// no I/O, no network, no clock reads except the injectable `now`.
// The gateway decides HOW to call the model; this module decides WHAT to ask.

function pad2(n) {
  return String(n).padStart(2, '0');
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
  EXTRACT_SCHEMA,
};
