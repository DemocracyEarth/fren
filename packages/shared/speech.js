'use strict';
/**
 * What fren says out loud, prepared for a voice.
 *
 * Model output is written for a screen: bold marks, bullet points, code,
 * links, emoji, dashes, quotation marks. Read literally, a voice says
 * "asterisk asterisk" and "smiling face"; a voice that skips them says
 * something the way a person would. This strips what is only for the eye
 * and turns the rest into pauses. It never changes the words themselves.
 */
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{FE0F}\u{200D}\u{20E3}]/gu;
const END = /[.!?:;,…]$/;

function forSpeech(input) {
  let t = String(input || '');
  // Fenced code is not for reading aloud.
  t = t.replace(/(```|~~~)[\s\S]*?\1/g, ' code omitted. ');
  // Links: the words, not the address. A bare address becomes its host.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/([^\s/)\]>]+)[^\s)\]>]*/gi, (m, host) => host.replace(/^www\./, ''));
  // Block marks: headings, quotes, bullets, numbering, rules, tables. Each
  // line is its own thought, so it ends like one and the voice pauses.
  const lines = t.split(/\r?\n/).map((line) => {
    let l = line;
    l = l.replace(/^\s{0,3}#{1,6}\s+/, '');
    l = l.replace(/^\s*>\s?/, '');
    l = l.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '');
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return '';
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l)) return '';
      l = l.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(', ');
    }
    const s = l.trim();
    if (!s) return '';
    return END.test(s) ? s : s + '.';
  });
  t = lines.filter(Boolean).join(' ');
  // Inline marks.
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  t = t.replace(/(^|[^A-Za-z0-9])\*([^*]+)\*(?=$|[^A-Za-z0-9*])/g, '$1$2');
  t = t.replace(/(^|[^A-Za-z0-9])_([^_]+)_(?=$|[^A-Za-z0-9_])/g, '$1$2');
  // Symbols a voice reads badly or not at all.
  t = t.replace(/(^|\s)#(\d+)/g, '$1number $2');
  t = t.replace(/\s*&\s*/g, ' and ');
  t = t.replace(/(^|\s)@(?=\w)/g, '$1at ');
  t = t.replace(/(^|\s)~(?=\d)/g, '$1about ');
  t = t.replace(/[*_#~`>|]+/g, ' ');
  t = t.replace(EMOJI, '');
  // Quotation marks are for the eye; an apostrophe inside a word stays.
  t = t.replace(/[“”„‟«»"]/g, '');
  t = t.replace(/(^|[\s(\[])[‘']/g, '$1').replace(/[’'](?=[\s).,;:!?\]]|$)/g, '').replace(/’/g, "'");
  // Dashes and ellipses become pauses.
  t = t.replace(/\s*[—–]\s*/g, ', ').replace(/\s+--?\s+/g, ', ').replace(/…/g, '...');
  // Tidy what the removals left behind.
  t = t.replace(/\(\s*\)|\[\s*\]/g, ' ');
  t = t.replace(/\s+([.,;:!?])/g, '$1');
  t = t.replace(/,\s*([.!?;:,])/g, '$1');
  t = t.replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^[,.;:\s]+/, '');
  return t;
}

module.exports = { forSpeech };
