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
microphone is opened only while you are physically holding the mic button
down, and released the moment you let go — the macOS recording indicator is
the second source of truth for this.

What happens to that audio matters more than how it is captured:

| Step | Where it happens |
|---|---|
| Recording | In the app, only while the button is held |
| Transcription | **On this machine**, by `whisper.cpp` — a temp `.wav` is written, read, and deleted |
| The transcript | Sent to your model provider exactly like a message you typed |
| The audio itself | **Never leaves the machine. Never stored. Never sent to any API.** |

This is why fren uses local whisper rather than a cloud speech API: a cloud
API would mean streaming your room — and anyone else in it — to a third party.
If `whisper.cpp` is not installed the mic button is disabled and says so; voice
input simply does not work, rather than quietly falling back to the network.

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

Data leaves your machine on exactly one path: desktop app → local gateway
(`127.0.0.1:4519`, bearer-token auth) → your chosen model provider
(DeepSeek or Anthropic). Nothing else makes
network requests with your data.

**Sent (only this):**

| Data | When |
|---|---|
| App names, window titles, timestamps (the activity timeline) | Summarize cycle, every 2 minutes while observing |
| Your typed chat questions | When you send a chat message |
| Derived activity summaries **and the recent raw timeline** (up to the last 50 observed app/title entries) as context | When you send a chat message |
| Derived activity summaries from the last 8 hours | Every 12 minutes while observing, to look for a repeated workflow |
| **One screenshot** | Only when you press the eye button. Never automatically. |
| Transcribed text of what you said (never the audio) | When you use push-to-talk |
| The contents of `SOUL.md` and `USER.md` | With every chat message, once you have completed first-run setup |
| The text of fren's reply, to ElevenLabs | Only when a voice key is configured |

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

## Storage locations

Everything is local, under Electron's userData folder:

```
<userData>/
├── SOUL.md          # who fren is — written from your first conversation
├── USER.md          # what you told fren about yourself
├── MEMORY.md        # durable facts worth keeping
├── memory/
│   └── 2026-08-22.md    # what fren observed that day
├── fren.db          # SQLite: observations, memories, suggestions, settings
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

Pruning runs on its own timer inside the desktop app, every couple of minutes
for as long as fren is running — it does not depend on observation being on,
on the gateway being reachable, or on you remembering to clean up.

(Tunables: `OBSERVATION_RETENTION_DAYS` and `MAX_SCREENSHOTS_KEPT` in
`packages/shared/config.js`.)

## How to pause

**The very first launch is the exception, and it matters.** fren wakes up by
itself to introduce itself, which means it is watching from the moment it
appears. The first thing it says is exactly that — its light is on, that means
it is watching, and tapping it stops that. Capture is real during the
introduction: app names and window titles are recorded like any other time.

If it were lit without observing, the light would be a lie, and the light is the
whole basis on which this app asks to be trusted. So it is genuinely on, and it
says so first.

**Every launch after the first starts paused.** fren captures nothing until you
wake it. Clicking the sphere
wakes it — that is a deliberate act, and the change is unmistakable: the light
comes on, the colour warms, the eyes open.

To stop, open the panel and click **"pause watching"**. The light goes out, the
eyes close, everything stops. There is no partial state and no background
trickle while paused.

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
