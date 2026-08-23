# Architecture

This document describes the system as it exists in v0.1. Future milestones are
listed at the bottom with their real status; nothing here documents imagined
architecture as though it were built.

## System diagram

```
┌───────────────────────────── Electron desktop app (apps/desktop) ────────────────────────────┐
│                                                                                              │
│  ┌─────────────────┐     ┌──────────────────────┐                                            │
│  │   mascot UI     │     │      observer        │                                            │
│  │  (renderer)     │     │    (main process)    │                                            │
│  │                 │     │                      │                                            │
│  │  sphere + face  │ IPC │  every 5s:           │                                            │
│  │  30+ faces,     │◄───►│   active app         │                                            │
│  │  spring-driven  │     │    (lsappinfo)       │                                            │
│  │  lit  = awake   │     │   window title       │                                            │
│  │  dark = private │     │    (System Events /  │                                            │
│  │  chat panel     │     │     osascript)       │                                            │
│  └─────────────────┘     │  every ~15s:         │                                            │
│                          │   screenshot         │                                            │
│           ▲              │    (desktopCapturer  │                                            │
│           │              │     → local JPEG)    │                                            │
│           │              └──────────┬───────────┘                                            │
│           │                         │ writes                                                 │
│  ┌────────┴────────┐     ┌──────────▼───────────┐     ┌───────────────────────────┐          │
│  │  app state      │     │       memory         │     │       summarizer          │          │
│  │  (main/state.js │     │  (packages/memory)   │◄───►│  every 2 min: reads the   │          │
│  │  single source  │     │                      │     │  app/window TIMELINE      │          │
│  │  of truth:      │     │  node:sqlite         │     │  (text only — NEVER       │          │
│  │  observing ⇔    │     │  ~/Library/App…/     │     │  screenshots), POSTs it   │          │
│  │  eyes open)     │     │  fren/fren.db        │     │  to the gateway, stores   │          │
│  └─────────────────┘     │  observations        │     │  the summary as a memory, │          │
│                          │  memories            │     │  prunes old data          │          │
│                          │  suggestions         │     └────────────┬──────────────┘          │
│                          └──────────────────────┘                  │                         │
└────────────────────────────────────────────────────────────────────┼─────────────────────────┘
                                                                     │ HTTP + bearer token
                                                                     │ 127.0.0.1:4519
                                                                     ▼
                                                     ┌───────────────────────────────┐
                                                     │   local gateway               │
                                                     │   (apps/gateway, node:http)   │
                                                     │                               │
                                                     │   holds the API key           │
                                                     │   holds all prompts           │
                                                     │   (packages/intelligence)     │
                                                     │                               │
                                                     │   GET  /health                │
                                                     │   POST /v1/summarize          │
                                                     │   POST /v1/chat               │
                                                     └───────────────┬───────────────┘
                                                                     │ provider call
                                                                     ▼
                                                     ┌───────────────────────────────┐
                                                     │   DeepSeek / Anthropic        │
                                                     │   (provider-chosen model)     │
                                                     │   (mock provider when no      │
                                                     │   SDK/credentials available)  │
                                                     └───────────────────────────────┘
```

Two processes. The desktop app scrubs provider API keys from its environment
at startup and never calls the provider; the gateway never touches the
database or the screen.

## Modules

### `apps/desktop` — Electron app

Plain CommonJS, no build step. Two windows: the companion (the orb, with the
chat panel attached to it) and an optional dashboard opened on demand for
reading back days and patterns at a readable size. The dashboard is a reader —
it queries the same database and adds no capability of its own. The main process owns all state and all capture; the renderer
only draws and forwards clicks over IPC. The renderer is served over a custom
`fren://` scheme rather than loaded from disk, because the face is drawn with
ES modules and those do not load over `file://`.

**Mascot UI (renderer).** Draws the sphere and hosts the chat panel. The face
(`renderer/face/face.js`) is one shared parameter space — colour, glow, lids,
mouth, lids, deformation — with a spring per parameter, so its 30+ expressions
blend into one another rather than switching. It follows the expression guide:
the eyes are always plain white circles with no pupils, and feeling is carried
by mouth shape, eye closure and deformation of the orb itself. The material is
a fixed five-layer stack (specular, top light, base, shade, contact shadow) in
a single hue. It holds no logic about observation: every
face change is funnelled through a privacy check against the state the main
process broadcasts, so it cannot look awake while capture is off.

**App state (`main/state.js`).** A tiny observable store and the single source
of truth for `observing`, `mascot`, `panelOpen`, `gatewayOk`. The privacy
invariant — lit if and only if capture is running — holds because `observing`
is only ever changed together with observer start/stop calls, and the renderer
routes every face change through a check on it.

**Observer (main process).** While observing, samples every 5 seconds: active
app via `lsappinfo`, window title via System Events over `osascript`. Every 3rd
sample (~15 seconds) it captures a screenshot via Electron's `desktopCapturer`,
downscaled to max 1280px wide, saved as a local JPEG (quality 60). Missing
macOS permissions degrade the data, never crash the loop: no Screen Recording
means no screenshots; no Accessibility means app names only.

