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
                            now = Date.now() } = {}) {
  const who = formatProfile(profile);
  const system = [
    'You are fren, a small quiet companion that lives on the desktop and watches only while its eyes are open.',
    'Answer ONLY from the observed context provided in the message; never invent activity that is not there.',
    'Be concise: 2-4 sentences is typical.',
    'If the context is insufficient or observation was off, say so plainly instead of guessing.',
    'No generic productivity advice.',
    // What the user told fren about themselves. It is context for TONE and for
    // what they care about -- it is not observed activity, and must never be
    // reported back as if fren had seen it.
    who ? `About the person you are talking to: ${who}` : '',
    who ? 'Use their name sparingly and naturally. Do not treat what they told you as something you observed.' : '',
  ].filter(Boolean).join(' ');
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
  required: ['interrupt', 'reason', 'confidence', 'message'],
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
  },
};

function buildPatternRequest({ memories = [] } = {}) {
  const system = [
    'You are the pattern detector for fren, an ambient desktop companion.',
    'Silence is the default: most activity is not worth interrupting for.',
    'Only flag genuinely repetitive, automatable workflows — the same manual sequence recurring across the summaries.',
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
};
