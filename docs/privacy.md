# Privacy

fren watches your screen for a living, so this document is precise. It states
what is captured, when, what leaves the machine, where everything is stored, how
long it is kept, and how to stop or erase all of it.

## Capture states

There are exactly two, and the character itself is the truth:

| State | How fren looks | What is captured |
|---|---|---|
| Observing ON | Lit from within, eyes open, colour warm | Active app name + window title every 5s; local screenshot every ~15s |
| Observing OFF | Light out, eyes closed, colour drained | **Nothing. No sampling, no screenshots, no summarizing, no timers.** |

This is not a UI convention layered over a background process. The `observing`
flag lives in one place in the Electron main process
(`apps/desktop/main/state.js`) and is only ever changed together with starting
or stopping the observer, and every face change in the renderer is funnelled
through a check on it — so no conversation, animation or error path can light
the face up while capture is off. Lit ⇔ capturing, by construction. If the app
cannot reach that state at all (say the preload bridge fails), the face stays
dark: the fallback fails closed.

Keystrokes are **never captured in any state**. fren has no keylogger, no input
monitoring, no clipboard access.

## The microphone

fren does **not** listen continuously, and there is no wake word. The
microphone opens when you click the orb and closes when you click it again —
the macOS recording indicator is the second source of truth for this.

This changed, and the change is worth being plain about. It used to be
press-and-hold, where the bound on a recording was your own hand. A recording
you start with a click and stop with another has no such bound, so two things
replace it: **a ring pulses around the orb the entire time the microphone is
open**, deliberately separate from the face so it is just as visible when fren
is paused and dark as when it is watching; and **a recording stops itself after
two minutes**, so a forgotten microphone is a mistake rather than an afternoon.

The mic button inside the chat panel is still press-and-hold. A button you hold
is unambiguous, and it costs nothing to keep.

What happens to that audio matters more than how it is captured:

| Step | Where it happens |
|---|---|
| Recording | In the app, only while the button is held |
| Transcription | **On this machine**, by `whisper.cpp` — a temp `.wav` is written, read, and deleted |
| The transcript | Sent to your model provider exactly like a message you typed |
| The audio itself | **Never leaves the machine. Never stored. Never sent to any API.** |

While the microphone is open fren is conspicuous about it: a tone when it
opens, a tone when it closes, and a face that brightens and pulses with the
level of your voice. That level is metered from the live input and used for
nothing else — it never leaves the renderer, and it is not recorded.

This is why fren uses local whisper rather than a cloud speech API: a cloud
API would mean streaming your room — and anyone else in it — to a third party.
If `whisper.cpp` is not installed the mic button is disabled and says so; voice
input simply does not work, rather than quietly falling back to the network.

## Running automations

There are now two kinds, and they are different things.

**What fren notices reaches its own core.** The active application and window
title, and the pages the browser extension reports, are sent to fren's local
core (the same process that keeps automations), never to a model, so that an
automation you created to run *whenever* an app or a site is in front of you
can fire. They are kept in memory for a day and forgotten. When such an
automation fires, the assistant is told the app or site that fired it, with
the window title or address, and nothing else about your day.

**Agent automations** run an assistant with tools inside the *secure execution
environment*: a separate space with its own workspace, no access to your
files, accounts or the rest of this machine unless you grant it, and the model
reached through fren's own proxy so no key ever enters it. On a Mac that
space is a process confined by macOS itself (the same sandbox the system uses
for its own apps): it can read and write only the folders fren gives it,
cannot open apps, script the desktop, read the keychain or take screenshots,
and reaches the network only as its automation allows. That is lighter
isolation than a container, and fren says so in Settings; when a container
runtime is installed, fren uses a container instead. One is created only
when you keep a proposal fren shows you first, with the schedule and the task
in words. It does not receive what fren observed about you: not the activity
timeline, not memories, not screenshots, not browser pages. It receives the
task, fren's persona (`SOUL.md`), and whatever it fetches itself. It reaches
the web only through fren's own proxy, which lets it out to the exact domains
its automation declares and refuses every other host; each automation states
the domains it may reach, and an automation that declares none reaches no
website at all. The domains are worked out when you create it and shown before
you keep it, so the reach is a thing you saw and agreed to. When you are there
talking to fren and something it is doing needs a host it was not given, fren
holds the connection and asks — reach this one site, once or always, or no —
rather than failing quietly; a yes opens exactly that host (an "always" is
remembered for next time) and nothing else, and if no one answers, the answer
is no. What it
sends back is kept locally, listed under Automations with every run, and
never sent anywhere by fren. An agent automation does not look at what you are
doing, so the light does not gate it: it runs on its schedule whether fren is
watching or paused, and stops when fren quits. If an agent asks for something
beyond what it was granted, fren asks you, and an unanswered request is a no.

