# fren browser awareness — the extension

One of fren's senses. It watches the **active tab only**, extracts the
readable content, and hands it to fren over loopback. Nothing leaves the
machine; the extension talks to `127.0.0.1` and nowhere else.

## Load it for development

1. Run fren: `npm start` (from the repo root).
2. Open `chrome://extensions` (or the same page in Brave / Edge / Arc).
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → choose this folder (`apps/browser-extension/`).
5. fren pops a consent dialog — *a browser extension wants to become one of
   fren's senses*. Click **Allow**.
6. Browse. The dashboard → Settings → **Browser awareness** shows
   `Connected ✓`, the current page, and live sensor state. The terminal shows
   `[browser]` log lines.

No ports, URLs, or tokens to configure: pairing mints and stores the
credential automatically. If you reload the extension it re-pairs by itself
(fren may ask once more).

## What it never does

- Never reads `input`, `textarea`, `select`, or `contenteditable` — form
  contents and passwords are structurally unreachable, not filtered.
- Never touches cookies, history, or credentials.
- Never sends content for excluded domains (fren serves the list; banking
  and health sites are excluded by default) — and fren drops such content
  again on its own side if it ever arrives.
- Never captures anything while fren's light is off.

## Shape

- `manifest.json` — MV3; works on Chromium cousins (Chrome, Brave, Edge,
  Arc, Vivaldi) from the one codebase.
- `content.js` — walks the DOM for readable text (article > main > body),
  debounces mutations, reports text selection.
- `lib/extract.js` — the pure half (shaping, hashing, truncation, exclusion
  matching); tested with `node --test` from the repo suite.
- `background.js` — pairing, policy cache, and one POST per event to fren's
  loopback sensor port. MV3-friendly: no long-lived connections, a
  `chrome.alarms` heartbeat keeps liveness.

For the full architecture, see `docs/browser-awareness.md`.
