# Browser awareness

fren's first high-resolution semantic sensor: what the user is reading in
their Chromium browser, delivered as normalized context. Perception only — no
browser control, no proactive behaviour yet.

## What the architecture inspection found

The repo already has a shape for every part of this feature, and browser
awareness reuses each one rather than inventing a parallel:

| Need | Existing precedent | Reused how |
| --- | --- | --- |
| A sensor | `apps/desktop/main/observer.js` — `createObserver({ onObservation })`, samples the front window, privacy invariant structural (`stop()` drops in-flight samples) | `main/browser-sensor.js` follows the same factory shape and invariants |
| A loopback server | `apps/gateway/server.js` — `node:http`, bound to `127.0.0.1`, bearer token, body-size caps, `send`/`readJson` helpers | `main/browser-transport.js` is the same idiom, one file |
| Tunables | `packages/shared/config.js` | `BROWSER_*` constants live there |
| Persisted settings | `memory` settings table; the `orbLook` pattern: one sanitizer at the single point of entry | `browser*` settings keys, sanitized in the sensor module |
| State broadcast | `main/state.js` → `fren:state` push to renderers | light status only (never page content) rides the same bus |
| Context assembly | `answer()`/chat in `main/index.js` → `gateway.chat` → `intelligence.buildChatRequest` | the request gains an optional `browser` block |
| Settings UI | dashboard `switchRow`/`fieldRow`/`setting-block` idiom | a "Browser awareness" block in Settings, debug readout included |
| Tests | pure modules + `node --test` | sensor core, extraction, transport, protocol all pure and covered |

## Architecture

```
Chromium extension (MV3, thin)
  content.js    reads the page; never inputs, never passwords
  background.js tab/focus events, config cache, transport client
        │  HTTP POSTs, Bearer token, loopback only
        ▼
main/browser-transport.js   127.0.0.1:4526 · pairing · auth · body caps
        ▼  verified, typed events
main/browser-sensor.js      pure core: lifecycle, dedup, exclusions, staleness
        ▼
main/index.js               logs · state broadcast · getContext() → gateway.chat
```

The intelligence stays in fren. The extension observes and transmits; the
sensor normalizes, deduplicates, enforces policy, and owns the lifecycle:

`PAGE_OPENED · PAGE_UPDATED · TAB_CHANGED · SELECTION_CHANGED ·
BROWSER_FOCUSED · BROWSER_BLURRED · PAGE_CLOSED · CONNECTED · DISCONNECTED`

The transport is behind an interface (`createBrowserTransport` hands verified
events to a callback); swapping HTTP for Chrome Native Messaging later touches
one file.

## Pairing and security

- The server binds **127.0.0.1 only** and never `0.0.0.0`.
- Localhost is not authentication. On first contact the extension POSTs
  `/pair`; fren shows a native consent dialog naming the browser. Approval
  mints a random 256-bit token, returned once; fren stores only its SHA-256
  alongside the extension's `chrome-extension://` origin.
- Every subsequent request needs the Bearer token AND the recorded Origin.
  A web page cannot fake that Origin header (the browser stamps it), and a
  local process that never saw the token has nothing to replay.
- Tokens survive restarts (settings table); denying the dialog blocks that
  origin's re-asks for the session.

## Privacy

- The extension never reads `input`, `textarea`, `select`, `contenteditable`,
  or anything `hidden`/`aria-hidden` — the extractor walks around those
  subtrees entirely, so passwords and form contents are structurally out.
- No cookies, no tokens, no history — only the active tab, only while
  browser awareness is on.
- **Excluded domains** (defaults cover common banking/health) are enforced
  twice: the extension self-censors from the config it fetches, and the
  sensor drops content for excluded domains regardless — defense in depth if
  the extension's config is stale.
- The sensor honours fren's master privacy invariant: when fren's light is
  off (`observing: false`), `/config` reports the sensor disabled, the
  extension stops capturing, and the sensor drops anything that arrives
  anyway. Eyes closed means all eyes.
- Nothing here touches the network beyond loopback. Page content is held in
  memory in the sensor (current page only) and is not written to the
  database in this first version.

