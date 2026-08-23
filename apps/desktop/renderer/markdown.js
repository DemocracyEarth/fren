'use strict';
/**
 * Just enough Markdown to read fren's own files.
 *
 * Hand-written and small rather than a vendored library, for two reasons. The
 * files this renders are written by soul.js and by the user, and between them
 * they use maybe eight constructs — that is the whole requirement. And a
 * library would arrive as a bundle nobody in this repo has read, into an app
 * whose entire pitch is that you can read what it does.
 *
 * IT BUILDS NODES, NEVER HTML STRINGS. That is not caution for its own sake:
 * fren writes MEMORY.md itself, from model output, via rememberFact(). Anything
 * that assembled a string and assigned innerHTML would turn "a model said
 * something odd" into "a model wrote markup into your dashboard". createElement
 * and textContent make that impossible rather than unlikely.
 *
 * Deliberately NOT supported, and shown as plain text instead:
 *   raw HTML   — the one construct whose whole purpose is to inject
 *   images     — a remote src is a phone-home, in an app that promises none
 *   live links — the URL is shown and is not clickable. A file fren wrote
 *                should never put a clickable destination in front of someone.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrenMarkdown = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /**
   * Inline spans. One pass, earliest match wins, appending to a parent node.
   * Nothing here can produce markup — the worst a malformed file does is show
   * its own asterisks.
   */
  const INLINE = [
    { re: /`([^`\n]+)`/, tag: 'code' },
    { re: /\*\*([^*\n]+)\*\*/, tag: 'strong' },
    { re: /__([^_\n]+)__/, tag: 'strong' },
    // Not inside a word, or every snake_case name in these files turns italic.
    { re: /(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/, tag: 'em', lead: 1, body: 2 },
    { re: /(^|[^*])\*([^*\n]+)\*(?!\*)/, tag: 'em', lead: 1, body: 2 },
    { re: /\[\[([^\]\n]+)\]\]/, tag: 'span', cls: 'md-wiki' },
  ];

  function inline(parent, text) {
    let rest = String(text);
    let guard = 0;
    while (rest && guard++ < 500) {
      const link = /\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest);
      let best = null;
      for (const rule of INLINE) {
        const m = rule.re.exec(rest);
        if (!m) continue;
        // Where the construct itself starts, past any required lead character.
        const at = m.index + (rule.lead ? m[rule.lead].length : 0);
        if (!best || at < best.at) best = { m, rule, at };
      }
      if (link && (!best || link.index < best.at)) {
        if (link.index) parent.appendChild(document.createTextNode(rest.slice(0, link.index)));
        const span = document.createElement('span');
        span.className = 'md-link';
        span.textContent = link[1] || link[2];
        // Shown and inert. An anchor would let a file fren wrote put a
        // clickable target in front of someone.
        span.title = link[2];
        parent.appendChild(span);
        rest = rest.slice(link.index + link[0].length);
        continue;
      }
      if (!best) break;
      if (best.at) parent.appendChild(document.createTextNode(rest.slice(0, best.at)));
      const node = document.createElement(best.rule.tag);
      if (best.rule.cls) node.className = best.rule.cls;
      node.textContent = best.m[best.rule.body || 1];
      parent.appendChild(node);
      rest = rest.slice(best.m.index + best.m[0].length);
    }
    if (rest) parent.appendChild(document.createTextNode(rest));
    return parent;
  }

  /** Render Markdown into a fresh element. */
  function render(text) {
    const root = document.createElement('div');
    root.className = 'md';
    const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n');

    let i = 0;
    let para = null;
    const push = (el) => { para = null; root.appendChild(el); return el; };

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code. Everything inside is literal, including anything that
      // would otherwise be a construct.
      if (/^\s*```/.test(line)) {
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1; }
        i += 1;
        const pre = document.createElement('pre');
        pre.className = 'md-pre';
        pre.textContent = body.join('\n');
        push(pre);
        continue;
      }

      if (!line.trim()) { para = null; i += 1; continue; }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        push(document.createElement('hr'));
        i += 1;
        continue;
      }

      const head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        const h = document.createElement('h' + head[1].length);
        inline(h, head[2].trim());
        push(h);
        i += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const block = document.createElement('blockquote');
        const parts = [];
        while (i < lines.length) {
          const q = /^\s*>\s?(.*)$/.exec(lines[i]);
          if (!q) break;
          parts.push(q[1]);
          i += 1;
        }
        inline(block, parts.join(' ').trim());
        push(block);
        continue;
      }

      const isBullet = /^(\s*)([-*+])\s+(.*)$/.test(line);
      const isNumber = /^(\s*)(\d+)[.)]\s+(.*)$/.test(line);
      if (isBullet || isNumber) {
        const ordered = isNumber;
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          const m = ordered
            ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i])
            : /^(\s*)([-*+])\s+(.*)$/.exec(lines[i]);
          if (!m) {
            // An indented continuation belongs to the item above it. soul.js
            // hard-wraps its bullets, so without this every wrapped line
            // becomes a stray paragraph.
            const cont = /^\s{2,}(\S.*)$/.exec(lines[i] || '');
            if (cont && list.lastChild) {
              list.lastChild.appendChild(document.createTextNode(' '));
              inline(list.lastChild, cont[1]);
              i += 1;
              continue;
            }
            break;
          }
          const li = document.createElement('li');
          inline(li, m[3]);
          list.appendChild(li);
          i += 1;
        }
        push(list);
        continue;
      }

      // Anything else is a paragraph; consecutive lines join into one.
      if (!para) {
        para = document.createElement('p');
        root.appendChild(para);
      } else {
        para.appendChild(document.createTextNode(' '));
      }
      inline(para, line.trim());
      i += 1;
    }

    return root;
  }

  return { render, inline };
});
