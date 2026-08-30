'use strict';
/**
 * Readable-content extraction — the pure half.
 *
 * Everything here is plain functions over strings and simple structures, so
 * node can test it without a DOM. The DOM walking itself lives in content.js,
 * which feeds text blocks into these.
 *
 * UMD like palette.js: the content script gets FrenExtract on self, the tests
 * require() it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrenExtract = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /** Collapse whitespace the way rendered text does; strip control junk. */
  function cleanText(s) {
    return String(s || '')
      .replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Pick the readable body out of candidate blocks.
   *
   * Each block is { text, weight } — content.js weighs blocks by where they
   * came from (article > main > body) and this keeps the best material,
   * dropping short navigation-flavoured fragments. Headings ride separately.
   */
  function assembleContent(blocks, { maxChars }) {
    const kept = [];
    let total = 0;
    let truncated = false;
    const sorted = [...blocks].sort((a, b) => (b.weight || 0) - (a.weight || 0));
    // Only the best source tier contributes: when an <article> exists, the
    // page chrome around it does not get to dilute it.
    const bestWeight = sorted.length ? (sorted[0].weight || 0) : 0;
    for (const b of sorted) {
      if ((b.weight || 0) < bestWeight) break;
      const t = cleanText(b.text);
      // Fragments shorter than a sentence are almost always UI: "Sign in",
      // "Next", cookie-bar stubs. Real prose survives this floor.
      if (t.length < 40) continue;
      if (total + t.length > maxChars) {
        kept.push(t.slice(0, Math.max(0, maxChars - total)));
        truncated = true;
        break;
      }
      kept.push(t);
      total += t.length + 1;
    }
    return { content: kept.join('\n'), truncated };
  }

  /**
   * FNV-1a over the content — cheap, stable, and good enough to answer the
   * only question asked of it: "is this the same text I already sent?"
   */
  function hashContent(s) {
    let h = 0x811c9dc5;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /** The hostname, lowercased, without a leading www. */
  function domainOf(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h.startsWith('www.') ? h.slice(4) : h;
    } catch {
      return '';
    }
  }

  /** Mirrors the sensor's matcher so both ends censor identically. */
  function isExcluded(domain, patterns) {
    const d = String(domain || '').toLowerCase();
    if (!d) return false;
    for (const raw of patterns || []) {
      const p = String(raw || '').toLowerCase().trim();
      if (!p) continue;
      if (d === p || d.endsWith('.' + p)) return true;
    }
    return false;
  }

  /**
   * The one payload shape the wire carries for a page. content.js supplies
   * raw pieces; this clamps and normalizes so the background worker and the
   * sensor can trust the shape.
   */
  function pageEvent({ tabId, url, title, favicon, description, canonicalUrl,
                       contentType, blocks, headings, maxChars, navAt }) {
    const { content, truncated } = assembleContent(blocks || [], { maxChars });
    const heads = (headings || []).map(cleanText).filter(Boolean).slice(0, 20);
    // Headings lead the content: they are the page's own outline, and they
    // survive truncation because they go first.
    const body = heads.length ? heads.join(' · ') + '\n' + content : content;
    const capped = body.slice(0, maxChars);
    return {
      type: 'page',
      tabId,
      url: String(url || '').slice(0, 2048),
      domain: domainOf(url),
      title: cleanText(title).slice(0, 300),
      favicon: String(favicon || '').slice(0, 2048),
      description: cleanText(description).slice(0, 500),
      canonicalUrl: String(canonicalUrl || '').slice(0, 2048),
      contentType: contentType || 'page',
      content: capped,
      truncated: truncated || body.length > maxChars,
      contentHash: hashContent(capped),
      navAt: navAt || Date.now(),
    };
  }

  return { cleanText, assembleContent, hashContent, domainOf, isExcluded, pageEvent };
});
