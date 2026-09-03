# fren

## What is this?

fren is a minimal ambient AI companion that lives on your desktop — macOS,
Windows or Linux. It is a
small floating sphere with a face lit from within. When the light is **on** and
the eyes are **open**, fren is observing what you do — which app is active, what
the window title says, an occasional local screenshot. When the light goes
**out** and the eyes **close**, it observes nothing at all. That signal and the
capture pipeline share one source of truth in the Electron main process, so what
you see is what is happening.

fren's long-term loop is:

**OBSERVE → UNDERSTAND → REMEMBER → DETECT PATTERNS → SUGGEST → AUTOMATE**

Version 0.1 implements the loop through **SUGGEST**. fren observes, remembers,
summarises, and looks across hours of those summaries for a workflow you repeat.
When it finds one it either says so or lights up and waits — which of those
depends on what you told it during setup. Version 0.2 opens the **AUTOMATE**
stage behind a runtime seam: with a secure execution environment available,
fren can run an agent for a chat request or on a schedule ("every morning at
9, check Hacker News…") and show you what it did. The environment is optional
and replaceable; see [docs/runtime-architecture.md](docs/runtime-architecture.md).
Without it fren still observes, remembers, suggests and answers from memory.

Restraint is the hard part, not detection. A companion that volunteers something
every ten minutes gets muted on day one, and a muted companion has failed
completely — so a pattern must recur at least three separate times, clear a
confidence floor, and never have been raised before.

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

Requirements: Node.js >= 23 (for built-in `node:sqlite`), on macOS, Windows or
Linux.

Reading which window is in front is the one genuinely platform-specific thing
fren does, and each platform pays a different price for it:

| Platform | App name | Window title |
|---|---|---|
| macOS | `lsappinfo`, no permission needed | `osascript`, needs **Accessibility** |
| Windows | PowerShell, no permission needed | same call, no permission needed |
| Linux (X11) | `xdotool` + `xprop` | `xdotool` |
| Linux (Wayland) | `xdotool` under XWayland, else unavailable | **not available** — the protocol does not permit it |

Where a title cannot be read, fren records the app name alone and says so in the
log rather than pretending. On Wayland that is the ceiling, not a bug.

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

Both are auto-detected. Then **click the orb** to talk, or hold the mic button in the panel, and
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

**Looking at your screen** is opt-in per use: press the eye button next to the
message box and fren sends one screenshot to answer that one question. There is
no setting to leave on, it announces itself before sending, it refuses while
paused, and the image is never written to disk.

It needs a model that can see, and DeepSeek's chat models cannot. Vision is
picked **separately** from text, so this adds a capability without changing
which model answers your chat. Any OpenAI-compatible vision endpoint works —
set `FREN_VISION_API_KEY` (and optionally `FREN_VISION_BASE_URL` and
`FREN_VISION_MODEL`) and point it wherever you like. It defaults to Alibaba's
`qwen-vl-plus`, which is roughly a fifth the price of the cheapest Claude for
this kind of work. An `ANTHROPIC_API_KEY` is used as a fallback if you already
have one.

What **never** leaves your machine:

- the screenshots fren takes on its own timer (stored locally, pruned
  automatically — not even sent to the gateway; a separate code path from the
  eye button, and a test enforces the separation)
- microphone audio (recorded only between the click that starts it and the one
  that stops it, transcribed
  locally by whisper.cpp, then deleted)
- the SQLite database
- keystrokes (never captured at all, by anything)

Full details in [docs/privacy.md](docs/privacy.md).

## How do I talk to it?

**Click the orb and speak. Click again to send.** You do not need the chat panel
open — the reply is spoken aloud, and the panel is there for reading back what
was said rather than as the way in.

While the microphone is open a ring pulses around the orb. It is drawn outside
the character rather than as part of its face, so it reads the same whether fren
is lit and watching or dark and paused — that is the moment you most need to
know the microphone is open, not the least.

| Gesture | What happens |
|---|---|
| Left click | Starts recording; click again to stop and send |
| Right click | Opens the menu — the chat panel |
| Press and move | Carries fren anywhere on screen |
| Scroll | Makes fren bigger or smaller, and it stays that size |

A click and a carry are told apart by what your hand does, not by a timer: move
past a few pixels and you are carrying it, and putting it down never starts or
stops a recording.

A recording stops itself after two minutes. Holding a button had your hand as
its natural bound; a click does not, so it needs one.

You can talk over it. Clicking the orb while fren is replying cuts the reply
short and starts listening, and anything you say while it is still thinking is
answered next rather than discarded.

**While it is listening you can tell.** A short tone marks the microphone
opening and another marks it closing, and the orb turns brighter and glossier
and pulses with your voice — the level comes from the live input, so it is
visibly hearing *you* rather than just showing a state.

**If your machine is muted**, fren opens the chat panel instead of talking to an
empty room. It asks the system before it speaks; where that cannot be asked, it
assumes you can hear it rather than popping a panel you did not need.

The first time you run fren it wakes up, says hello, and asks five short
questions — your name, what you are working on, how it should talk to you,
whether it should speak up or stay quiet, and what would actually be useful.

It asks **out loud**, and the chat panel stays shut: click the orb to answer.
The panel only opens if you open it, or if fren has no voice configured and
therefore cannot be heard at all. Saying "skip" ends the interview, and so does
pausing fren.

The last two answers are not about you — they define fren. They are written to
`SOUL.md` in fren's data folder as instructions it is told to follow, and you
can open that file, rewrite it, and have it take effect on your next message.

## Agent automations

With the secure execution environment ready (the dot in the chat header says
so, and Settings explains what is missing when it is not), say it, spoken or
typed, the way you would to a person. Three shapes are understood: a schedule
(*"every morning at 9, check Hacker News and give me the five most interesting
AI stories"*), a single later moment (*"tomorrow at 3, remind me to call Ana"*,
*"in twenty minutes, tell me to stretch"*), and a *whenever* (*"whenever I open
Figma, remind me to check the design tokens"*, *"when I'm on github.com, list
my open pull requests"*). fren says the proposal back, the time or the trigger
and the task in words, with a **Keep it** chip; a spoken or typed "yes" keeps
it and a "no" lets it go. Nothing is created until you keep it. Kept
automations live under Automations in the full window, where each can be run
now, paused, resumed or deleted, and every run is listed with what came back.
What an automation finds arrives in the chat, spoken like any other reply. A
moment comes once: after it, the automation is done and off. A *whenever*
runs once per sighting, with half an hour between sightings, and is fed by
what fren notices on your desktop; see [docs/privacy.md](docs/privacy.md).

An agent automation runs in isolation: its own workspace, no access to your
files or accounts unless you grant it, and the model reached through fren's
own proxy so no key ever enters the environment. It does not receive what fren
observed about you. Today the environment can reach the internet; that is
stated on the automation and in [docs/privacy.md](docs/privacy.md). The
environment is the vendored runtime host in `vendor/nanoclaw`. On a Mac nothing
else is needed: `npm run runtime:build -- --runner` installs the runner, and
fren runs each agent as a process confined by macOS itself (the system
sandbox), using the Bun and Claude Code it finds on the machine. That is
lighter isolation than a container and Settings says so. With Docker Desktop
running, `npm run runtime:build -- --image` builds the agent image and fren
uses a container instead; `FREN_RUNTIME_TIER=process|container|auto` picks.
Without either (or with `FREN_RUNTIME=mock`) a mock environment stands in, so
the whole loop can be tried with nothing installed.

## Running an automation

fren can run a script it drafted, on a schedule. Three gates stand between a
draft and it running unattended, and they are enforced in that order every
single time — not once, at setup:

1. **You read it and approve it.** Approval is bound to a hash of the exact
   script text, so editing it voids the approval rather than inheriting it.
2. **It ran by hand, successfully, at least once.** A schedule is a promotion
   for something already seen working, never a start.
3. **You turned the schedule on**, separately from both of the above.

Every run is re-checked against the approval hash at the moment it runs, so a
schedule is permission to run one specific script — not standing permission to
run whatever later sits under that name.

Beyond those: a blocklist refuses the obviously catastrophic before anything
reaches a shell (deleting data, privilege escalation, piping a download into an
interpreter, reading credentials, installing persistence). That is the LAST
line, not the first — a blocklist cannot be complete and is not a sandbox. There
is also a hard timeout, no shell interpolation anywhere, a reduced environment
so a script sees none of this process's variables, and every run is recorded
with its output in the dashboard.

Nothing runs while fren is paused, and a missed run expires rather than firing
hours late.

**Routines: tell fren when.** Say "every weekday at nine, tell me what I did
yesterday" and it sets one up. At that time fren asks itself the question, works
it out from what it observed, and reads the answer back.

A routine asks a question — it does not run commands. That is a deliberate
limit: scheduling a generated script is a much larger decision than scheduling a
question, and it is not one this quietly makes for you. A missed routine expires
rather than arriving hours late, and none of them fire while fren is paused.

**There is a second window.** Press **Open ↗** in the panel for a full-size
dashboard: a day at a time down the left, with what you were doing, any stills
fren stored, the patterns it drew across days, the automations it drafted, and
your routines — where you can see when each next runs, what it said last time,
and pause or delete it.
The panel is for glancing; this is for reading back properly. It adds no
capability — everything in it was already on disk.

**To see everything fren holds about you**, open the panel and press ☰. It shows
`SOUL.md`, `USER.md`, `MEMORY.md` and the daily logs verbatim, exactly as they
are on disk, with a button to open the folder in your file manager. Nothing is
summarised on the way out — a companion whose notes about you cannot be
inspected is not a companion.

## How do I turn observation on and off?

On the **first** launch fren wakes by itself to introduce itself, and says so:
its light is on, that means it is watching, and the menu on a right-click stops
that. Capture
is real for that conversation. Lighting up without watching would make the light
a lie, which is worse than starting awake and saying so.

Every launch after that starts asleep — dark, eyes closed, capturing nothing.
**Click it to wake
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
- fren acting on its own initiative. It will RUN an automation it drafted, but
  only one you have read and approved, and only after it has already run
  successfully by hand. See "Running an automation" below — the gates are the
  feature, not an obstacle to it.
- a browser extension
- WhatsApp or mobile clients
- multi-device sync
- plugins or a marketplace
- remote control of any kind
- complex agent frameworks
- a vector database (SQLite is enough at this scale)

If you find code for any of the above in this repo, it is a bug in the docs or
in the code — file an issue.
