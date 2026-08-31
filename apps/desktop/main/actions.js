'use strict';
/**
 * Settings by conversation.
 *
 * The dashboard's switches did not go away — their DOORS did. Asking fren to
 * change something is now the way it changes: the chat model appends one
 * fenced action block to its reply when, and only when, the user asked for a
 * change, and this module is the customs post it clears. Parse the fence off
 * the text, check the action against a closed whitelist, normalize its
 * values, and hand back both — the clean text for the transcript and the
 * voice, the action for main to apply.
 *
 * Everything fails toward "no action": a malformed fence, an unknown verb, a
 * colour that is not a colour — the reply text survives, the action does not.
 * The model is never trusted with raw values; colours are resolved against
 * the palette and clamped by usable(), booleans are coerced, and nothing else
 * gets through at all. Pure, so the tests can hold every case.
 */
const palette = require('../renderer/face/palette.js');

// Anywhere in the reply, not only at the end. The prompt asks for the fence
// last, but a model that has just done something likes to add a word after —
// and an end-anchored match let the whole block leak into the transcript and
// the VOICE, which read the JSON aloud. One fence is parsed wherever it
// stands; two or more is not a conversation any more and refuses entirely.
const FENCE = /```fren-action\s*\n([\s\S]*?)\n?```/g;

/**
 * Face features are freer than the body: the body must never look drained
 * (usable() clamps it), but eyes can be white, black, or anything at all —
 * the glow ramp rebuilds around whatever hue arrives.
 */
const FACE_WORDS = {
  white: 0xffffff, black: 0x14110c, yellow: 0xffd34d, gold: 0xffc85a,
  orange: 0xff8a00, red: 0xe0342b, pink: 0xff6fa5, purple: 0xa259d9,
  violet: 0xa259d9, blue: 0x4a7fe0, teal: 0x11a8a8, cyan: 0x3fd2d2,
  green: 0x5aa838, cream: 0xf0e7d6,
};

function resolveFaceColour(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'default' || v === 'reset' || v === 'normal' || v === 'classic') return 0;
  const hex = v.match(/^#?([0-9a-f]{6})$/);
  if (hex) return parseInt(hex[1], 16);
  if (v in FACE_WORDS) return FACE_WORDS[v];
  const preset = palette.PRESETS.find((p) => p.id === v || p.name.toLowerCase() === v);
  return preset ? preset.hex : null;
}

/** Colour words people actually say, resolved before the preset list. */
const COLOUR_WORDS = {
  orange: 'ember', red: 'rhubarb', pink: 'rhubarb', purple: 'mulberry',
  violet: 'mulberry', blue: 'cornflower', teal: 'lagoon', cyan: 'lagoon',
  green: 'moss', default: 'ember', normal: 'ember',
};

function resolveColour(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  const hex = v.match(/^#?([0-9a-f]{6})$/);
  if (hex) return palette.usable(parseInt(hex[1], 16));
  const id = COLOUR_WORDS[v] || v;
  const preset = palette.PRESETS.find(
    (p) => p.id === id || p.name.toLowerCase() === id);
  return preset ? preset.hex : null;
}

/** One raw action object, vetted — or null. */
function vetAction(body) {
  if (!body || typeof body !== 'object') return null;
  switch (body.do) {
    case 'wakeOnLaunch':
    case 'interrupt':
    case 'watch':
      return { do: body.do, on: body.on === true || body.on === 'true' };
    case 'colour': {
      const hex = resolveColour(body.value);
      return hex === null ? null : { do: 'colour', hex };
    }
    case 'lookReset':
      return { do: 'lookReset' };
    case 'debugLog':
      return { do: 'debugLog' };
    case 'faceColour': {
      const part = body.part === 'eyes' || body.part === 'mouth' ? body.part : 'both';
      const hex = resolveFaceColour(body.value);
      return hex === null ? null : { do: 'faceColour', part, hex };
    }
    default:
      return null;
  }
}

/**
 * Split a model reply into what to SAY and what to DO.
 *
 * One request often carries two changes — "teal eyes and a pink mouth" — so
 * the fence may hold a single action object or an array of them. Each is
 * vetted alone; a bad one dies alone. At most four, because a reply claiming
 * more than four deeds is not a conversation any more.
 *
 * @returns {{ text: string, actions: object[] }}
 */
function parseReply(reply) {
  const raw = String(reply || '');
  const found = [...raw.matchAll(FENCE)];
  if (found.length === 0) return { text: raw.trim(), actions: [] };

  // The words survive with the fence stitched out, wherever it stood.
  const m = found[0];
  const text = (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ').trim();
  if (found.length > 1) return { text: raw.replace(FENCE, ' ').replace(/\s+/g, ' ').trim(), actions: [] };

  let body = null;
  try { body = JSON.parse(m[1]); } catch { return { text, actions: [] }; }
  const list = Array.isArray(body) ? body.slice(0, 4) : [body];
  return { text, actions: list.map(vetAction).filter(Boolean) };
}

// The prompt lines that teach the model these verbs live in
// packages/intelligence (CHAT_ACTIONS) — the prompt is built in the gateway's
// process, and a prompt promising verbs this parser refuses is the bug to
// make impossible: change one, change the other, and the parser tests below
// hold the shapes.
module.exports = { parseReply, resolveColour, resolveFaceColour };