An agent can also ask fren to *do* a few things for you through fren's own
tools, reached over the same one loopback door as the model, and each one is
fren's to grant, not the agent's to take. Today that is a notification: an
agent that has something for you — a result you asked to be alerted about — can
ask fren to show you a desktop notification. The first time, fren asks whether
to allow it and remembers your answer, the way the operating system asks once
before an app may notify you; after that, an allowed automation can reach you
even while you are away. The notification carries only the words the agent
wrote; the agent never gets your attention without fren's leave.

**Script automations** are the older kind, and this is the one thing fren does
that changes your machine rather than reading it, so the constraints are worth
stating plainly.

fren only runs a script that **you** read and approved, that has already run
successfully **by hand**, and that you separately put on a schedule. Approval is
bound to a hash of the exact script — change one character and the approval is
void. Every execution re-checks that hash, so a schedule cannot become a licence
to run something else later.

A script runs with a reduced environment (PATH, HOME, USER, LANG, TMPDIR only),
so it cannot read variables this process holds. It gets a hard timeout. Its
output is captured and stored locally so you can read afterwards what it did —
that output is never sent anywhere.

fren will not run scripts that delete data, escalate privileges, pipe a download
into an interpreter, read credentials or keychains, or install anything
persistent. That blocklist is a backstop for a rushed review, not a sandbox.

## Looking at your screen

fren can look at your screen and answer a question about it. This is the only
thing fren does that sends an image anywhere, and it is built to be impossible
to do by accident:

- **There is no setting to leave on.** Every look is a separate press of the eye
  button next to the message box. There is no standing permission that can be
  enabled once and forgotten.
- **It says so, every time.** "Taking one look at your screen…" appears before
  the image is sent, not after.
- **It is refused while fren is paused.** Looking with the light off is exactly
  what the light exists to rule out.
- **The image is never written to disk.** It is captured in memory, sent once,
  and dropped. It is not the observed screenshots — those are a separate code
  path that never transmits anything.
- **The button does not exist unless a model that can see is configured.**
  DeepSeek's chat models are text-only. This needs an `ANTHROPIC_API_KEY`.
- The model is instructed to answer your question and ignore the rest of the
  screen — and specifically not to mention credentials, private messages, other
  people's names or financial details if they happen to be visible.

A screenshot of your desktop contains whatever was on it. Treat one look as
handing over that whole frame, because that is what it is.

## What leaves the machine

Data leaves your machine through the local gateway (`127.0.0.1:4519`,
bearer-token auth), which is the only process holding a key, to: your chosen
model provider (DeepSeek or Anthropic); ElevenLabs, for the text of a reply,
only when a voice key is set; and a vision endpoint, for one screenshot, only
when you press the eye button. Nothing else in the desktop app makes network
requests with your data.

The secure execution environment is the exception, and it is stated rather
than hidden: when a chat request or an automation runs there, the assistant
inside talks to the model provider through the gateway's proxy and can fetch
pages from the internet on its own. It gets the task and `SOUL.md`, never your
observations, memories, screenshots or browser pages. See "Running
automations".

**Sent (only this):**

