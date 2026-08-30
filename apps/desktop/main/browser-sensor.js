'use strict';
/**
 * The browser sensor — fren's first high-resolution semantic sense.
 *
 * Pure logic, no Electron and no network: the transport hands this module
 * verified events from the extension, and it maintains one normalized picture
 * of "what is in the browser right now", emits lifecycle events, enforces the
 * exclusion policy a second time (the extension self-censors from the same
 * list, but a sensor that trusts its eye is not a sensor), and answers
 * getContext() for the rest of fren.
 *
 * The shape deliberately follows observer.js — a factory taking callbacks,
 * with start/stop honouring the privacy invariant: while fren is not
 * observing, events are dropped on the floor here no matter what arrives.
 */
const { config } = require('../../../packages/shared');

/** Lifecycle names, exported so tests and logs use the same words. */
const EVENTS = Object.freeze({
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  PAGE_OPENED: 'PAGE_OPENED',
  PAGE_UPDATED: 'PAGE_UPDATED',
  TAB_CHANGED: 'TAB_CHANGED',
  SELECTION_CHANGED: 'SELECTION_CHANGED',
  BROWSER_FOCUSED: 'BROWSER_FOCUSED',
  BROWSER_BLURRED: 'BROWSER_BLURRED',
  PAGE_CLOSED: 'PAGE_CLOSED',
});

/**
 * Domain matching for the exclusion list.
 *
 * A pattern matches its own domain and every subdomain: "chase.com" excludes
 * "chase.com" and "secure.chase.com" but not "notchase.com". Patterns are
 * hostnames, not URLs — the sanitizer below reduces whatever was typed.
 */
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
 * The exclusion list's single door, like sanitizeLook is for the orb's look.
 * Accepts anything (a stored string, a textarea's lines, junk) and returns a
 * clean array of hostname patterns.
 */
function sanitizeExclusions(raw) {
  let list = raw;
  if (typeof raw === 'string') list = raw.split(/[\n,]+/);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    let p = String(entry || '').trim().toLowerCase();
    if (!p) continue;
    // People paste URLs; reduce to the hostname.
    p = p.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
    // A hostname is letters, digits, dots and hyphens — anything else is a
    // typo that would silently never match; drop it rather than store it.
    if (!/^[a-z0-9.-]+$/.test(p) || !p.includes('.')) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 200);
}

/**
 * Sites nobody should have to remember to exclude. The user's own list adds
 * to these; it cannot remove them in this first version.
 */
const DEFAULT_EXCLUSIONS = Object.freeze([
  // banking
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citibank.com',
  'capitalone.com', 'americanexpress.com', 'schwab.com', 'fidelity.com',
  'vanguard.com', 'paypal.com', 'wise.com', 'revolut.com',
  // health
  'myuclahealth.org', 'mychart.com', 'healthcare.gov', 'zocdoc.com',
  // credentials
  '1password.com', 'bitwarden.com', 'lastpass.com',
]);

const clampStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

