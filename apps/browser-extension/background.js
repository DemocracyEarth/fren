'use strict';
/**
 * The extension's half of the loopback channel.
 *
 * Everything event-shaped: MV3 service workers sleep whenever they can, so
 * there is no long-lived socket — each event is one POST, pairing is lazy,
 * and a chrome.alarm heartbeat (which also wakes the worker) keeps fren's
 * staleness clock fed and this side's policy cache fresh.
 *
 * The worker self-censors from the policy fren serves (/config): excluded
 * domains never leave the browser, and when fren's light is off nothing is
 * captured at all. fren enforces the same rules again on its side.
 */
/* global chrome */
importScripts('lib/extract.js');

const FREN = 'http://127.0.0.1:4526';
const HEARTBEAT_MIN = 0.5;             // chrome.alarms floor: 30s

let token = null;
let policy = { enabled: true, readPage: true, readSelection: true, exclusions: [] };
let pairing = false;

function browserName() {
  // Chromium cousins mostly admit who they are in the brands list; Arc does
  // not, and stays "chrome" — best effort, cosmetic only.
  try {
    const brands = navigator.userAgentData.brands.map((b) => b.brand.toLowerCase());
    for (const known of ['brave', 'edge', 'opera', 'vivaldi', 'arc']) {
      if (brands.some((b) => b.includes(known))) return known;
    }
  } catch { /* fall through */ }
  return 'chrome';
}

async function loadToken() {
  if (token) return token;
  const got = await chrome.storage.local.get('frenToken');
  token = got.frenToken || null;
  return token;
}

async function pair() {
  if (pairing) return false;
  pairing = true;
  try {
    const res = await fetch(`${FREN}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ browser: browserName(), name: 'fren browser awareness' }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    if (body.token) {
      token = body.token;
      await chrome.storage.local.set({ frenToken: token });
      await post({ type: 'hello', browser: browserName(), name: 'fren browser awareness' });
      return true;
    }
    return !!body.paired;
  } catch {
    return false;                      // fren not running; the heartbeat retries
  } finally {
    pairing = false;
  }
}

async function post(event) {
  const t = await loadToken();
  if (!t) return pair();
  try {
    const res = await fetch(`${FREN}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ events: [event] }),
    });
    if (res.status === 401) {          // fren forgot us (reinstall, reset): re-pair
      token = null;
      await chrome.storage.local.remove('frenToken');
      return pair();
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function heartbeat() {
  const t = await loadToken();
  if (!t) { await pair(); return; }
  try {
    const res = await fetch(`${FREN}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}` },
    });
    if (res.ok) policy = await res.json();    // the policy rides the heartbeat
    else if (res.status === 401) { token = null; await chrome.storage.local.remove('frenToken'); }
  } catch { /* fren away; keep the last policy */ }
}

/** The self-censoring gate every outgoing page event passes through. */
function permitted(page) {
  if (!policy.enabled) return null;
  if (FrenExtract.isExcluded(page.domain, policy.exclusions)) {
    // The domain pattern that matched is, by definition, already known to
    // fren — but the page is not, and does not go.
    return { type: 'page', tabId: page.tabId, url: '', domain: page.domain,
             title: '', favicon: '', content: '', description: '', canonicalUrl: '',
             contentType: 'excluded', truncated: false, contentHash: '', navAt: page.navAt };
  }
  if (!policy.readPage) return { ...page, content: '', truncated: false };
  return page;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.id : -1;
}

// ---- the events ------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    if (!msg || !sender.tab) return;
    // Only the ACTIVE tab is context. Background tabs extract locally and are
    // dropped here — one line, and half the privacy story.
    if (sender.tab.id !== await activeTabId()) return;
    if (msg.type === 'page') {
      const page = permitted({ ...msg, tabId: sender.tab.id });
      if (page) await post(page);
    } else if (msg.type === 'selection' && policy.enabled && policy.readSelection) {
      await post({ type: 'selection', tabId: sender.tab.id, text: msg.text });
    }
  })();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // The newly fronted tab holds the truth; ask its content script to speak.
  try { await chrome.tabs.sendMessage(tabId, { type: 'snapshot_please' }); }
  catch { /* no content script there (chrome:// etc.) — say the tab changed anyway */
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (policy.enabled) {
      await post({ type: 'page', tabId, url: '', domain: tab && tab.url ? FrenExtract.domainOf(tab.url) : '',
                   title: '', favicon: '', content: '', description: '', canonicalUrl: '',
                   contentType: 'opaque', truncated: false, contentHash: '', navAt: Date.now() });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { post({ type: 'tab_closed', tabId }); });

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!policy.enabled) return;
  post({ type: 'focus', focused: windowId !== chrome.windows.WINDOW_ID_NONE });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('fren-heartbeat', { periodInMinutes: HEARTBEAT_MIN });
  pair();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('fren-heartbeat', { periodInMinutes: HEARTBEAT_MIN });
  heartbeat();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'fren-heartbeat') heartbeat(); });
