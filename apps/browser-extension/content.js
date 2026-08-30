'use strict';
/**
 * The eye on the page. Deliberately thin: walk the DOM for readable text,
 * hand the pieces to FrenExtract for shaping, send the result to the
 * background worker. The intelligence lives in fren, not here.
 *
 * What this file must never do is as important as what it does:
 *  - never read input, textarea, select, or contenteditable — form contents
 *    and passwords are structurally out, not filtered out;
 *  - never touch cookies, storage, or credentials;
 *  - never talk to anything but the extension's own background worker.
 */
/* global FrenExtract, chrome */
(() => {
  const MAX_CHARS = 24_000;
  const MUTATION_DEBOUNCE_MS = 1500;
  const SELECTION_DEBOUNCE_MS = 400;

  // Subtrees that are chrome, not content. Skipped entirely during the walk,
  // children included.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'DIALOG']);

  function skippable(el) {
    if (SKIP.has(el.tagName)) return true;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    if (role === 'navigation' || role === 'banner' || role === 'complementary' ||
        role === 'contentinfo' || role === 'search') return true;
    // The classic ad/consent containers, by their own names.
    const id = (el.id + ' ' + el.className).toLowerCase();
    if (/\b(ad|ads|advert|sponsor|cookie|consent|promo|banner)\b/.test(id)) return true;
    return false;
  }

  /** Collect text blocks from a root, one block per paragraph-ish element. */
  function blocksFrom(root, weight) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => (skippable(el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const leafy = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'DD', 'FIGCAPTION']);
    let el = root;
    while (el) {
      if (leafy.has(el.tagName)) {
        out.push({ text: el.innerText || '', weight });
        // innerText already includes descendants; skip past this subtree.
        let next = walker.nextSibling();
        while (!next && walker.parentNode()) next = walker.nextSibling();
        el = next;
        continue;
      }
      el = walker.nextNode();
      if (out.length > 400) break;   // enormous pages: enough is enough
    }
    return out;
  }

  function meta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el ? el.getAttribute('content') || '' : '';
  }

  function snapshot() {
    // The best single container wins: article beats [role=main] beats main
    // beats body, and only the winner is read — the page chrome around an
    // article does not get to dilute it.
    const roots = [
      [document.querySelector('article'), 4],
      [document.querySelector('[role="main"]'), 3],
      [document.querySelector('main'), 3],
      [document.body, 1],
    ].filter(([el]) => el);
    const [root, weight] = roots[0] || [null, 0];
    const blocks = root ? blocksFrom(root, weight) : [];
    // Paragraph-poor pages (discussions, docs apps) still have running text:
    // fall back to the root's innerText when the walk found little.
    if (root && blocks.reduce((n, b) => n + b.text.length, 0) < 200) {
      blocks.push({ text: root.innerText || '', weight });
    }
    const headings = [...document.querySelectorAll('h1, h2, h3')]
      .filter((h) => !skippable(h))
      .map((h) => h.innerText || '');

    const link = document.querySelector('link[rel="canonical"]');
    const icon = document.querySelector('link[rel~="icon"]');
    return FrenExtract.pageEvent({
      tabId: -1,                       // the background worker fills this in
      url: location.href,
      title: document.title,
      favicon: icon ? icon.href : new URL('/favicon.ico', location.origin).href,
      description: meta('description') || meta('og:description'),
      canonicalUrl: link ? link.href : '',
      contentType: document.querySelector('article') ? 'article' : 'page',
      blocks,
      headings,
      maxChars: MAX_CHARS,
      navAt: Date.now(),
    });
  }

  let lastHash = '';
  function sendSnapshot(force) {
    const page = snapshot();
    if (!force && page.contentHash === lastHash && page.title === lastTitle) return;
    lastHash = page.contentHash;
    lastTitle = page.title;
    try { chrome.runtime.sendMessage(page); } catch { /* worker asleep; the next event retries */ }
  }
  let lastTitle = '';

  // The page settles, then changes: one debounced observer, watching only
  // while the tab is visible — a background tab's mutations are not context.
  let mutTimer = null;
  const observer = new MutationObserver(() => {
    if (document.hidden) return;
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => sendSnapshot(false), MUTATION_DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Selection, debounced. Selections inside editable fields are not read —
  // what someone is WRITING is not fren's business, only what they are reading.
  let selTimer = null;
  let lastSelection = '';
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = document.getSelection();
      const anchor = sel && sel.anchorNode;
      const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      if (el && (el.isContentEditable || el.closest('input, textarea, [contenteditable="true"]'))) return;
      const text = sel ? String(sel).slice(0, 2000).trim() : '';
      if (text === lastSelection) return;
      lastSelection = text;
      try { chrome.runtime.sendMessage({ type: 'selection', text }); } catch { /* next one */ }
    }, SELECTION_DEBOUNCE_MS);
  });

  // SPA navigations change the URL without a load; the title usually follows.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sendSnapshot(true);
    }
  }, 1000);

  // The background worker asks for a fresh snapshot when a tab becomes
  // active — the content script is the only one who can see the page.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'snapshot_please') sendSnapshot(true);
  });

  sendSnapshot(true);
})();