| Data | When |
|---|---|
| App names, window titles, timestamps (the activity timeline) | Summarize cycle, every 2 minutes while observing |
| Your typed chat questions | When you send a chat message |
| Derived activity summaries **and the recent raw timeline** (up to the last 50 observed app/title entries) as context | When you send a chat message |
| Derived activity summaries from the last 8 hours | Every 12 minutes while observing, to look for a repeated workflow |
| Derived activity summaries from the last 5 hours, plus `SOUL.md` | At most a few times a day while observing, when fren considers asking you something (see "When fren asks you things") |
| A question fren asked and your answer to it | Right after you answer one, to decide whether anything in it is worth keeping |
| Your name, roughly how long fren was closed, the last activity noted **before** it closed, and up to six lines of `MEMORY.md` | Once per arrival, to write the greeting (see "Saying hello") |
| The same context a chat message sends | When a routine you set up comes round. Routines never fire while fren is paused. |
| **One screenshot** | Only when you press the eye button. Never automatically. |
| Transcribed text of what you said (never the audio) | When you use push-to-talk |
| The contents of `SOUL.md` and `USER.md` | With every chat message, once you have completed first-run setup |
| The text of fren's reply, to ElevenLabs | Only when a voice key is configured |
| What you typed, and `SOUL.md`, to the assistant in the secure execution environment; from there, to the model provider | When a chat request runs through the environment (the dot in the chat header says when it is ready) |
| An automation's task, and whatever pages the assistant fetches to do it | When an agent automation runs |

Chat context is drawn from what was captured earlier: asking a question while
paused still sends recent history that was recorded while fren was lit.
Pausing stops new capture; it does not redact what you already let fren see.

**Never sent, to anyone, ever:**

- **Observed screenshots.** The ones fren takes on its own timer, roughly every
  15 seconds while watching, are written as local JPEGs and pruned
  automatically. They are not sent to the gateway, not sent to the model
  provider, not uploaded anywhere. The summarizer works from the text timeline
  alone. **This has not changed**, and the separation is enforced in the code:
  the observer has no way to reach the gateway at all, and a test asserts it.

  There is now one narrow exception, and it is a different code path with a
  different promise — see "Looking at your screen" below. Nothing fren captures
  by itself is ever transmitted.
- **The SQLite database.** It never leaves the userData folder.
- **Keystrokes.** Not captured at all (see above), so there is nothing to send.
- **Microphone audio.** Transcribed locally and deleted; only the resulting
  text is ever transmitted.

The API key is used only by the gateway process. The desktop app reads the
shared `.env` for its own settings but deletes `DEEPSEEK_API_KEY`,
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from its environment at startup
(`apps/desktop/main/index.js`), so provider credentials never live in the
process that captures your screen.

Which provider you use changes who sees that data. DeepSeek and Anthropic have
different data-handling policies — read the one you pick.

## Choosing a model, a voice, an ear

The Settings pane in the dashboard lets you pick which model answers, which
ElevenLabs voice speaks, and which whisper model and language transcribe you.
All of it is optional — every field empty means "whatever fren was started
with", which is what a fresh install already has. Each field shows the live
default as its placeholder, so leaving one alone is a visible choice.

**Three things are deliberately not configurable there**, and the reasons are
the same reasons the rest of this document holds:

- **API keys.** That window belongs to the process that watches your screen, and
  that process deletes every provider key from its own environment at startup
  (`apps/desktop/main/index.js`). A field that accepted one would put a secret
  back into it, and into the SQLite file sitting next to your screenshots. Keys
  live in `.env`, which only the gateway reads.
- **Provider addresses.** A base URL is *where the key gets sent*. Somewhere to
  send a credential is not a preference; it is the single most useful field for
  anything that got into the app to set. It stays an environment variable.
- **The whisper binary.** The model is a data file whisper.cpp loads. The binary
  is the program that runs. Choosing which executable gets launched is not a
  checkbox — it stays `FREN_WHISPER_BIN`, where setting it is a deliberate act
  at a shell.

What you do set is checked before it is stored and again before it is used: ids
must look like ids, a whisper model must be a `.bin` file that actually exists,
a language must be two letters. Anything else is discarded and fren falls back
to its default, which is always a working state. A model id that is well-formed
but wrong (a model your provider does not have) comes back as the provider's own
error, so you can see what happened.

Model and voice ids travel to the local gateway with each request. No new
category of data leaves the machine.

## Saying hello

fren greets you when you launch it, in a sentence written for that moment. It
is generated, so it needs the model: your name, how long fren was shut, and the
last activity it noted BEFORE closing are sent to your provider, along with up
to six lines from `MEMORY.md`. Nothing live is sent — fren has no idea what is
on your screen at that instant, and the prompt says so in as many words.

It greets on an **arrival**, not on a launch: relaunch within 30 minutes and it
stays quiet, which also means a day of restarts costs one greeting rather than
twenty. It never greets during first-run setup, and never when no model is
configured. If the gateway is slow or down the greeting is silently dropped.