function createBrowserSensor({ onEvent, now = Date.now } = {}) {
  const emit = (type, detail) => { if (onEvent) onEvent(type, detail || {}); };

  // One connection's worth of state. fren cares about THE browser the user is
  // in, not a fleet — a second browser pairing simply takes over.
  const state = {
    connected: false,
    browser: null,            // 'chrome' | 'arc' | ...
    active: false,            // browser window focused, per the extension
    tab: null,                // { id, url, domain, title, favicon }
    page: null,               // { content, description, canonicalUrl, contentType, truncated, hash, excluded }
    selection: null,          // { text }
    timestamps: { navigation: 0, lastActivity: 0, capturedAt: 0 },
    lastSeen: 0,              // heartbeat bookkeeping
  };

  let enabled = true;         // fren's light: observing off => sensor deaf
  let exclusions = [...DEFAULT_EXCLUSIONS];
  let readPage = true;
  let readSelection = true;

  const touch = () => {
    state.timestamps.lastActivity = now();
    state.lastSeen = now();
  };

  function connect({ browser, name } = {}) {
    state.connected = true;
    state.browser = clampStr(browser, 40) || 'chromium';
    touch();
    emit(EVENTS.CONNECTED, { browser: state.browser, name: clampStr(name, 80) });
  }

  function disconnect(reason) {
    if (!state.connected) return;
    state.connected = false;
    state.active = false;
    state.tab = null;
    state.page = null;
    state.selection = null;
    emit(EVENTS.DISCONNECTED, { reason: reason || 'gone' });
  }

  /** Called by the host on a timer; also the only place staleness is judged. */
  function checkStale() {
    if (state.connected && now() - state.lastSeen > config.BROWSER_STALE_MS) {
      disconnect('heartbeat lost');
    }
  }

  function heartbeat() {
    if (!state.connected) connect({});
    state.lastSeen = now();
  }

  /**
   * A page snapshot from the extension. The one method with real decisions:
   * which lifecycle event this is, whether policy allows the content in, and
   * whether anything actually changed.
   */
  function pageSnapshot(s) {
    if (!enabled) return;
    if (!state.connected) connect({});
    const url = clampStr(s.url, 2048);
    const domain = clampStr(s.domain, 253).toLowerCase();
    const excluded = isExcluded(domain, exclusions);
    const tabChanged = !state.tab || state.tab.id !== s.tabId;
    const navigated = tabChanged || !state.tab || state.tab.url !== url;
    const hash = clampStr(s.contentHash, 64);
    const sameContent = state.page && state.page.hash && hash && state.page.hash === hash;

    state.tab = {
      id: Number.isFinite(s.tabId) ? s.tabId : -1,
      url: excluded ? '' : url,
      domain,
      title: excluded ? '' : clampStr(s.title, 300),
      favicon: excluded ? '' : clampStr(s.favicon, 2048),
    };
    // The second enforcement of the exclusion list. The extension should not
    // have sent content for an excluded domain at all; if it did (stale
    // config), the content stops here and never reaches state.
    state.page = excluded ? { excluded: true, hash: '' } : {
      excluded: false,
      content: readPage ? clampStr(s.content, config.BROWSER_CONTENT_MAX_CHARS) : '',
      description: clampStr(s.description, 500),
      canonicalUrl: clampStr(s.canonicalUrl, 2048),
      contentType: clampStr(s.contentType, 40) || 'page',
      truncated: !!s.truncated || (typeof s.content === 'string' &&
        s.content.length > config.BROWSER_CONTENT_MAX_CHARS),
      hash,
    };
    if (navigated) state.selection = null;   // a selection does not survive its page
    state.timestamps.navigation = Number.isFinite(s.navAt) ? s.navAt : now();
    state.timestamps.capturedAt = now();
    touch();

    if (tabChanged) emit(EVENTS.TAB_CHANGED, { domain, excluded });
    if (navigated) emit(EVENTS.PAGE_OPENED, { domain, excluded });
    else if (!sameContent) emit(EVENTS.PAGE_UPDATED, { domain, excluded });
    // navigated-and-unchanged-content emits nothing extra: OPENED covers it,
    // and same-tab same-content snapshots are the dedup working as intended.
  }

  function selection(s) {
    if (!enabled || !readSelection) return;
    if (!state.tab || (state.page && state.page.excluded)) return;
    const text = clampStr(s.text, config.BROWSER_SELECTION_MAX_CHARS).trim();
    const had = state.selection && state.selection.text;
    if (!text && !had) return;
    state.selection = text ? { text } : null;
    touch();
    emit(EVENTS.SELECTION_CHANGED, { chars: text.length });
  }

  function focus(f) {
    if (!enabled) return;
    const active = !!(f && f.focused);
    if (active === state.active) return;
    state.active = active;
    touch();
    emit(active ? EVENTS.BROWSER_FOCUSED : EVENTS.BROWSER_BLURRED, {});
  }

  function tabClosed(t) {
    if (!enabled) return;
    if (state.tab && state.tab.id === t.tabId) {
      state.tab = null;
      state.page = null;
      state.selection = null;
      touch();
      emit(EVENTS.PAGE_CLOSED, {});
    }
  }

  /** The verified-event entry point the transport calls. */
  function ingest(msg) {
    switch (msg && msg.type) {
      case 'hello': return connect(msg);
      case 'bye': return disconnect('extension said goodbye');
      case 'heartbeat': return heartbeat();
      case 'page': return pageSnapshot(msg);
      case 'selection': return selection(msg);
      case 'focus': return focus(msg);
      case 'tab_closed': return tabClosed(msg);
      default: /* unknown event types are dropped, never an error */
    }
  }

  /** Policy in, from settings and from fren's own light. */
  function configure({ enabled: en, readPage: rp, readSelection: rs, exclusions: ex } = {}) {
    if (typeof en === 'boolean') {
      enabled = en;
      // The light going off empties the sensor: a paused fren HOLDS nothing,
      // which is the same promise observer.js makes about its samples.
      if (!enabled) {
        state.tab = null;
        state.page = null;
        state.selection = null;
        state.active = false;
      }
    }
    if (typeof rp === 'boolean') readPage = rp;
    if (typeof rs === 'boolean') readSelection = rs;
    if (ex !== undefined) exclusions = [...DEFAULT_EXCLUSIONS, ...sanitizeExclusions(ex)];
  }

  /** What the extension is allowed to do — served to it over /config. */
  function policy() {
    return { enabled, readPage, readSelection, exclusions: [...exclusions] };
  }

  /**
   * The normalized context the rest of fren consumes. Browser-specific
   * details stay behind this line.
   */
  function getContext() {
    if (!enabled || !state.connected || !state.tab) return null;
    return {
      browser: state.browser,
      active: state.active,
      tab: { ...state.tab },
      page: state.page ? { ...state.page } : null,
      selection: state.selection ? { ...state.selection } : null,
      timestamps: { ...state.timestamps },
    };
  }

  /** Everything the debug view shows; safe to ship to the dashboard. */
  function debugState() {
    return {
      connected: state.connected,
      enabled,
      browser: state.browser,
      active: state.active,
      domain: state.tab ? state.tab.domain : '',
      title: state.tab ? state.tab.title : '',
      excluded: !!(state.page && state.page.excluded),
      contentChars: state.page && state.page.content ? state.page.content.length : 0,
      truncated: !!(state.page && state.page.truncated),
      selectionChars: state.selection ? state.selection.text.length : 0,
      lastActivity: state.timestamps.lastActivity,
    };
  }

  return {
    ingest, configure, policy, getContext, debugState, checkStale,
    disconnect,
  };
}

module.exports = {
  createBrowserSensor, EVENTS, isExcluded, sanitizeExclusions, DEFAULT_EXCLUSIONS,
};
