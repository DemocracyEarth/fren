# fren

## What is this?

fren is a minimal ambient AI companion that lives on your macOS desktop. It is a
small floating orb with eyes. When the eyes are **open**, fren is observing what
you do — which app is active, what the window title says, an occasional local
screenshot. When the eyes are **closed**, it observes nothing at all. The eyes
and the capture pipeline share one source of truth in the Electron main process,
so what you see is what is happening.

fren's long-term loop is:

**OBSERVE → UNDERSTAND → REMEMBER → DETECT PATTERNS → SUGGEST → AUTOMATE**

Version 0.1 (Milestone 1) implements the loop through REMEMBER, plus a chat
panel so you can ask fren about your own activity. Pattern detection (M2) and
proposed automations (M3) exist only as groundwork — schema and scaffolding, no
behavior.

This is a proof of concept, deliberately small: plain CommonJS JavaScript, no
build step, no frameworks.

## What hypothesis are we testing?

That an ambient companion which quietly builds a semantic memory of your work
can produce one specific moment of value: **fren notices a repeated workflow you
never told it about** — "every morning you open the same three apps and copy
data from A to B" — and offers to help. Everything in this codebase is in
service of getting to that moment cheaply. If the moment never lands, the rest
does not matter.

v0.1 tests the necessary precondition: can a timeline of app names and window
titles, summarized by a small model every two minutes, produce memories that are
accurate and useful enough to chat with?

## How does it work?

```
┌──────────────────────────── Electron desktop app ───────────────────────────┐
│                                                                             │
│  mascot UI          observer                memory            summarizer    │
│  (orb, eyes,   ←→   (samples every 5s:  →   (SQLite,     ←→   (every 2 min: │
│  chat panel)        app + window title,     local only)       timeline →    │
│                     screenshot ~15s,                          gateway,      │
│                     stored locally)                           stores a      │
│                                                               memory)       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP, 127.0.0.1:4519, bearer token
                                       │ (app names, titles, timestamps,
                                       │  chat text — NEVER screenshots)
                                       ▼
                             ┌──────────────────┐        ┌───────────────┐
                             │  local gateway   │  ───→  │ Anthropic API │
                             │  (holds API key, │        │ claude-haiku- │
                             │  prompts)        │        │ 4-5           │
                             └──────────────────┘        └───────────────┘
```

- The **desktop app** samples your active app and window title every 5 seconds
  and takes a local screenshot roughly every 15 seconds. Raw observations go
  into a local SQLite database.
- Every 2 minutes, the **summarizer** sends the recent app/window timeline —
  text only, never screenshots — to the local gateway, which asks the model for
  a compact summary ("debugging the auth flow in VS Code and Chrome"). That
  summary is stored as a memory. Old raw data is pruned.
- The **gateway** is a separate local process that holds the Anthropic API key
  and all prompts. The desktop app never touches provider credentials.
- The **chat panel** lets you ask questions; fren answers using its stored
  memories.

See [docs/architecture.md](docs/architecture.md) for the full picture.

## How do I run it?

Requirements: macOS, Node.js >= 23 (for built-in `node:sqlite`).

```sh
npm install
cp .env.example .env     # set ANTHROPIC_API_KEY, or leave empty for mock mode
npm start                # starts the gateway and the desktop app together
```

Without an API key the gateway runs a **mock provider** — everything works
offline, with canned summaries and chat replies. Useful for development.

Other commands:

```sh
npm run gateway    # gateway only
npm run desktop    # desktop app only (expects a gateway on 127.0.0.1:4519)
npm test           # node --test suites for memory, intelligence, gateway
```

macOS will ask for permissions the first time (in dev the app shows up as
"Electron" in System Settings, because it runs under the stock Electron binary):

- **Screen Recording** — needed for screenshots. Without it, fren degrades
  gracefully to app + window title only.
- **Accessibility** — needed for window titles. Without it, fren degrades to
  app names only.

Permission changes require an app restart.

## Where is data stored?

Everything lives locally in Electron's userData folder:

```
~/Library/Application Support/fren/
├── fren.db          # SQLite: observations, memories, suggestions
└── (screenshots)    # local JPEGs, capped at 200, pruned automatically
```

Raw observations are kept for 7 days. To delete everything fren knows: quit the
app and delete that folder. There is no cloud copy to chase down.

## What information reaches the LLM?

Only this, and only via the local gateway:

- app names, window titles, and timestamps (the activity timeline)
- your typed chat questions
- derived activity summaries

What **never** leaves your machine:

- screenshots (captured only while observing, stored locally, pruned
  automatically — not even sent to the gateway)
- the SQLite database
- keystrokes (never captured at all, by anything)

Full details in [docs/privacy.md](docs/privacy.md).

## How do I turn observation off?

Click the orb. Eyes close, observation stops — no sampling, no screenshots, no
summarizing. This is a single boolean in the main process; the eyes cannot be
closed while capture runs, and capture cannot run while the eyes are closed.
When observation is OFF, nothing is captured at all.

## What is deliberately NOT implemented?

These are designed to exist later. They are not built now, and the code does not
pretend otherwise:

- voice input/output
- autonomous mouse/keyboard control (fren proposes; it does not act)
- a browser extension
- WhatsApp or mobile clients
- multi-device sync
- plugins or a marketplace
- remote control of any kind
- complex agent frameworks
- a vector database (SQLite is enough at this scale)

If you find code for any of the above in this repo, it is a bug in the docs or
in the code — file an issue.
