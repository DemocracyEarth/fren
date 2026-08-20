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

## What leaves the machine

Data leaves your machine on exactly one path: desktop app → local gateway
(`127.0.0.1:4519`, bearer-token auth) → Anthropic API. Nothing else makes
network requests with your data.

**Sent (only this):**

| Data | When |
|---|---|
| App names, window titles, timestamps (the activity timeline) | Summarize cycle, every 2 minutes while observing |
| Your typed chat questions | When you send a chat message |
| Derived activity summaries **and the recent raw timeline** (up to the last 50 observed app/title entries) as context | When you send a chat message |

Chat context is drawn from what was captured earlier: asking a question while
paused still sends recent history that was recorded while fren was lit.
Pausing stops new capture; it does not redact what you already let fren see.

**Never sent, to anyone, ever:**

- **Screenshots.** Captured only while observing, written as local JPEGs,
  pruned automatically. They are not sent to the gateway, not sent to the
  Anthropic API, not uploaded anywhere. The summarizer works from the text
  timeline alone.
- **The SQLite database.** It never leaves the userData folder.
- **Keystrokes.** Not captured at all (see above), so there is nothing to send.

The Anthropic API key is used only by the gateway process. The desktop app
reads the shared `.env` for its own settings but deletes
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from its environment at startup
(`apps/desktop/main/index.js`), so provider credentials never live in the
process that captures your screen.

## Storage locations

Everything is local, under Electron's userData folder:

```
~/Library/Application Support/fren/
├── fren.db          # SQLite: observations, memories, suggestions
└── (screenshots)    # JPEG files, max width 1280px
```

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

Click the sphere to open the panel, then click **"pause watching"**. The light
goes out, the eyes close, everything stops. Same two clicks to resume ("wake up"). There is no partial
state and no background trickle while paused.

## How to delete everything

1. Quit fren.
2. Delete `~/Library/Application Support/fren/`.

That is the entire footprint. There is no cloud account, no sync, no server-side
copy. What the Anthropic API has seen (timelines, summaries, chat text) is
governed by [Anthropic's API data usage policies](https://www.anthropic.com/legal/privacy);
fren sends nothing there beyond the categories listed above.

## macOS permissions

fren uses two permissions, and works with degraded data if you decline:

| Permission | Used for | Without it |
|---|---|---|
| Screen Recording | Screenshots | No screenshots; app names + window titles only |
| Accessibility | Window titles (via System Events) | App names only |

How they are requested: the first time you wake fren up, the window-title
lookup triggers the Accessibility/Automation prompt, and fren makes one
throwaway capture attempt so macOS registers it in the Screen Recording pane
(newer macOS versions show a prompt; older ones only list the app there —
enable it manually).

In development the app appears as **"Electron"** in System Settings → Privacy &
Security, because it runs under the stock Electron binary. Permission changes
take effect after restarting the app.