**Summarizer (main process).** Every 2 minutes, if at least 4 observations have
accumulated, it assembles the recent app/window timeline as text and POSTs it to
the gateway's `/v1/summarize`. The returned summary is stored as a semantic
memory. It then prunes: observations older than 7 days, screenshots beyond the
newest 200. Screenshots are never part of the request.

### `apps/gateway` — local LLM gateway

A plain `node:http` server on `127.0.0.1:4519`, guarded by a shared bearer token
(`FREN_GATEWAY_TOKEN`, dev default `dev-token`). It is the only process that
holds provider credentials, and the only place prompts live. Endpoints:
`GET /health`, `POST /v1/summarize`, `POST /v1/chat`.

Providers live in `apps/gateway/providers/` behind one interface —
`complete({system, messages, schema, maxTokens}) -> string` — so swapping the
model never touches the desktop app:

| Provider | Model | How |
|---|---|---|
| `deepseek` | `deepseek-chat` | plain `fetch`, OpenAI-compatible; JSON mode for structured replies |
| `anthropic` | `claude-haiku-4-5` | `@anthropic-ai/sdk`, JSON Schema structured outputs |
| `mock` | — | deterministic, offline, no credentials |

The choice comes from `FREN_LLM_PROVIDER` when set, otherwise from whichever
key is present (DeepSeek first). Anything that fails to construct degrades to
the mock rather than taking the app down, so fren stays usable without a model.

### `packages/shared` — config, env, types

`config.js` is the one place for tunables (intervals, retention caps, port,
model). `env.js` is a minimal `.env` loader (real environment variables win).
`types.js` holds JSDoc typedefs only — a shared vocabulary, no runtime code.

### `packages/memory` — storage

Owns the SQLite database (built-in `node:sqlite`, no native npm dependency) at
`~/Library/Application Support/fren/fren.db`. Provides the write/read/prune API
used by the observer and summarizer, and the read API used by chat.

### `packages/intelligence` — prompts and providers

Prompt construction and provider abstraction for the gateway: the real Anthropic
provider and the mock provider behind one interface. Lives server-side so
prompts and models can change without touching the desktop app.

### `start.js` — dev runner

Spawns the gateway and the Electron app together and shuts both down when either
exits or on Ctrl-C. `npm run gateway` / `npm run desktop` run them separately.

## Data model

Three tables in `fren.db`:

| Table | What it holds | Written by | Retention |
|---|---|---|---|
| `observations` | Raw samples: timestamp (epoch ms), active app, window title, optional local screenshot path | observer | 7 days |
| `memories` | Compact semantic summaries derived from the timeline (activity text, applications, confidence) | summarizer | kept |
| `suggestions` | Groundwork for M2/M3 pattern detection and proposed automations | nothing yet | n/a |

Screenshot files live next to the database in the userData folder, capped at the
newest 200. The `screenshotPath` column stores a local file path — the file
itself never enters the database or any request.

Shared shapes (`Observation`, `ActivitySummary`, `MascotState`, `AppState`) are
defined as JSDoc typedefs in `packages/shared/types.js`.

## Request flows

### Observe tick (every 5s, only while observing)

1. Observer runs `lsappinfo` → active app name.
2. Observer runs `osascript` (System Events) → frontmost window title (skipped
   without Accessibility permission).
3. Every 3rd tick: `desktopCapturer` → JPEG written to the userData folder
   (skipped without Screen Recording permission).
4. One row inserted into `observations`. Nothing leaves the machine.

### Summarize cycle (every 2 min)

1. Summarizer reads observations since the last cycle; skips if fewer than 4.
2. Builds a text timeline (timestamps, app names, window titles — no
   screenshots, no paths).
3. `POST /v1/summarize` to the gateway with the bearer token.
4. Gateway builds the prompt (`packages/intelligence`) and calls the model (or
   mock).
5. Response — a compact activity summary — is stored as a row in `memories`.
6. Pruning runs: observations older than 7 days deleted, screenshots beyond the
   newest 200 deleted.

### Chat

1. User types a question in the chat panel; renderer sends it to the main
   process over IPC. Mascot switches to `thinking`.
2. Main process loads context from SQLite — recent memories (last 8h) plus
   the recent raw timeline (up to 50 newest observations) — and sends
   `POST /v1/chat` with the question and that context to the gateway.
3. Gateway calls the model (or mock) and returns the reply.
4. Renderer shows the answer; mascot returns to its previous state.

## Milestones

| Milestone | Loop stage | Status |
|---|---|---|
| **M1** | OBSERVE → UNDERSTAND → REMEMBER, plus chat over memories | **Implemented in v0.1** |
| **M2** | DETECT PATTERNS → SUGGEST: notice repeated workflows in memories, surface them via the `idea` state | Groundwork only: `suggestions` table and mascot state exist; no detection logic |
| **M3** | AUTOMATE: propose concrete automations for confirmed patterns (propose, never act autonomously) | Groundwork only: nothing beyond schema |

The bet, in order: memory must be accurate before patterns are worth detecting,
and patterns must be trusted before automations are worth proposing.
