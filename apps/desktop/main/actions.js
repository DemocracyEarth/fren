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

const FENCE = /```fren-action\s*\n([\s\S]*?)\n?```\s*$/;

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

/**
 * Split a model reply into what to SAY and what to DO.
 * @returns {{ text: string, action: object|null }}
 */
function parseReply(reply) {
  const raw = String(reply || '');
  const m = raw.match(FENCE);
  if (!m) return { text: raw.trim(), action: null };
  const text = raw.slice(0, m.index).trim();

  let body = null;
  try { body = JSON.parse(m[1]); } catch { return { text, action: null }; }
  if (!body || typeof body !== 'object') return { text, action: null };

  switch (body.do) {
    case 'wakeOnLaunch':
    case 'interrupt':
    case 'watch':
      return { text, action: { do: body.do, on: body.on === true || body.on === 'true' } };
    case 'colour': {
      const hex = resolveColour(body.value);
      return { text, action: hex === null ? null : { do: 'colour', hex } };
    }
    case 'lookReset':
      return { text, action: { do: 'lookReset' } };
    default:
      return { text, action: null };
  }
}

// The prompt lines that teach the model these verbs live in
// packages/intelligence (CHAT_ACTIONS) — the prompt is built in the gateway's
// process, and a prompt promising verbs this parser refuses is the bug to
// make impossible: change one, change the other, and the parser tests below
// hold the shapes.
module.exports = { parseReply, resolveColour };
