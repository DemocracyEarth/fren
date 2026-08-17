# Development

## Setup

Requirements:

- macOS (the observer shells out to `lsappinfo` and `osascript`)
- Node.js **>= 23** — the memory layer uses the built-in `node:sqlite` module.
  (Inside Electron the app runs on Electron's bundled Node 22.x, where
  `node:sqlite` is also available.)

```sh
npm install
cp .env.example .env    # optional in dev — everything has a default
npm start
```

No `ANTHROPIC_API_KEY`? The gateway automatically falls back to the **mock
provider**: canned summaries and chat replies, zero network calls. The full
loop — observe, store, summarize, chat — runs offline. Force it explicitly with
`FREN_LLM_PROVIDER=mock`.

## The two processes

| Process | Command | What it is |
|---|---|---|
| Gateway | `npm run gateway` | `node:http` server on `127.0.0.1:4519`. Holds the API key and prompts. Endpoints: `GET /health`, `POST /v1/summarize`, `POST /v1/chat`. Bearer-token auth (dev default `dev-token`). |
| Desktop | `npm run desktop` | Electron app: orb UI, observer, memory, summarizer. Talks only to the gateway. |

`npm start` runs `start.js`, which spawns both and shuts both down when either
exits. When developing one side, run the other in a second terminal.

Everything is plain CommonJS. There is no build step, no bundler, no
transpiler — edit a file, restart the process.

## Environment variables

All optional in dev. From `.env.example` (loaded by `packages/shared/env.js`;
real environment variables win over `.env`):

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (empty) | API key, used by the **gateway only**. Never reaches the desktop client. Optional if logged in via `ant auth login`. |
| `FREN_MODEL` | `claude-haiku-4-5` | Model the gateway calls. Swap without touching the desktop app. |
| `FREN_LLM_PROVIDER` | (auto) | `anthropic` or `mock`. Default: anthropic, falling back to mock when SDK/credentials are unavailable. |
| `FREN_GATEWAY_TOKEN` | `dev-token` | Shared bearer secret between desktop and gateway. |
| `FREN_GATEWAY_URL` | `http://127.0.0.1:4519` | Where the desktop app finds the gateway. |

## Tunables

All in **`packages/shared/config.js`** — change in code, not a settings UI:
sample interval (5s), screenshot cadence (every 3rd sample) and size/quality,
summarize interval (2 min) and minimum batch (4 observations), retention (7
days of observations, 200 screenshots), gateway port (4519), model. If you are
tempted to add a config knob elsewhere, put it here instead.

## Tests

```sh
npm test
```

Runs `node --test` over `packages/memory/test`, `packages/intelligence/test`,
and `apps/gateway/test`. No test framework dependency — the built-in runner
only. The desktop app's Electron-bound code (observer, UI) is not covered by
unit tests in v0.1; keep logic you want tested in the packages.

## Decision log

Why the codebase looks the way it does. Revisit these when their reasons stop
being true, not before.

- **Electron + plain CJS + no build step.** A proof of concept lives or dies by
  iteration speed. Electron gives the always-on-top transparent window and
  `desktopCapturer` for free; plain CommonJS means the stack trace is the
  source code.
- **Built-in `node:sqlite` over `better-sqlite3`.** No native compilation, no
  electron-rebuild, no version matrix. Costs us a Node >= 23 requirement, which
  is fine for a PoC.
- **Relative requires over npm workspaces.** With five small modules in one
  repo, `require('../../packages/shared/config')` is simpler than workspace
  resolution and works identically under Electron.
- **`claude-haiku-4-5` for cost.** Summarizing a timeline every 2 minutes adds
  up; the task is easy. The model lives server-side (`FREN_MODEL`, gateway
  prompts), so it is swappable without touching the desktop app.
- **Screenshots captured but not sent to the LLM.** The app/window timeline is
  enough for M1's summaries, and text is strictly better for both privacy and
  cost. Screenshots are stored locally as groundwork for later milestones —
  sending them would be a product decision, not a code change made in passing.
- **Single window.** The orb and chat panel share one window. Fewer windows,
  fewer focus/z-order bugs, one renderer to reason about.
- **Mock provider for offline dev.** The entire loop must run without
  credentials or network, so development and tests never depend on the API.

## Adding a feature — orientation

1. **State first.** If the feature has UI state, it goes through
   `apps/desktop/main/state.js`. The renderer renders state; it never owns it.
   Do not add a second source of truth — the eyes-open ⇔ capturing invariant
   depends on there being one.
2. **Pick the right side of the gateway.** Anything involving prompts, models,
   or provider credentials belongs in `packages/intelligence` + `apps/gateway`.
   The desktop app must keep working against `/health`, `/v1/summarize`,
   `/v1/chat` and must never hold an API key.
3. **Storage goes through `packages/memory`.** New persistent data means a
   table (or column) there, with its retention story decided at the same time.
4. **Tunables go in `packages/shared/config.js`**, shared shapes in
   `packages/shared/types.js` (JSDoc typedefs).
5. **Check the privacy claims.** If your feature changes what is captured or
   what leaves the machine, `docs/privacy.md` and the README must change in the
   same commit — the docs are part of the product.
6. **Test in the packages.** Logic in `packages/*` and `apps/gateway` is
   testable with `node --test`; Electron-bound code is not, so keep it thin.