The greeting is spoken only if your machine can actually be heard; on a muted
machine it is written to the panel instead and no speech is generated. Unlike a
reply you asked for, it will never open the panel by itself.

Rules enforced in the prompt, because a greeting is the easiest place to imply
something untrue or to sound like a machine: fren must not suggest it saw
anything while it was closed; it must not read a **personal** last activity back
to you (messaging, shopping, private browsing), because that is a receipt rather
than a welcome; it must not pass judgement on work it only saw the title of; and
**it must never tell you how long you were away**. The gap reaches the prompt
only as a coarse tone — "a night in between" — with no figure in it to quote.
Being told by your own computer how long you were off it is a meter reading, not
a hello. The same applies to ordinary replies: fren says what you were doing,
not how many minutes you did it for, unless you ask.

## When fren asks you things

Separately from noticing workflows, fren occasionally interrupts to ask you
something about what you have been doing — and writes down the durable part of
your answer. This is how it comes to know you rather than just watch you, and
it is the same thing the first-run interview does, continued slowly.

It is off unless you turned it on. The setup question *"when I notice
something, should I speak up or wait until you ask?"* decides it: fren only
interrupts if you said it could. If you never completed setup, it does not.

**When it will not ask:**

- while fren is paused (a paused fren saw nothing to be curious about)
- within four minutes of anything you said to it
- in the first 25 minutes of a session
- more than three times a day, or twice within about 100 minutes
- about something it has asked about before — including reworded, and including
  across restarts

Beyond those, most opportunities are skipped at random, so it does not arrive
like a scheduled reminder.

**What it keeps.** Your answer goes to the model once, to judge whether it holds
anything still true in a month. If it does, one line lands in `MEMORY.md` under
`## Facts` — plain Markdown you can read, edit, or delete, and the file is
capped at 80 facts. Most answers keep nothing. Nothing else about the exchange
is stored, and the question itself is never written to the log.

**To turn it off**, open the Memory pane and untick *"Let fren interrupt you"*.
Pausing fren also stops it, along with everything else.

## Storage locations

Everything is local, under Electron's userData folder:

```
<userData>/
├── SOUL.md          # who fren is — written from your first conversation
├── USER.md          # what you told fren about yourself
├── MEMORY.md        # durable facts worth keeping
├── memory/
│   └── 2026-08-22.md    # what fren observed that day
├── fren.db          # SQLite: observations, memories, suggestions, settings,
│                   #         and the conversation
└── (screenshots)    # JPEG files, max width 1280px
```

`<userData>` is `~/Library/Application Support/fren` on macOS,
`%APPDATA%\fren` on Windows, and `~/.config/fren` on Linux.

The Markdown files are deliberately Markdown. You can open `SOUL.md`, read
exactly what fren believes it is supposed to be, rewrite it, and it takes effect
on your next message — the file is read fresh every time, not cached at launch.
A companion that has formed opinions about you in a binary you cannot read is a
worse thing than one that has not formed any.

`SOUL.md` and `USER.md` are sent to the model with each chat message. The daily
logs and `MEMORY.md` are not sent; they are for you.

The `settings` table holds what you TOLD fren during first-run setup — your
name and your two answers about what you are working on and what you would like
help with. Unlike observations it is never pruned, because a name going stale
after seven days would be worse than useless. Deleting the data folder removes
it along with everything else, and fren will introduce itself again next time.

## Retention

| Data | Retention |
|---|---|
| Raw observations (app, title, timestamp) | 7 days, then pruned automatically |
| Screenshots | Newest 200 kept, older ones deleted automatically |
| Memories (semantic summaries) | Kept until you delete the data folder |
| **The conversation** | **7 days, on the same clock as observations** |

Pruning runs on its own timer inside the desktop app, every couple of minutes
for as long as fren is running — it does not depend on observation being on,
on the gateway being reachable, or on you remembering to clean up.

(Tunables: `OBSERVATION_RETENTION_DAYS` and `MAX_SCREENSHOTS_KEPT` in
`packages/shared/config.js`.)

## How to pause

**The very first launch is the exception, and it matters.** fren wakes up by
itself to introduce itself, which means it is watching from the moment it
appears. The first thing it says is exactly that — its light is on, that means
it is watching, and the menu on a right-click stops that. Capture is real during the
introduction: app names and window titles are recorded like any other time.

