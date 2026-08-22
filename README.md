# fren

## What is this?

fren is a minimal ambient AI companion that lives on your macOS desktop. It is a
small floating sphere with a face lit from within. When the light is **on** and
the eyes are **open**, fren is observing what you do — which app is active, what
the window title says, an occasional local screenshot. When the light goes
**out** and the eyes **close**, it observes nothing at all. That signal and the
capture pipeline share one source of truth in the Electron main process, so what
you see is what is happening.

fren's long-term loop is:

**OBSERVE → UNDERSTAND → REMEMBER → DETECT PATTERNS → SUGGEST → AUTOMATE**

Version 0.1 (Milestone 1) implements the loop through REMEMBER, plus a chat
panel so you can ask fren about your own activity. Pattern detection (M2) and
proposed automations (M3) exist only as groundwork — schema and scaffolding, no
behavior.

This is a proof of concept, deliberately small: plain CommonJS JavaScript and
no build step. The one exception is the face — it renders with WebGL via a
vendored copy of three.js (~740KB, checked in, unmodified), because measurement
showed the 3D renderer costs about a third of the CPU the SVG one did while
looking considerably better. The SVG renderer is still in the tree and is used
automatically if WebGL is unavailable.

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
│  (sphere,      ←→   (samples every 5s:  →   (SQLite,     ←→   (every 2 min: │
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
                             │  local gateway   │  ───→  │ DeepSeek  or  │
                             │  (holds API key, │        │ Anthropic     │
                             │  prompts)        │        │ (or mock)     │
                             └──────────────────┘        └───────────────┘
```

- The **desktop app** samples your active app and window title every 5 seconds
  and takes a local screenshot roughly every 15 seconds. Raw observations go
  into a local SQLite database.
- Every 2 minutes, the **summarizer** sends the recent app/window timeline —
  text only, never screenshots — to the local gateway, which asks the model for
  a compact summary ("debugging the auth flow in VS Code and Chrome"). That
  summary is stored as a memory. Old raw data is pruned.
- The **gateway** is a separate local process that holds the API key and all
  prompts. It picks a provider from whichever key is present — DeepSeek or
  Anthropic — and falls back to an offline mock when there is none. The desktop
  app never touches provider credentials and never learns which model answered,
  so providers can be swapped without changing the client.
- The **chat panel** lets you ask questions; fren answers using its stored
  memories.

See [docs/architecture.md](docs/architecture.md) for the full picture.

## How do I run it?

Requirements: macOS, Node.js >= 23 (for built-in `node:sqlite`).

```sh
npm install
cp .env.example .env     # set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY (empty = mock mode)
npm start                # starts the gateway and the desktop app together
```

Without an API key the gateway runs a **mock provider** — everything works
offline, with canned summaries and chat replies. Useful for development.

Other commands:

```sh
npm run gateway    # gateway only
npm run desktop    # desktop app only (expects a gateway on 127.0.0.1:4519)
npm test           # node --test suites for memory, intelligence, gateway, desktop
```

The first time you wake fren up, macOS will prompt for Accessibility and
register the app under Screen Recording in System Settings (newer macOS
versions prompt for it too; on older ones, enable it manually and restart).
In dev the app shows up as "Electron", because it runs under the stock
Electron binary:

- **Screen Recording** — needed for screenshots. Without it, fren degrades
  gracefully to app + window title only.
- **Accessibility** — needed for window titles. Without it, fren degrades to
  app names only.
- **Microphone** — only for push-to-talk. Declining disables the mic button;
  typing still works.

Permission changes require an app restart.

### Giving fren a voice

Both halves are optional and independent.

**Listening** is local. Install whisper.cpp and a model:

```sh
brew install whisper-cpp
mkdir -p ~/.cache/whisper.cpp
curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Both are auto-detected. Then **hold** the mic button in the panel to talk and
release to send. Nothing is recorded unless the button is down, and the audio
is transcribed on this machine — it never leaves it.

**Speaking** uses ElevenLabs. Put `ELEVENLABS_API_KEY` in `.env`. Without it
fren simply replies in text. When it is set, the reply text (only) is sent to
ElevenLabs and the mouth is driven by the returned audio's own amplitude.

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
- derived activity summaries and the recent raw timeline (up to the last 50
  observed app/title entries), sent as context with each chat message
- the transcript of anything you say with push-to-talk — never the audio
- the text of fren's reply, if you configured a voice

What **never** leaves your machine:

- screenshots (captured only while observing, stored locally, pruned
  automatically — not even sent to the gateway)
- microphone audio (recorded only while you hold the button, transcribed
  locally by whisper.cpp, then deleted)
- the SQLite database
- keystrokes (never captured at all, by anything)

Full details in [docs/privacy.md](docs/privacy.md).

## How do I talk to it?

**Hold the orb and speak.** Release to send. You do not need the chat panel open
— the reply is spoken aloud, and the panel is there for reading back what was
said rather than as the way in.

The orb takes three gestures:

| Gesture | What happens |
|---|---|
| Tap | Wakes fren; once awake, opens or closes the chat panel |
| Hold | Records while held, sends on release |
| Drag | Carries fren anywhere on screen |

You can talk over it. Holding the orb while fren is replying cuts the reply
short and starts listening, and anything you say while it is still thinking is
answered next rather than discarded.

The first time you run fren it introduces itself and asks three short questions
— your name, what you are working on, and what would be useful from it. That
happens while fren is still **dark**, and it says so: nothing is being recorded
during setup, and starting to watch is a separate decision you make afterwards
by tapping it. Your answers are stored locally and sent to the model as context
with each chat.

## How do I turn observation on and off?

fren starts asleep — dark, eyes closed, capturing nothing. **Click it to wake
it up**; that one click lights it, starts observing, and opens the panel. To
stop, click "pause watching". The light goes out, the eyes close,
and observation stops — no sampling, no screenshots, no summarizing. This is a
single boolean in the main process, and every face change in the renderer is
funnelled through a check on it: fren cannot look awake while capture is off,
and capture cannot run while it looks asleep.

## What is deliberately NOT implemented?

These are designed to exist later. They are not built now, and the code does not
pretend otherwise:

- always-on listening (voice is push-to-talk only, by design)
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
