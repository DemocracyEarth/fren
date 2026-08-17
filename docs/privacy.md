# Privacy

fren watches your screen for a living, so this document is precise. It states
what is captured, when, what leaves the machine, where everything is stored, how
long it is kept, and how to stop or erase all of it.

## Capture states

There are exactly two, and the orb's eyes are the truth:

| State | Eyes | What is captured |
|---|---|---|
| Observing ON | Open | Active app name + window title every 5s; local screenshot every ~15s |
| Observing OFF | Closed | **Nothing. No sampling, no screenshots, no summarizing, no timers.** |

This is not a UI convention layered over a background process. The `observing`
flag lives in one place in the Electron main process
(`apps/desktop/main/state.js`) and is only ever changed together with starting
or stopping the observer. Eyes open ⇔ capture running, by construction.

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
| Derived activity summaries (as context for chat) | When you send a chat message |

**Never sent, to anyone, ever:**

- **Screenshots.** Captured only while observing, written as local JPEGs,
  pruned automatically. They are not sent to the gateway, not sent to the
  Anthropic API, not uploaded anywhere. The summarizer works from the text
  timeline alone.
- **The SQLite database.** It never leaves the userData folder.
- **Keystrokes.** Not captured at all (see above), so there is nothing to send.

The Anthropic API key exists only in the gateway process (via `.env` /
environment). The desktop app never holds provider credentials, so it could not
call the provider even by mistake.

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

Pruning runs as part of the regular summarize cycle — retention does not depend
on you remembering to clean up.

(Tunables: `OBSERVATION_RETENTION_DAYS` and `MAX_SCREENSHOTS_KEPT` in
`packages/shared/config.js`.)

## How to pause

**One click on the orb.** Eyes close, everything stops. Click again to resume.
There is no partial state and no background trickle while paused.

## How to delete everything

1. Quit fren.
2. Delete `~/Library/Application Support/fren/`.

That is the entire footprint. There is no cloud account, no sync, no server-side
copy. What the Anthropic API has seen (timelines, summaries, chat text) is
governed by [Anthropic's API data usage policies](https://www.anthropic.com/legal/privacy);
fren sends nothing there beyond the categories listed above.

## macOS permissions

fren asks for two permissions, and works with degraded data if you decline:

| Permission | Used for | Without it |
|---|---|---|
| Screen Recording | Screenshots | No screenshots; app names + window titles only |
| Accessibility | Window titles (via System Events) | App names only |

In development the app appears as **"Electron"** in System Settings → Privacy &
Security, because it runs under the stock Electron binary. Permission changes
take effect after restarting the app.