If it were lit without observing, the light would be a lie, and the light is the
whole basis on which this app asks to be trusted. So it is genuinely on, and it
says so first.

**fren wakes up when you launch it.** This is a change: it used to start dark
after the first run. Being awake means it IS watching — the light is not
decoration, and this document's central claim (lit ⇔ capturing) holds in both
directions, which is why an awake face on launch is a true statement rather than
a convenient one.

You decide this, and you are asked directly. The last question of the first-run
interview is whether fren should be awake when it launches or wait in the dark
until you say so, and the answer is stored as `wakeOnLaunch`. If you say wait,
fren pauses immediately and starts dark from then on.

If you completed setup before that question existed, the default is awake. To
change it, open the Memory pane and untick **"Wake up when you launch me"** — it is there whether or not you did the
interview — or
just use the watching control in the menu to pause the session you are in.

One consequence worth naming: scheduled script automations only run while
fren is watching, so a fren that starts awake can run a due automation shortly
after launch, where before it needed you to wake it first. (Agent automations
are not gated by the light; see "Running automations".) Scheduled runs are held for
the first two minutes after launch so there is time to pause, and all three
execution gates still apply — see "Running automations" above.

To stop, right-click the orb for the menu and use the watching control there —
a left click records now rather than pausing. The
light goes out, the eyes close, everything stops. There is no partial state and
no background trickle while paused. Hovering the orb always says which of the
two it currently is.

## The conversation is now written down

This changed, and it is the most sensitive thing in this document, so it gets
its own section rather than a line in a table.

**What changed.** Until recently the conversation existed only inside the chat
panel. Closing the panel lost it; nothing was ever written to disk. It is now
stored in `fren.db`, so that it can be read back in the big window — everything
you say to fren, and everything it says to you, in plain text in a local SQLite
file.

**Why.** A companion you cannot re-read is a companion you cannot check. The
whole argument of this document is that you can see what fren knows; a
conversation that evaporated was the one part you could not.

**What is NOT stored.** Only the exchange itself: what you asked and what fren
answered. Written where both halves are visible, in the main process, which
means the things that merely *appear* in the panel stay out of it — error
notices, the first-run interview (your answers to that already live in
`settings`), and the greeting, which is generated fresh each time and is not
something you said.

**It expires.** Seven days, pruned on the same timer as observations. A
transcript that outlived the observations it discusses would leave the most
sensitive thing here as the longest-lived, which is the wrong way round.

**You can drop it at any time**, without touching anything else: the Chat
section of the big window has *Forget this conversation*, and it does exactly
that and nothing more. There is no confirmation dialog, because this is the
direction you are entitled to take without being argued with.

**Is this a change in kind?** Honestly, partly. fren already kept window titles,
screenshots and daily observation logs — arguably more revealing than a chat
log. But those are things fren *saw*, and this is a thing you *said*, which
people reasonably feel differently about. If you would rather it were not kept,
the button above is the answer, and deleting the data folder still removes
everything.

## How to delete everything

1. Quit fren.
2. Delete `~/Library/Application Support/fren/`.

That is the entire footprint. There is no cloud account, no sync, no server-side
copy. What your model provider has seen (timelines, summaries, chat text) is
governed by that provider's own policies — [Anthropic's](https://www.anthropic.com/legal/privacy)
or [DeepSeek's](https://platform.deepseek.com) — and fren sends nothing there
beyond the categories listed above.

## macOS permissions

On macOS, fren uses three permissions, and works with degraded data if you
decline any. Windows needs none of them for window titles; Linux needs
`xdotool` and `xprop` installed rather than a permission.

| Permission | Used for | Without it |
|---|---|---|
| Screen Recording | Screenshots | No screenshots; app names + window titles only |
| Accessibility | Window titles (via System Events) | App names only |
| Microphone | Push-to-talk voice input | Mic button disabled; typing still works |

How they are requested: the first time you wake fren up, the window-title
lookup triggers the Accessibility/Automation prompt, and fren makes one
throwaway capture attempt so macOS registers it in the Screen Recording pane
(newer macOS versions show a prompt; older ones only list the app there —
enable it manually).

In development the app appears as **"Electron"** in System Settings → Privacy &
Security, because it runs under the stock Electron binary. Permission changes
take effect after restarting the app.