## Lifecycle and cost control

- The content script hashes extracted content (FNV-1a); an unchanged hash is
  never retransmitted. Mutations are debounced (1.5 s) and only re-extracted
  while the tab is visible.
- Payloads cap at 24 000 chars of content / 2 000 of selection, with a
  `truncated` flag. Selection updates debounce at 400 ms.
- The background worker heartbeats every 30 s (`chrome.alarms`); the sensor
  marks the browser DISCONNECTED after 75 s of silence — which also covers
  the browser quitting without a goodbye.

## Files

- `apps/browser-extension/` — `manifest.json`, `background.js`, `content.js`,
  `lib/extract.js` (pure, node-tested), `README.md` (dev install).
- `apps/desktop/main/browser-sensor.js` — pure core, no Electron imports.
- `apps/desktop/main/browser-transport.js` — the loopback server.
- Dashboard Settings → "Browser awareness": switches, exclusions, status
  ("Chrome · Connected ✓" / "Extension not installed · Enable"), and the
  live sensor readout that doubles as the debug view.
- Tests: `apps/desktop/test/browser-sensor.test.js`,
  `browser-transport.test.js`, `apps/browser-extension/test/extract.test.js`.

## Developer workflow

1. `npm start`
2. Chrome → `chrome://extensions` → Developer mode → *Load unpacked* →
   `apps/browser-extension/`
3. fren shows the consent dialog; Allow.
4. Browse. `[browser]` log lines and the Settings readout update live.

## The meta-prompt

How fren is told to think about the page lives in
`packages/intelligence/index.js` — `classifyPage`, `browserSense`,
`formatBrowser` — and is pinned by `test/browser-prompt.test.js`. You can
watch the live version in the dashboard: Settings → Browser awareness →
*What fren is told*.

When (and only when) a non-excluded page is in view, the **system prompt**
gains:

> You can also see the page open in their browser right now — it appears in
> the message as "In the browser". This comes from your browser extension:
> you see the ACTIVE tab's readable text only, only while your light is on,
> and never excluded sites. The same honesty rules apply to it: it is
> observed context, quote it rather than invent it, and if the excerpt does
> not contain the answer, say so.

followed by one guidance line chosen by the page's kind:

| kind | guidance |
| --- | --- |
| article | lead with what it claims or argues; tight summaries; keep the writer's opinion distinct from reported fact |
| discussion | keep the post, the crowd's view, and the strongest dissent apart — not a soup of all three |
| video | only the page text is visible, never the video itself — say so when asked beyond it |
| code | say what the project or change is about plainly; precision with names beats paraphrase |
| social | the excerpt is fragments of many voices; prefer what they selected |
| product | facts first; no purchase advice unless asked |
| search | the query is what they are hunting; the excerpt is just the trail |
| reference / docs | answer precisely, quote exact terms, do not improvise past the excerpt |
| page | work from the excerpt; say plainly when it does not contain the answer |

Kinds come from `classifyPage`: well-known homes first (HN/Reddit/Stack* →
discussion, YouTube → video, GitHub → code, X/Bluesky → social, Amazon →
product, engines with a query → search, Wikipedia → reference, docs.* →
docs), then the extension's own signal (an `<article>` element), then plain
`page`. Lookalike domains (`notgithub.com`, `github.com.evil.io`) do not
inherit.

The **message** then carries the page itself:

```
In the browser (chrome, focused) — a discussion:
"Show HN: fren" — https://news.ycombinator.com/item?id=…
Page description: …
They have SELECTED this text: "…"        (when they have)
Readable page excerpt:
…up to 3,000 chars, with a declared […] when capped…
```

An excluded page contributes nothing to either half — no sense is declared
at all, so fren cannot claim an eye it does not have.

## Future sensors

`createBrowserSensor` is deliberately the same shape as `createObserver`:
a factory taking callbacks, a normalized state snapshot, `start/stop`
honouring the privacy invariant. ScreenSensor, ClipboardSensor and the rest
should follow the same contract, feeding the same `getContext()`.
