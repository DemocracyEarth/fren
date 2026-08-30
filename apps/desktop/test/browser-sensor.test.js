'use strict';
/**
 * The browser sensor's core: lifecycle, dedup, exclusion, staleness, policy.
 *
 * Everything here runs against the pure module — no Electron, no network —
 * which is the point of keeping the sensor's brain out of the transport.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createBrowserSensor, EVENTS, isExcluded, sanitizeExclusions, DEFAULT_EXCLUSIONS } =
  require('../main/browser-sensor.js');

function harness(nowRef = { t: 1000 }) {
  const events = [];
  const sensor = createBrowserSensor({
    onEvent: (type, detail) => events.push({ type, detail }),
    now: () => nowRef.t,
  });
  return { sensor, events, nowRef };
}

const page = (over = {}) => ({
  type: 'page', tabId: 1, url: 'https://example.com/a', domain: 'example.com',
  title: 'A page', favicon: '', content: 'Readable words '.repeat(10),
  description: 'desc', canonicalUrl: '', contentType: 'article',
  truncated: false, contentHash: 'h1', navAt: 999, ...over,
});

test('the first page connects, changes the tab, and opens', () => {
  const { sensor, events } = harness();
  sensor.ingest(page());
  assert.deepEqual(events.map((e) => e.type),
    [EVENTS.CONNECTED, EVENTS.TAB_CHANGED, EVENTS.PAGE_OPENED]);
  const ctx = sensor.getContext();
  assert.equal(ctx.tab.domain, 'example.com');
  assert.ok(ctx.page.content.includes('Readable words'));
});

test('an unchanged page does not repeat itself', () => {
  const { sensor, events } = harness();
  sensor.ingest(page());
  const before = events.length;
  sensor.ingest(page());               // same tab, same url, same hash
  assert.equal(events.length, before, 'no event for no change');
});

test('changed content on the same page is PAGE_UPDATED, not OPENED', () => {
  const { sensor, events } = harness();
  sensor.ingest(page());
  sensor.ingest(page({ contentHash: 'h2', content: 'New words entirely here.' }));
  assert.equal(events[events.length - 1].type, EVENTS.PAGE_UPDATED);
});

test('a different tab is TAB_CHANGED and PAGE_OPENED', () => {
  const { sensor, events } = harness();
  sensor.ingest(page());
  sensor.ingest(page({ tabId: 2, url: 'https://other.com/x', domain: 'other.com', contentHash: 'h9' }));
  const tail = events.slice(-2).map((e) => e.type);
  assert.deepEqual(tail, [EVENTS.TAB_CHANGED, EVENTS.PAGE_OPENED]);
});

test('a selection arrives, and dies with its page', () => {
  const { sensor, events } = harness();
  sensor.ingest(page());
  sensor.ingest({ type: 'selection', text: '  the interesting bit  ' });
  assert.equal(events[events.length - 1].type, EVENTS.SELECTION_CHANGED);
  assert.equal(sensor.getContext().selection.text, 'the interesting bit');
  sensor.ingest(page({ url: 'https://example.com/b', contentHash: 'h3' }));
  assert.equal(sensor.getContext().selection, null, 'navigation clears the selection');
});

test('focus and blur are edges, not levels', () => {
  const { sensor, events } = harness();
  sensor.ingest(page());
  sensor.ingest({ type: 'focus', focused: true });
  sensor.ingest({ type: 'focus', focused: true });   // repeated: no second event
  sensor.ingest({ type: 'focus', focused: false });
  const focusish = events.filter((e) =>
    e.type === EVENTS.BROWSER_FOCUSED || e.type === EVENTS.BROWSER_BLURRED);
  assert.deepEqual(focusish.map((e) => e.type),
    [EVENTS.BROWSER_FOCUSED, EVENTS.BROWSER_BLURRED]);
});

test('closing the active tab empties the context', () => {
  const { sensor, events } = harness();
  sensor.ingest(page());
  sensor.ingest({ type: 'tab_closed', tabId: 1 });
  assert.equal(events[events.length - 1].type, EVENTS.PAGE_CLOSED);
  assert.equal(sensor.getContext(), null);
});

test('closing some other tab changes nothing', () => {
  const { sensor } = harness();
  sensor.ingest(page());
  sensor.ingest({ type: 'tab_closed', tabId: 99 });
  assert.ok(sensor.getContext(), 'the active page survives');
});

test('an excluded domain keeps its content out even if the extension sent it', () => {
  // The second enforcement: a stale extension config must not be enough to
  // leak a banking page into fren.
  const { sensor } = harness();
  sensor.ingest(page({ url: 'https://secure.chase.com/login', domain: 'secure.chase.com',
                       title: 'My account', content: 'BALANCE 123', contentHash: 'hx' }));
  const d = sensor.debugState();
  assert.equal(d.excluded, true);
  assert.equal(d.contentChars, 0, 'content never entered state');
  assert.equal(d.title, '', 'not even the title');
  const ctx = sensor.getContext();
  assert.equal(ctx.page.excluded, true);
  assert.equal(ctx.tab.url, '', 'the url does not survive either');
});

test('the light going off empties the sensor and deafens it', () => {
  const { sensor } = harness();
  sensor.ingest(page());
  sensor.configure({ enabled: false });
  assert.equal(sensor.getContext(), null, 'a paused fren HOLDS nothing');
  sensor.ingest(page({ contentHash: 'h4' }));
  assert.equal(sensor.getContext(), null, 'and hears nothing');
  assert.equal(sensor.policy().enabled, false, 'and tells the extension so');
});

test('readPage off strips content but keeps the where', () => {
  const { sensor } = harness();
  sensor.configure({ readPage: false });
  sensor.ingest(page());
  const ctx = sensor.getContext();
  assert.equal(ctx.page.content, '', 'no content');
  assert.equal(ctx.tab.title, 'A page', 'the title still tells fren where you are');
});

test('readSelection off drops selections silently', () => {
  const { sensor, events } = harness();
  sensor.configure({ readSelection: false });
  sensor.ingest(page());
  const before = events.length;
  sensor.ingest({ type: 'selection', text: 'secret-ish' });
  assert.equal(events.length, before);
  assert.equal(sensor.getContext().selection, null);
});

test('silence past the stale window is a disconnect', () => {
  const nowRef = { t: 1000 };
  const { sensor, events } = harness(nowRef);
  sensor.ingest(page());
  nowRef.t += 80_000;                  // past BROWSER_STALE_MS
  sensor.checkStale();
  assert.equal(events[events.length - 1].type, EVENTS.DISCONNECTED);
  assert.equal(sensor.getContext(), null);
});

test('heartbeats keep it alive', () => {
  const nowRef = { t: 1000 };
  const { sensor, events } = harness(nowRef);
  sensor.ingest(page());
  nowRef.t += 60_000;
  sensor.ingest({ type: 'heartbeat' });
  nowRef.t += 60_000;
  sensor.checkStale();                 // 120s since page, 60s since heartbeat
  assert.ok(!events.some((e) => e.type === EVENTS.DISCONNECTED));
});

test('oversized fields are clamped, not trusted', () => {
  const { sensor } = harness();
  sensor.ingest(page({ content: 'x'.repeat(1_000_000), title: 't'.repeat(10_000) }));
  const ctx = sensor.getContext();
  assert.ok(ctx.page.content.length <= 24_000);
  assert.ok(ctx.tab.title.length <= 300);
  assert.equal(ctx.page.truncated, true, 'and the truncation is declared');
});

// --- the exclusion machinery ------------------------------------------------

test('exclusion matches the domain and its subdomains, nothing else', () => {
  assert.ok(isExcluded('chase.com', ['chase.com']));
  assert.ok(isExcluded('secure.chase.com', ['chase.com']));
  assert.ok(!isExcluded('notchase.com', ['chase.com']));
  assert.ok(!isExcluded('chase.com.evil.example', ['chase.com']));
});

test('sanitizeExclusions accepts what people actually type', () => {
  const got = sanitizeExclusions('https://www.MyBank.com/login\nhealth.example.org, junk!!,\n\nmybank.com');
  assert.deepEqual(got, ['mybank.com', 'health.example.org']);
  assert.deepEqual(sanitizeExclusions(null), []);
  assert.deepEqual(sanitizeExclusions(42), []);
});

test('the default exclusions cover banking out of the box', () => {
  const { sensor } = harness();
  sensor.configure({ exclusions: [] });        // user adds nothing
  sensor.ingest(page({ url: 'https://paypal.com/me', domain: 'paypal.com', contentHash: 'hp' }));
  assert.equal(sensor.debugState().excluded, true);
  assert.ok(DEFAULT_EXCLUSIONS.includes('paypal.com'));
});
