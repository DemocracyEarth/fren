# Runtime architecture: FREN on NanoClaw

This document is the first deliverable of the FREN-on-NanoClaw integration. It
records what FREN and NanoClaw are today, what they will be together, and the
smallest set of steps that gets a working vertical slice. Every claim about
existing code cites a file and line so it can be checked; where the two
codebases' own docs and their code disagree, the code wins and the discrepancy
is noted.

Line numbers refer to FREN at commit `8bd4881` and NanoClaw v2.3.0 at commit
`5c3082a` (`nanocoai/nanoclaw`, main, 2026-09-02).

## 0. Decisions in one screen

| Decision | Choice | Why (short) |
|---|---|---|
| Runtime boundary | A runtime-agnostic `FrenRuntime` interface in `packages/runtime`, implemented by `packages/runtime-nanoclaw`. Nothing else imports NanoClaw. | The whole point: FREN must be able to swap the kernel. |
| Where fren-core runs | Inside the existing gateway process (`apps/gateway`), which grows into the FREN Core control plane; logic lives in `packages/fren-core`. No new process for the MVP. | It already has loopback HTTP, a bearer token, the credentials, and a client in the desktop app. Adding a fourth process buys nothing yet. |
| Desktop ↔ Core transport | Existing HTTP on `127.0.0.1:4519` + bearer token, plus one new `GET /v1/events` server-sent-events stream. | Localhost IPC with auth, zero new dependencies, renderer still isolated behind Electron IPC. |
| NanoClaw process model | A separate Node process spawned and supervised by FREN Core, unmodified in how it boots. | NanoClaw is designed as one host process with a launchd lifecycle; better-sqlite3 is native and cannot load inside Electron without rebuilds; crash isolation. |
| How FREN talks to NanoClaw | (1) NanoClaw's own `ncl` Unix-socket API for control (groups, sessions, tasks, approvals). (2) A tiny `fren` channel adapter inside NanoClaw, installed the same way upstream installs Slack or Telegram, that connects back to FREN Core over a Unix socket for chat, task results and approval cards. | Uses the two extension seams NanoClaw already designed for exactly this; no schema or router changes. |
| Streaming | Message-level, not token-level. `RunEvent`s are `started`, `working`, `message` (interim or final), `completed`, `failed`. `capabilities.tokenStreaming` is `false` for NanoClaw. | NanoClaw deliberately does not stream tokens; its turn output is envelope-parsed into whole messages. FREN's UI does not stream today either. |
| Automations | A FREN-owned `Automation` model in FREN's own SQLite. Schedule triggers are compiled into NanoClaw scheduled tasks; the NanoClaw task id is opaque `runtimeMetadata`. | FREN keeps the product concept; the runtime keeps the timer. |
| Permissions | A FREN Permission Broker in Core decides `ALLOW`, `DENY`, `ASK_USER` for structured requests. NanoClaw's guard seam (`allow | hold | deny`) feeds it: every `hold` becomes an approval card delivered to the `fren` channel, which is the owner's DM. | Reuses NanoClaw's approval plumbing instead of adding a second mechanism; FREN becomes the human in the loop. |
| Container runtime | Docker for the MVP, probed by Core and shown to users only as "secure execution environment". A `ContainerRuntime` probe seam is the only place Docker is named. | Docker is what NanoClaw supports today; Apple Container is the roadmap for macOS 26. |
| Vendoring | `git subtree` of NanoClaw at `vendor/nanoclaw`, pinned, with FREN's additions kept to files upstream expects skills to add (one adapter file, one barrel line, one provider config). | Least fragile of the four options; upstream merges stay mechanical. |
| Provider inside the sandbox | NanoClaw's built-in Claude Agent SDK provider. The container never sees a key: it calls a credential proxy in Core (`:4527`) that swaps a sandbox token for the real key. Upstream is Anthropic, or DeepSeek's Anthropic-compatible endpoint as the fallback for this machine. | The vertical slice needs an agent that can use tools; the Claude provider is the one NanoClaw tests; the proxy is the pattern NanoClaw itself uses (OneCLI). |

Two facts about the development machine shape the phases: Docker is not
installed, and the only model key configured is DeepSeek. Phase 1 therefore
ships a mock runtime so the product layer is testable with neither, and the
first real container run needs one of the two installed (see §13 and §16).

## 1. Current FREN architecture

FREN today is two processes and one SQLite file. Nothing here is a proposal;
it is what `8bd4881` does.

### 1.1 Processes

```
start.js  (dev supervisor, start.js:30-31)
 ├─ node apps/gateway/server.js          "the gateway"   127.0.0.1:4519
 └─ electron apps/desktop                "the desktop"   main process + 3 windows
```

Either child exiting kills the other (`start.js:12-17`). There is no third
process. The desktop deletes the four model and voice keys (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `DEEPSEEK_API_KEY`, `ELEVENLABS_API_KEY`) from its own
environment at startup (`apps/desktop/main/index.js:33-39`); it does not scrub
`FREN_VISION_API_KEY`, a gap this work closes in passing. Only the gateway is
meant to hold credentials.

**The gateway** (`apps/gateway/server.js`, 601 lines) is a plain `node:http`
server with twelve `POST /v1/*` routes and an unauthenticated `GET /health`.
Every route requires `authorization: Bearer ${FREN_GATEWAY_TOKEN}` (default
`dev-token`, `server.js:442-444`). It is stateless: no sessions, no history, no
scheduler, no database. Each request carries all context (memories,
observations, `SOUL.md`, browser page) and returns one JSON object after the
provider completes. There is no streaming of any kind (`server.js:395-397`).
Providers are duck-typed objects `{ name, model, complete(request) -> string }`
(`providers/anthropic.js:17`, `providers/deepseek.js:24`, `providers/mock.js:23`);
`pickProvider()` (`server.js:557-584`) chooses DeepSeek when `DEEPSEEK_API_KEY`
is set, else Anthropic, else the offline mock. Voice (ElevenLabs) and vision
(any OpenAI-compatible endpoint) are chosen independently.

**The desktop** (`apps/desktop/main/index.js`, 1886 lines) is one
`app.whenReady()` callback that opens the database, starts every watcher, and
registers all 58 `ipcMain.handle` channels (`index.js:582-1862`). The renderer
is served over a privileged `fren://` scheme (`index.js:47-81`) with a CSP that
permits `connect-src 'self' fren:` only (`renderer/index.html:5`), so no
renderer can reach any localhost port directly; every renderer ↔ backend call
goes through `preload.js` (67 entries: 58 invokes, 9 `on*` listeners). The main
process owns all state in `main/state.js`; the renderer only draws.

### 1.2 The observe → understand → remember loop

| Component | File | Cadence | What it does |
|---|---|---|---|
| Observer | `main/observer.js` | 5 s, screenshot every 3rd | `lsappinfo` + `osascript` for app and window title; JPEG to `userData/screenshots` |
| Summarizer | `main/summarizer.js` | 120 s | Text timeline → `POST /v1/summarize` → `memories` row; runs retention unconditionally |
| Patterns | `main/patterns.js` | 12 min | `POST /v1/pattern` over 8 h of memories; at most one suggestion, never repeated |
| Proactive | `main/proactive.js` | 30 s tick | Pace governor for unprompted speech: warmup, cooldowns, daily ceiling, topic dedup |
| Curiosity | `main/curiosity.js` | 9 min | Asks the owner a question; answers land in `MEMORY.md` via `/v1/learn` |
| Browser sense | `main/browser-sensor.js`, `main/browser-transport.js` | event-driven | MV3 extension → `127.0.0.1:4526` (paired bearer token bound to extension origin) → in-memory page context, never stored |

Every watcher refuses to act while `state.observing` is false. That flag is the
privacy invariant: the orb is lit if and only if capture is running
(`main/state.js:21-26`; `docs/privacy.md:7-23`).

### 1.3 The two scheduled things that already exist

FREN already has two independent "do something at a time" systems. Both are
30-second `setInterval` loops in the Electron main process, both use local
time with a 30-minute grace window after which a missed slot expires, both are
gated on `observing`, and neither survives the app quitting.

**Routines** (`main/routines.js`, table `routines`) are *scheduled questions*.
A routine is created conversationally: the renderer's `looksScheduled()` regex
(`renderer/app.js:596-601`) routes text like "every morning at 9 …" to
`fren:maybeRoutine` → `POST /v1/routine` → `{ isRoutine, name, prompt, hour, minute, days }`
→ `memory.addRoutine` with no confirmation step (`index.js:1628-1648`). When
due, the runner calls `answer(prompt)`, the same single-turn `/v1/chat` call the
chat panel makes, and pushes `fren:routineRan { name, text }` to the orb. The
file's own header says what a routine cannot do: "It does NOT run commands, and
nothing here can" (`routines.js:5-10`). Management IPC: list, enable/disable,
delete. No run-now, no edit.

**Automations** (`main/executor.js` + `index.js:1670-1780`, tables `automations`
and `automation_runs`) are *drafted scripts run on the host*. A pattern
suggestion is drafted into `{ feasible, approach, steps, script, language, caveats }`
by `POST /v1/automate`, kept, then passes three gates that the schema itself
holds so no code path can skip one (`packages/memory/index.js:22-32`):

1. `approved_hash`: the user read the exact text; approval is a SHA-256 of it and editing voids it.
2. `verified`: it ran successfully by hand at least once.
3. `sched_enabled`: the user separately turned the schedule on.

`executor.run` (`executor.js:146-245`) writes the script to a `0600` temp
file, spawns the interpreter by absolute path in a detached process group with a
five-variable environment, caps output at 8000 characters, kills the whole
group on timeout or exit, and never throws. A regex blocklist (`FORBIDDEN`,
`executor.js:43-84`) is documented as "the LAST line, not the first … a
blocklist cannot be complete and should never be mistaken for a sandbox".

The dashboard already renders an automations list with approve, run-now,
schedule toggle, revoke, delete and per-run output (`renderer/dashboard.js:313-417`),
and a routines list with pause/resume and delete (`dashboard.js:459-522`). The
vocabulary is script-centric; the verbs are the ones the milestone needs.

### 1.4 Persistence

One synchronous `node:sqlite` database, `~/Library/Application Support/fren/fren.db`,
opened once by the desktop main process in WAL mode (`index.js:584`,
`packages/memory/index.js:139-142`). Nine tables: `observations` (7-day
retention), `memories` (kept), `suggestions`, `automations`, `automation_runs`,
`routines`, `messages` (7-day retention), `settings` (key → JSON), plus two
indexes. There is no migration mechanism: the schema is a single
`CREATE TABLE IF NOT EXISTS` string executed on every open, so **adding a column
to an existing table would silently not happen on existing installs**; only new
tables are safe today (`memory/index.js:3-114`). Next to the database live the
persona files `SOUL.md`, `USER.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`
(`main/soul.js`) and the screenshots.

### 1.5 The privacy promises that bind the design

`docs/privacy.md` and `docs/browser-awareness.md` make commitments that any
runtime must keep. The ones that constrain this design:

- **P11, one egress path.** "Data leaves your machine on exactly one path: desktop app → local gateway → your chosen model provider. Nothing else makes network requests with your data" (`privacy.md:111-114`). The promise is already imprecise in the current tree (reply text goes to ElevenLabs when a voice key is set, the eye button sends a screenshot to the vision endpoint, greetings carry up to six `MEMORY.md` lines, `privacy.md:126-131`). A sandboxed agent that calls a model and fetches web pages is a far larger widening. The document must change in the same commit as the code, and the FREN UI must describe it.
- **P12/P13, the exhaustive "sent" table** (`privacy.md:116-152`): observed screenshots, the SQLite file, keystrokes and microphone audio are never sent. Observations do not reach the sandbox unless a later, explicit component selects them (§6.5).
- **P5–P8, automations** (`privacy.md:69-82, 336-339`): hash-bound approval, verified-by-hand, separately scheduled, output "never sent anywhere", and scheduled runs only while observing. The runtime-backed model keeps the spirit (explicit approval, output stays local) and drops the parts that only made sense for host scripts (the hash of a script the user must read).
- **P10, screenshots never leave** (`privacy.md:139-148`); the observer has no path to the gateway and a test asserts it.
- **P14, keys** (`privacy.md:154-158`): provider keys live in `.env`, only the gateway reads them, the desktop scrubs four of them. The NanoClaw host and its containers must be treated as *another* holder of credentials, and §5 says which.
- **`FREN_FACTS`** (`packages/intelligence/index.js:873-880`) tells the user "It suggests things. It does not act on your behalf." That sentence stops being true the day an agent runs; it changes in the same commit.
- **The write-back boundary**: `soul.test.js:101-113` pins that model-written `MEMORY.md` facts never reach a prompt that can act. Agent output must not be fed back into agent instructions without the same discipline.

### 1.6 What FREN lacks for the milestone

Stated as gaps in the current tree, all confirmed by reading it:

- No agent runtime, no tool use, no sandbox: routines are questions, automations are host scripts.
- No conversation history at the model layer: `/v1/chat` is single-turn (`intelligence/index.js:318-372`).
- No streaming or event push for long-running work: every renderer call is `invoke → one reply`; the only in-progress affordance is `#typing`.
- No runtime status beyond one `gatewayOk` dot; the dashboard never receives `fren:stateChanged` (pushes target the orb window only, `index.js:867`).
- No approval surface for something an agent is asking *right now*; the only approval is the in-card script hash button.
- No run ledger for prompt-shaped work; `automation_runs` exists for scripts, `routines.last_text` holds one string.
- No schema migrations.
## 2. Relevant NanoClaw architecture

NanoClaw v2.3.0 is a single Node host process (TypeScript, ESM, `better-sqlite3`,
Node ≥ 22, pnpm 10) that orchestrates one Docker container per agent session.
The container runs a Bun agent-runner that drives the Claude Agent SDK. The two
sides share no modules; "everything is a message" through two SQLite files per
session. The facts below are the ones the FREN integration rests on. They were
read from the source at `5c3082a`; NanoClaw's own `docs/architecture.md` is a
design draft that drifts from the code in places noted here.

### 2.1 Shape

```
channel adapter ─▶ router ─▶ session ─▶ inbound.db ─▶ [container: agent-runner ─▶ Claude SDK]
                                                                   │
channel adapter ◀─ delivery ◀─ outbound.db ◀───────────────────────┘
        ▲
        └── ncl Unix socket (data/ncl.sock): groups, wirings, users, roles, tasks, sessions, approvals(list)
```

- **Entity model** (central DB `data/v2.db`): `users` (`<channel>:<handle>`) → `user_roles` (owner, admin) → `messaging_groups` (one chat on one channel) → `messaging_group_agents` (wiring, with engage mode and session mode) → `agent_groups` (a workspace: folder, `CLAUDE.md`, memory, `container_configs`) → `sessions` (one folder = one session = one container when running).
- **Per-session mailbox**: `data/v2-sessions/<agentGroupId>/<sessionId>/{inbound.db, outbound.db, .heartbeat, outbox/, inbox/}`. The host is the only writer of `inbound.db`; the container is the only writer of `outbound.db`. Both use `journal_mode=DELETE` because WAL's shared-memory index does not propagate across VirtioFS (`container/agent-runner/src/mailbox/sqlite/connection.ts:12-18`).
- **Boot order** (`src/index.ts:63-174`): startup backoff → **upgrade tripwire** → central DB + migrations → **`docker info` (throws fatally if Docker is absent)** → channel adapters → delivery adapter → host modules → host-instance lease → delivery polls (1 s active, 60 s sweep) → host sweep → `ncl` socket last. No env var is mandatory to boot; the container image and OneCLI are only touched at spawn.
- **Not embeddable as a library**: `src/index.ts` exports nothing and calls `main()` at import; `shutdown()` calls `process.exit`; every data path is derived from `process.cwd()` with no override (`src/config.ts:67-76`). It is a process, and FREN treats it as one.

### 2.2 The two designed extension seams FREN uses

NanoClaw's stated philosophy is "trunk ships the registry and infrastructure";
capabilities are installed by copying a module in and appending one import
line to a barrel (`README.md:85`, `docs/skills-model.md:52-97`). Two of those
seams carry the whole FREN integration.

**Channel adapters** (`src/channels/adapter.ts:199-298`). An adapter is an
object with `name`, `channelType`, `supportsThreads`, `setup(ChannelSetup)`,
`teardown()`, `isConnected()`, `deliver(platformId, threadId, OutboundMessage)`
and optional `setTyping`, `openDM`, `defaults`. `ChannelSetup` gives it four
host callbacks: `onInbound(platformId, threadId, InboundMessage)`,
`onInboundEvent(InboundEvent)`, `onMetadata`, and
`onAction(questionId, selectedOption, userId)` for button clicks. Registration
is `registerChannelAdapter(name, { factory, defaults })` at import time, and the
barrel `src/channels/index.ts:9` imports exactly one adapter in trunk:
`src/channels/cli.ts`, a 330-line, zero-credential, Unix-socket chat channel
that is the template for a FREN adapter. Delivery is exact-key: a
`messages_out` row whose `channel_type` has no registered adapter throws
`MissingChannelAdapterError` and is marked failed after three attempts
(`src/delivery.ts:35, 289-306`).

**The `ncl` socket** (`src/cli/socket-server.ts`, `src/cli/frame.ts`). Path
`data/ncl.sock`, mode `0600`, no token: the path is the auth boundary and every
connection is `{ caller: 'host' }`. Wire format is newline-delimited JSON, one
request per connection:

```json
{ "id": "r1", "command": "tasks-create", "args": { "group": "fren", "name": "morning-hn", "prompt": "…", "recurrence": "0 9 * * *" } }
{ "id": "r1", "ok": true, "data": { … }, "human": "…" }
{ "id": "r1", "ok": false, "error": { "code": "invalid-args", "message": "…" } }
```

Commands are `<plural>-<verb>` over the resources `groups`, `messaging-groups`,
`wirings`, `users`, `roles`, `members`, `destinations`, `policies`, `sessions`,
`tasks`, `approvals`, `user-dms`, `dropped-messages`. For a host caller the
guard decision is always allow (`src/cli/guard.ts:50`), so nothing over this
socket ever waits for approval. Two things the socket cannot do: it has no
subscribe or stream verb (agent output only reaches the world through a
channel adapter), and `approvals` is list/get only. Both are why the channel
adapter is required and the socket alone is not enough.

Three more registries are relevant and have the same overlay shape (an
`installed.ts` barrel that is empty in trunk): **session drivers**
(`registerSessionDriver`, selected by `NANOCLAW_RUNTIME_DRIVER`, only `docker`
ships), **gateway providers** (`registerGatewayProvider`, selected by
`NANOCLAW_GATEWAY_PROVIDER`, only `onecli` ships), and **host-side provider
container config** (`registerProviderContainerConfig`).

### 2.3 Scheduled tasks

A task is not a central-DB row. It is a `messages_in` row with `kind='task'`,
`process_after`, a cron `recurrence` (or null), and a `series_id`, living in the
`inbound.db` of an **isolated per-series session** whose `thread_id` is
`system:tasks:<seriesId>` and whose `messaging_group_id` is null
(`src/db/sessions.ts:94-96`, `src/session-manager.ts:164-199`). Facts that
shape FREN's automation model:

- Creation: `tasks-create` with `prompt` (required), `recurrence` (cron, interpreted in the group's timezone), or `process_after` for a one-shot, optional gate `script`, and `name` (`src/cli/resources/tasks.ts:483-544`). Cron only; no interval field. `MAX_DAILY_FIRES = 4` unless a gate script or an explicit override is given (`src/modules/scheduling/create.ts:9, 77-95`).
- Lifecycle verbs: `list`, `get` (adds the last 10 run-log lines), `update`, `pause`, `resume`, `cancel`, `delete` (refuses while the container runs; destroys the series session), `run` (inserts a fresh pending occurrence due now, `recurrence: null`), `append-log`.
- Due decision: the 60 s sweep enqueues every active session; `countDueMessages()` and no running container → wake (`src/reconcile-session.ts:128-164`). `tasks-run` does not enqueue a reconcile, so a manual run can take up to one sweep tick to start.
- Recurrence is host-side: after a completed or failed occurrence the sweep parses the cron and arms the next row atomically (`src/modules/scheduling/recurrence.ts:51-121`). Script failures back off and auto-pause after eight consecutive failures.
- **A task's output goes nowhere by itself.** The runner mirrors the run's final text into a `task_log` row that the host appends to `groups/<folder>/tasks/<series>.md` and "never delivers" (`src/delivery.ts:346-362`). A task session has no chat attached; a result reaches a person only if the agent calls `send_message` to a destination named in `agent_destinations` (`docs/scheduled-tasks.md:44-46`). The wiring command inserts that destination row for the wired channel.

### 2.4 The guard seam and approvals

`guard(action, input)` (`src/guard/guard.ts:29`) returns
`{ effect: 'allow' | 'hold' | 'deny', reason }` from a per-action `decide`
function minted by `defineGuardedAction`. There is no policy-as-data layer
(`guard.ts:9-13`). An in-process module can define *new* guarded actions with
`defineGuardedAction` and wire them with `registerDeliveryAction`, but cannot
replace the decision of an existing action (duplicate names throw,
`guard-actions.ts:54-56`). A `hold` does not create the approval by itself;
each consult site turns it into a `pending_approvals` row, either directly via
`requestApproval()` (`src/modules/approvals/primitive.ts:229-297`, used by
`cli_command` and agent-to-agent sends) or through the `requestHold` hook of
`runGuarded` (`src/delivery-guard.ts:58-61`, used by self-modification and
`create_agent`). Both end in `requestApproval()`, which:

1. picks approvers from `user_roles` (scoped admins → global admins → owners),
2. resolves a DM messaging group for one of them via `ensureUserDm` (for an adapter without `openDM`, the user's handle is used as the DM `platform_id` and a `strict` messaging group is minted, `src/modules/permissions/user-dm.ts:99-120`),
3. inserts a `pending_approvals` row bound to that exact approver, and
4. delivers a `chat-sdk` message `{ type: 'ask_question', questionId, title, question, options: [approve, reject, reject_with_reason] }` through the registered channel adapter.

The **only** resolution path is the adapter calling `onAction(questionId, value, userId)`; the clicker must be the bound approver (`src/modules/approvals/response-handler.ts:140-157`). Approve replays the original action with the approval row as a grant; the guard re-runs live and the grant may satisfy only a hold. Actions that hold today: agent-issued `ncl` commands whose access is `approval` (group config, restarts, mounts), `agents.create` for non-global agents, `a2a.send` under a policy, `self_mod.add_mcp_server`, and `install_packages`. `tasks-*` verbs are `open`, so an agent can schedule its own work without a hold; FREN controls this with `cli_scope` (§8).

### 2.5 Containers and what enters them

Spawning composes a typed `SessionSpec` and hands it to the Docker driver
(`src/container-runner.ts:277-408`, `src/drivers/docker-driver.ts:139-163`):

```
docker create --rm --name ncl-<slug>-<sessionId> --label nanoclaw-install=<slug> …
  --cap-drop=ALL --security-opt no-new-privileges --init --pids-limit 2048 --shm-size=1024m
  --user <uid>:<gid> -e TZ=… -e HOME=/home/node [-e <contributed env>]
  -v data/v2-sessions/<gid>/<sid>:/workspace
  -v groups/<folder>:/workspace/agent  -v groups/<folder>/CLAUDE.md:/workspace/agent/CLAUDE.md:ro
  -v data/v2-sessions/<gid>/.claude-shared:/home/node/.claude
  -v container/agent-runner/src:/app/src:ro  -v container/skills:/app/skills:ro
  --entrypoint bash <image> -c 'exec bun run /app/src/index.ts'
```

- Network on macOS: no flag, so default bridge with unrestricted egress and `host.docker.internal` reachable (`src/drivers/index.ts:78-84`). `NANOCLAW_EGRESS_LOCKDOWN=true` switches to an internal network whose only exit is the OneCLI container.
- **No API key enters the container by construction.** `validateSpec` denies secret-shaped keys in composed env and credential-looking values in contributed env (`src/drivers/types.ts:478-492`); the sanctioned pattern is `ANTHROPIC_BASE_URL` plus a placeholder token, with a proxy on the host injecting the real credential on the wire. That proxy is OneCLI in trunk (`src/gateway-providers/onecli.ts:85-100`), and `contribute()` **throws on every spawn** if OneCLI has not applied. The gateway provider is a registry, so a different credential proxy is a registered kind plus `NANOCLAW_GATEWAY_PROVIDER`.
- The Docker binary is a constant (`src/container-runtime.ts:16`, `docker-driver.ts:80`). `CONTAINER_RUNTIME` is honoured only by shell tooling. There is no Podman or Apple Container code in this tree; the localized READMEs mention a `/convert-to-apple-container` skill that does not exist in `.claude/skills/`. A non-Docker runtime is a new `SessionDriver` registered through `src/drivers/installed.ts`; because `ensureReady` is optional on the interface, such a driver could also let the host boot without Docker.
- Host never reads container stdout; only a 10-line stderr tail on boot failure. All output is `outbound.db`.
- Mount admission is derived from `process.cwd()` (`src/drivers/index.ts:101-127`): the host must run with cwd = the checkout root, and `container/agent-runner/src` must sit next to `data/`.

### 2.6 Inside the container: provider and output

- Trunk ships one provider, `claude`, wrapping `@anthropic-ai/claude-agent-sdk` with `permissionMode: 'bypassPermissions'` and a fixed tool allowlist (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, and `mcp__nanoclaw__*`) (`container/agent-runner/src/providers/claude.ts:109-127, 558-589`). Alternative providers (OpenCode for DeepSeek and others, Codex) are skill-installed from the `providers` branch; Ollama reuses the Claude provider through `ANTHROPIC_BASE_URL` (`docs/ollama.md`). The Claude Code CLI must exist at `/pnpm/claude` in the image.
- The provider event stream is `init | text | result | error | progress | file | activity`. Tool use, thinking and partial tokens are **filtered out** (`claude.ts:621-629`); tool activity is visible only as `container_state.current_tool` in `outbound.db`. So: no token streaming, no tool events, by design.
- Chat turns deliver only `<message to="name">…</message>` blocks; text outside is scratchpad. Mid-turn blocks are delivered as they are parsed, so one turn can yield several `messages_out` rows (`poll-loop.ts:805-859`). An undelivered turn triggers a one-time re-wrap nudge.
- Task turns deliver nothing from the final text; only the `send_message` tool delivers, and the final text becomes the run log (`poll-loop.ts:1006-1016, 1116-1132`).
- MCP tools the agent gets: `send_message(to, text)`, `send_file`, `edit_message`, `add_reaction`, `ask_user_question` (blocks up to 300 s polling for the answer row), `send_card`, `create_agent`, `install_packages`, `add_mcp_server`. Scheduling is the `ncl tasks` CLI over Bash, not an MCP tool.
- Agent memory lives in the group folder (`memory/` tree, `conversations/` archives, `tasks/` run logs) and the SDK transcript lives in the per-group `.claude-shared` mount. Both are plain files FREN could read but must not write.

### 2.7 Lifecycle and recovery the host already provides

- One container per session; concurrent wakes for a session dedupe; a `session_claims` compare-and-set with a 90 s host lease refuses duplicate ownership across host processes.
- Stale detection: heartbeat file mtime; 30 min absolute ceiling; 60 s stuck-claim window; retries with `5000 × 2^tries` ms up to five, then `failed`.
- Shutdown does **not** stop running containers; the next boot adopts containers whose session is still active and reaps orphans (`src/container-runner.ts:619-700`). A crash-loop circuit breaker backs off `[0, 0, 10, 30, 120, 300, 900]` s.
- The upgrade tripwire compares `data/upgrade-state.json` with `package.json` and `git rev-parse HEAD`/`HEAD^{tree}` of `process.cwd()`; when git cannot identify the checkout it accepts on version match alone (`src/upgrade-state.ts:101-127`). Inside a subtree this matters (§14).

### 2.8 Maintenance model upstream expects

"Every change you make is a skill … Every update goes through `/update-nanoclaw`, never a raw `git pull`" (`docs/customizing.md:3-34`). Skills add files, append one barrel line, pin a dependency, and ship an integration-point test. Channels and providers are pulled from long-lived registry branches with `git show origin/channels:<path>`, "additive, never a merge". Only security fixes, bug fixes and clear improvements are accepted into trunk; everything else is a skill (`README.md:229-233`). The `update-nanoclaw` controller snapshots `.env`, `data/`, `groups/`, `store/`, merges in a worktree, rebuilds, and stamps the upgrade marker.

### 2.9 Verified on this machine

With the pinned `pnpm@10.34.5` (the machine's pnpm 11 rejects the workspace file), `pnpm install --frozen-lockfile` and `tsc --noEmit` succeed on Node 23.7, and `vitest` passes 2226 of 2238 host tests. The 12 failures are all in setup and update tooling (`scripts/update/transaction.e2e`, `scripts/update-skills`, `scripts/add-dial-tool-scope`, `setup/channels/mattermost-guidance`, `src/upgrade-state`), not in the router, delivery, sweep, container-runner or guard suites. Docker is not installed, so no container was started.

### 2.10 Reference: OpenClaw

OpenClaw (`openclaw/openclaw`, MIT, v2026.8.1) is read for ideas only; nothing
from it becomes a dependency. It is one long-lived gateway daemon on
`127.0.0.1:18789` that owns channels, sessions, the scheduler, tool policy and
sandbox orchestration, with every client a WebSocket peer
(`docs/concepts/architecture.md:8-22`). It collapses control plane and runtime
into one process; FREN deliberately keeps them separable.

Borrowed, and where it lands in this document:

- **Three-frame envelope** `req / res / event` with per-request ids and a per-connection monotonic `seq` (`packages/gateway-protocol/src/schema/frames.ts:174-198`) → the `fren-runtime.sock` protocol (§11.2) and SSE event ids (§6).
- **Readiness is a handshake, not log scraping**; config errors are a distinct exit code; `shutdown` carries `restartExpectedMs` (`docs/gateway/embedding.md:72-120`) → the supervisor waits for `hello` and treats the upgrade-tripwire banner as a distinct failure (§11.2, §12).
- **Idempotency keys on side-effecting calls** (`protocol.md:89`) → the desktop supplies the run id on `POST /v1/runs` and the automation id on create (§6.1, §7).
- **Job shape** `{ enabled, schedule, sessionTarget, payload, delivery, state: { nextRunAtMs, lastRunStatus, consecutiveErrors, autoDisabled } }` and a `configRevision` for compare-and-set updates (`cron.ts:522-558`) → `Automation.revision`, `pausedByRuntime` (§8.1).
- **Execution status separate from delivery status** (`docs/automation/tasks.md:172-200`) → `AutomationRun.status` versus `AutomationRun.delivered` (§8.1).
- **The unattended-run contract** ("the final reply is the deliverable; the scheduler owns retries", `cron-jobs.md:380-384`) → the compiled task prompt (§8.3).
- **Isolated = fresh session per run**, and a per-job tool allowlist frozen at creation that an agent cannot widen (`cron-jobs.md:268-273, 359-379`) → NanoClaw's per-series task session already gives the first; `Automation.permissions` snapshots the second (§8, §9).
- **`askFallback = deny` when no approval surface is connected** (`docs/tools/exec-approvals.md:219-229, 500-510`) → unanswered requests expire to deny (§9.2).
- **Three orthogonal controls**: where tools run, which tools exist, whether a command needs a human (`docs/gateway/sandbox-vs-tool-policy-vs-elevated.md:8-12`) → the three enforcement layers in §9.3.
- **Scoped standing grants** bound to agent + job revision + exact operation, listed and revocable (`exec-approvals.md:498-565`) → phase 4's "always allow" semantics.

Rejected for FREN: device-signature pairing, roles, scopes and challenge
nonces for a single-user loopback control plane (OpenClaw itself exempts a
loopback backend, `protocol.md:284-293`); delivery expressed as channel and
thread coordinates; `on-exit`, `stream` and script-payload schedules
(unattended code with full tool policy); the LLM auto-reviewer for approvals;
the 200-method surface. OpenClaw's own note that sandboxing is off by default
and the model loop runs on the host (`docs/gateway/sandboxing.md:9`) is the
opposite of NanoClaw's "every agent run is in a container", which is the
property FREN wants first.
## 3. Proposed combined architecture

FREN keeps every concept a person can see or name: the orb, the chat, what is
observed, automations, permissions, notifications, history, "secure execution
environment". NanoClaw keeps every concept that is about running an agent:
containers, sessions, workspaces, the timer, tool execution, retries. Between
them sits one interface, `FrenRuntime`, and one adapter that implements it.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ FREN Desktop  (Electron, apps/desktop)                                               │
│   renderer windows ── preload IPC ──▶ main process                                   │
│   orb · chat panel · dashboard         state.js (privacy invariant) · observer       │
│   (no network access; CSP)             summarizer · patterns · proactive · browser   │
└───────────────────────────┬──────────────────────────────────────────────────────────┘
                            │ HTTP 127.0.0.1:4519 + bearer   (requests)
                            │ GET /v1/events  server-sent events (push)
┌───────────────────────────▼──────────────────────────────────────────────────────────┐
│ FREN Core  (apps/gateway process, logic in packages/fren-core)                       │
│   LLM gateway (existing /v1/* routes)        Control plane (new)                     │
│   provider credentials live here             automations · runs · sessions           │
│                                              permission broker · event log           │
│                                              observation bus · runtime supervisor    │
│                                              sandbox credential proxy (:4527)        │
│                          FrenRuntime interface  (packages/runtime)                   │
│                 ┌──────────────┴──────────────┐                                      │
│      packages/runtime-mock            packages/runtime-nanoclaw                      │
│      (tests, no-Docker dev)           supervisor · ncl socket client                 │
│                                       fren-runtime.sock server · task compiler       │
└───────────────────────────────────────────────┬──────────────────────────────────────┘
                     spawn, cwd = runtime dir   │  ncl.sock (control)   fren-runtime.sock (data)
┌───────────────────────────────────────────────▼──────────────────────────────────────┐
│ NanoClaw host  (vendor/nanoclaw, node dist/index.js)                                 │
│   router · sessions · sweep · delivery · guard · approvals · central DB              │
│   overlay: src/channels/fren.ts        (chat in/out, cards, typing → Core)           │
│   overlay: src/gateway-providers/fren.ts (contributes ANTHROPIC_BASE_URL → Core)     │
└───────────────────────────────────────────────┬──────────────────────────────────────┘
                                                │ docker create/start, two SQLite files per session
┌───────────────────────────────────────────────▼──────────────────────────────────────┐
│ Agent containers  (one per session; --cap-drop=ALL, no-new-privileges, non-root)      │
│   Bun agent-runner · Claude Agent SDK · MCP tools · /workspace, /workspace/agent      │
│   model calls → http://host.docker.internal:4527 (Core proxy adds the key)           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Four host processes in the MVP: the desktop, Core, the NanoClaw host, and
Docker's own daemon which FREN does not manage. That is one more than today
(the NanoClaw host) and the same number of FREN-owned processes as today,
because Core grows out of the gateway instead of being added beside it.

Why Core lives in the gateway process and not in Electron main: the desktop
deliberately scrubs provider keys (`index.js:33-39`) and the sandbox needs a
credential proxy, so the process that holds the keys is the only place the
proxy can run. The gateway already has loopback HTTP, a bearer token and a
client in the desktop. And Electron's Node ABI could not load NanoClaw's
native `better-sqlite3` without rebuilds, which settles the NanoClaw host as a
separate process regardless.

Why the NanoClaw host is spawned by Core rather than installed as a launchd
service the way `nanoclaw.sh` does: FREN is the product; the user launches
FREN, not a service. Core owns the host's lifetime, working directory,
environment and sockets, and can report "secure execution environment
unavailable" instead of letting a launchd job crash-loop invisibly. Nothing
stops a later phase from delegating that supervision to launchd for
always-on automations; the interface does not change.

### 3.1 Package layout

```
fren/
├── apps/
│   ├── desktop/                 # Electron (unchanged role; new IPC for runs, automations, approvals, events)
│   ├── gateway/                 # the FREN Core process: server.js mounts packages/fren-core
│   └── browser-extension/
├── packages/
│   ├── shared/                  # config, env, JSDoc types (unchanged)
│   ├── memory/                  # fren.db (unchanged; desktop-owned)
│   ├── intelligence/            # prompts (unchanged; gains buildAutomationIntentRequest)
│   ├── runtime/                 # FrenRuntime contract: JSDoc types, event names, errors, contract test suite
│   ├── runtime-mock/            # in-process fake runtime: deterministic, no Docker, used by tests and dev
│   ├── runtime-nanoclaw/        # the adapter: supervisor, ncl client, fren-runtime.sock server, task compiler,
│   │                            #   sandbox proxy target config, overlay check script
│   ├── fren-core/               # control plane: core.db store, automation engine, permission broker,
│   │                            #   event log + SSE, observation bus, HTTP routes, sandbox credential proxy
│   ├── observer/                # Observation typedefs + bus (abstraction only in the MVP)
│   └── permissions/             # Permission scopes, decision types, policy evaluation (pure functions)
├── vendor/
│   └── nanoclaw/                # git subtree of nanocoai/nanoclaw + FREN overlay files (see §14)
├── scripts/
│   ├── runtime-build.js         # pnpm install + tsc in vendor/nanoclaw, builds the agent image when Docker is present
│   └── nanoclaw-overlay-check.js# asserts overlay files and barrel lines survived a subtree pull
├── docs/runtime-architecture.md # this document
└── start.js                     # unchanged: gateway (Core) + desktop
```

`packages/runtime`, `packages/observer` and `packages/permissions` contain
no I/O. Only `packages/runtime-nanoclaw` and `vendor/nanoclaw` may mention
NanoClaw, `ncl`, sessions-as-folders, or Docker. A grep for `nanoclaw` or
`docker` outside those two paths is a review failure, and a test enforces it.

## 4. Process diagram

```
 time ─────────────────────────────────────────────────────────────────────────────────▶

 start.js ──spawn──▶ apps/gateway (Core)
                      │ loadEnv, pickProvider (LLM gateway as today)
                      │ open <dataDir>/core.db, migrate
                      │ probe container runtime ──▶ status: unavailable(reason) | available
                      │ listen 127.0.0.1:4519 (desktop API + SSE)          ◀── desktop polls /health, opens /v1/events
                      │ listen 127.0.0.1:4527 (sandbox credential proxy)
                      │ listen <dataDir>/fren-runtime.sock (0600)
                      │ runtime.start():
                      │   stamp upgrade marker; spawn `node dist/index.js` cwd=<runtimeDir>, env: FREN_CORE_SOCKET,
                      │     FREN_RUNTIME_TOKEN, FREN_SANDBOX_URL, NANOCLAW_GATEWAY_PROVIDER=fren, TZ
                      │   wait for hello on fren-runtime.sock (adapter connected) and ncl.sock
                      │   ensure bootstrap entities over ncl.sock (idempotent, §11.2)
                      │   emit runtime.ready
 start.js ──spawn──▶ electron apps/desktop
                      │ createWindow; checkHealth → state.gatewayOk, state.runtime
                      │ SSE consumer → broadcast fren:coreEvent to ALL windows
 user types ─▶ renderer ─ipc─▶ main ─POST /v1/runs─▶ Core ─fren-runtime.sock inbound─▶ fren adapter ─routeInbound─▶ session
                                                                                            ▼ wake → docker create/start
                                  ◀─ SSE run.started / agent.working / agent.message ◀─ adapter.deliver ◀─ outbound.db ◀─ agent
 9:00 ─▶ NanoClaw sweep ─▶ task session wake ─▶ agent send_message('automation-<id>') ─▶ adapter.deliver('automation:<id>')
                                                                                   ─▶ Core: automation.run.completed → SSE → orb
 quit ─▶ desktop before-quit ─POST /v1/runtime/stop? no: Core observes desktop exit (start.js) ─▶ runtime.stop():
                      │   SIGTERM host, wait ≤10 s, stop labeled containers, close sockets
```

## 5. Trust boundaries

Five zones, each with a different reason to exist. Data crosses a boundary
only through the named interface.

| Zone | Contains | Holds secrets? | Talks to |
|---|---|---|---|
| **Z1 Renderer** | orb, chat panel, dashboard (Chromium, `contextIsolation`, CSP `connect-src 'self' fren:`) | never | Electron main only, via preload `invoke`/`on` |
| **Z2 Desktop main** | state, observers, screenshots, `fren.db`, soul files | the four model/voice keys are scrubbed at boot; `FREN_VISION_API_KEY` is not yet (phase 1 fixes it) | Core over HTTP + SSE with the shared bearer token; the browser extension over `:4526` |
| **Z3 Core** | LLM gateway, control plane, `core.db`, credential proxy, runtime supervisor | **yes**: provider keys, the runtime token, the sandbox token | providers over TLS; NanoClaw host over two local sockets; containers only inbound on `:4527` |
| **Z4 NanoClaw host** | router, central DB, session mailboxes, Docker CLI | no provider keys (never passed in env); has the runtime token and the sandbox token | Core sockets; Docker daemon; container mounts |
| **Z5 Agent container** | agent-runner, Claude SDK, the agent's workspace | **no credentials by construction** (`validateSpec`); only a placeholder token and a proxy URL | its two mailbox files; `host.docker.internal:4527`; the open internet (MVP) |

Rules that follow:

1. **Z1 never sees Z3–Z5.** The renderer has no network access and no new capability is added to preload without a corresponding `ipcMain.handle`. "Never expose Docker directly to the renderer" is satisfied structurally.
2. **Z2 never touches NanoClaw or Docker.** The desktop knows there is a "runtime" with a status; it does not know what it is. `runtime.kind` is shown in an About box, nowhere else.
3. **Z3 is the only zone that maps a token to a credential.** The container's model calls carry the sandbox token; Core swaps it for the provider key on the way out. Provider keys never enter Z4 or Z5. This is the same rule FREN already applies between Z2 and Z3.
4. **Z4 trusts Z3 by socket path and token.** `ncl.sock` is `0600`; `fren-runtime.sock` is `0600` and the first frame must carry `FREN_RUNTIME_TOKEN`. Both sockets live in a directory only the user can read.
5. **Z5 is untrusted.** Everything an agent produces (messages, files, tool output, run logs) is data. It is rendered with `textContent`, never executed, never fed into another agent's instructions without going through the same discipline `soul.test.js:101-113` pins for `MEMORY.md`. Anything an agent asks for that affects Z2–Z4 or the outside world goes through the Permission Broker (§9).
6. **What enters Z5 is chosen, not defaulted.** In the MVP only the user's typed text, the automation instruction, FREN's persona (`SOUL.md` rendered into the group's instructions), and the agent's own workspace. Observations, memories, screenshots and browser pages do not cross into Z5 until a later component selects them explicitly (§6.5). This keeps privacy promises P10, P12 and P13 true.
7. **Z5 egress is open in the MVP** (Docker default bridge on macOS). That is a widening of promise P11 and is stated in `docs/privacy.md` in the same commit the runtime ships. The roadmap closes it with an egress allowlist at the Core proxy (§9.4).

## 6. Data flow

### 6.1 Chat through the runtime

```
renderer  ─invoke fren:run(text)─▶ main
main      ─POST /v1/runs {id: runId, sessionId:'main', input:{text}}─▶ Core     (the desktop mints runId; a retried POST never starts a second run)
Core      : insert runs row (queued) · emit run.started · runtime.sendMessage({sessionId, runId, text})
adapter   : fren-runtime.sock ▶ NanoClaw fren channel: onInbound('owner', 'main', {id: runId, kind:'chat', content:{text, sender:'you', senderId:'owner'}})
NanoClaw  : router → session(fren, owner, thread 'main') → inbound.db row id=runId → wake container
container : agent turn; each <message to="fren"> block → messages_out {kind:'chat', in_reply_to: runId}
NanoClaw  : delivery → fren adapter.deliver('owner', 'main', {kind:'chat', content:{text}})
adapter   : ▶ Core: deliver {platformId, threadId, message} ; post-delivery hook ▶ Core: provenance {runId, seq}
Core      : append run_messages row · emit agent.message {runId, text, final:false}
NanoClaw  : inbound row acked completed → overlay observes → ▶ Core: turn.completed {runId}
Core      : runs.status = completed · emit run.completed
main      : SSE consumer → fren:coreEvent to all windows; chat panel appends bubbles as they arrive
```

The renderer's existing `fren:chat` path (single-turn `/v1/chat`, no tools)
stays as the fast lane and the fallback when the runtime is unavailable. The
panel picks the lane: runtime available → `fren:run`; otherwise `fren:chat`
with the same bubble UI.

### 6.2 Creating an automation from chat

```
renderer : looksScheduled(text) → invoke fren:automationIntent(text)
main     : POST /v1/automations/intent {text}
Core     : gateway fast lane: buildAutomationIntentRequest → { isAutomation, name, cron, instruction, needs: [scopes] }
           (the existing /v1/routine prompt generalised: it returns a cron and an instruction instead of a self-question)
main     : shows the proposal in the panel ("Every day at 09:00 I'll … — keep it?") → user confirms
main     : POST /v1/automations {name, trigger:{type:'schedule', cron}, body:{kind:'agent', instruction}, permissions:[…]}
Core     : automation engine: validate (cron parses; ≤ 4 fires/day unless overridden) · insert automations row (enabled:true)
           runtime.createSchedule({ automationId, name, cron, timezone, instruction: compiled, deliveryName: 'automation-<id>' })
adapter  : ncl messaging-groups-create {channel_type:'fren', platform_id:'automation:<id>'}
           ncl destinations-add {agent_group:'fren', local_name:'automation-<id>', target:'channel', target_id:<mg id>}
           ncl tasks-create {group:'fren', name:'<slug>', prompt:<compiled>, recurrence:<cron>}
           → returns { seriesId, sessionId } stored as automations.runtime_ref (opaque JSON)
Core     : emit automation.created → dashboard list refreshes
```

Confirmation before creation is deliberate and is a change from today's
routines, which are created with no confirmation (`index.js:1628-1648`).
An automation runs an agent with tools; the user sees the schedule and the
instruction before it exists.

### 6.3 A scheduled fire

```
09:00     NanoClaw sweep: task row due, no container → wake task session (system:tasks:<seriesId>)
container : <task> prompt = compiled instruction + FREN delivery contract
            agent works (WebFetch HN, reads, ranks) → send_message({to:'automation-<id>', text})
NanoClaw  : delivery → fren adapter.deliver('automation:<id>', null, {kind:'chat', content:{text}})
adapter   : ▶ Core deliver {platformId:'automation:<id>', …}
Core      : automation_runs row (status ok, output) · emit automation.run.completed {automationId, text}
main      : SSE → orb: speak / show bubble titled with the automation name (existing onRoutineRan UX); dashboard run history
NanoClaw  : final text → task_log → groups/fren/tasks/<series>.md (runtime-owned run log, readable via tasks-get)
adapter   : schedule watch (15 s, while ready): tasks-list → per series: live row id and time, runs, failed_runs, status
            · a row come due opens a run on its row id and watches it, so the fire ends exactly
            · a counter that moves with no run open becomes a run opened and closed at once ("it ran, but sent nothing"; the host records a failure without a reason)
            · an end the host confirmed is remembered so the counters catching up are not a second record; an end FREN decided (a cancel, a stop) only lets go of the row
            · the host's 15 min watch cap is not the task's: the row is watched again, until the acknowledgement, the counters, or a 2 h ceiling
            · a paused row whose run log carries the host's note becomes schedule.paused → Core switches the automation off, with the reason
```

### 6.4 An approval

```
container : agent calls a held action (e.g. install_packages, or an approval-access ncl command when cli_scope allows it)
NanoClaw  : guard → hold → requestApproval → approver fren:owner → DM messaging group (fren, 'owner')
            → fren adapter.deliver('owner', null, {kind:'chat-sdk', content:{type:'ask_question', questionId, title, question, options}})
adapter   : ▶ Core permission.request {requestId: questionId, source:'runtime', action, title, question, options, sessionRef}
Core      : Permission Broker: map action → scope · policy lookup → ALLOW | DENY | ASK_USER
            ASK_USER: insert permission_requests row · emit permission.requested → orb surfaces a card; dashboard "Requests"
user      : Approve / Deny
main      : POST /v1/permissions/requests/:id/decision {decision}
Core      : runtime.resolvePermission(requestId, 'approve'|'reject')
adapter   : ▶ NanoClaw fren channel: setup.onAction(questionId, 'approve', 'owner') → approvals module replays the action
Core      : emit permission.approved | permission.denied · request row resolved
```

ALLOW and DENY decisions never reach the UI; they are logged as events so the
history shows what FREN decided on the user's behalf and why.

### 6.5 Observations

Observations enter Core through one function and leave it through explicit
selectors. In the MVP the bus exists, the desktop publishes nothing new to it,
and nothing reads from it into an agent run.

```js
/** @typedef {{ timestamp: number, source: 'browser'|'os'|'app'|'user', type: string, payload: unknown }} Observation */
const bus = createObservationBus({ retention: { maxItems: 5000, maxAgeMs: 24 * 3600e3 } });
bus.publish(observation);                       // producers: later — browser extension, active window, clipboard, file activity
bus.subscribe({ source: 'browser', type: 'page.opened' }, (obs) => …);   // consumers: later — context selectors, event triggers
```

Future producers post `POST /v1/observations` from the desktop main process
(the observer already samples every 5 s; forwarding is a one-line change once
a consumer earns it). Future consumers are named components with tests:
a *context selector* that turns chosen observations into a `context` field
of `sendMessage`, and an *event trigger* that fires an automation whose
trigger is `{ type: 'event', event }`. Until such a component exists, no
observation reaches a model through the runtime, and `docs/privacy.md`
continues to say so.

## 7. Runtime interface

`packages/runtime` defines the contract as JSDoc typedefs (FREN is plain
CommonJS with no build step) plus a contract test suite that any
implementation must pass. Shown here in TypeScript notation for precision.

```ts
interface FrenRuntime {
  readonly kind: 'nanoclaw' | 'mock' | string;

  start(): Promise<void>;                       // idempotent; resolves when status is 'ready' or throws RuntimeUnavailable
  stop(): Promise<void>;                        // idempotent; stops the runtime and any execution it started
  getStatus(): Promise<RuntimeStatus>;
  getCapabilities(): RuntimeCapabilities;

  // sessions and runs
  createSession(input: SessionInput): Promise<Session>;
  listSessions(): Promise<Session[]>;
  sendMessage(input: MessageInput): Promise<Run>;   // resolves when the run is accepted, not when it finishes
  runAgent(input: AgentRunInput): Promise<Run>;     // one-off run in a fresh or named session, no history
  getRun(id: string): Promise<Run>;
  cancelRun(id: string): Promise<void>;

  // runtime-owned timers (FREN's Automation compiles to these; §8)
  createSchedule(input: ScheduleInput): Promise<Schedule>;
  updateSchedule(id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  listSchedules(): Promise<Schedule[]>;
  triggerSchedule(id: string): Promise<Run>;        // "run now" without disturbing the schedule

  // permission requests that originate inside the runtime
  resolvePermission(requestId: string, decision: 'approve' | 'deny', reason?: string): Promise<void>;

  // push
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

type RuntimeStatus =
  | { state: 'unavailable'; reason: string; hint?: string }   // e.g. "container runtime not installed"
  | { state: 'starting'; step: string; progress?: number }    // e.g. "building secure execution environment (2/5)"
  | { state: 'ready'; since: number; sessions: number; runs: number }
  | { state: 'degraded'; reason: string }                     // e.g. host restarted, reconciling
  | { state: 'stopped' };

type RuntimeCapabilities = {
  tokenStreaming: boolean;        // nanoclaw: false — output arrives as whole messages
  toolEvents: boolean;            // nanoclaw: false — no per-tool events cross the boundary
  turnBoundary: 'exact' | 'inferred';
  scheduleTrigger: 'cron';        // what ScheduleInput.cron may contain
  maxFiresPerDay: number | null;  // nanoclaw: 4 unless overridden
  isolation: 'container' | 'vm' | 'process' | 'none';
  files: boolean;                 // agent can send files back
};

type SessionInput = { name: string; persona?: string };            // persona = rendered SOUL.md text
type Session = { id: string; name: string; createdAt: number; runtimeRef?: unknown };

type MessageInput = { sessionId: string; runId: string; text: string; attachments?: never /* MVP */ };
type AgentRunInput = { runId: string; instruction: string; sessionName?: string };

type Run = {
  id: string; sessionId: string | null; kind: 'chat' | 'agent' | 'schedule';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: number; endedAt?: number; error?: string;
  messages: RunMessage[];                                            // in delivery order
};
type RunMessage = { seq: number; at: number; text?: string; files?: string[]; card?: unknown; final: boolean };

type ScheduleInput = {
  automationId: string; name: string; cron: string; timezone: string;
  instruction: string;                 // already compiled by FREN Core (§8.3)
  deliveryName: string;                // where the agent must send its result
  enabled?: boolean; overrideFireLimit?: boolean;
};
type Schedule = ScheduleInput & { id: string; enabled: boolean; nextRunAt?: number; lastRunAt?: number;
  runs: number; failedRuns: number; pausedByRuntime?: string; runtimeRef?: unknown };

type RuntimeEvent =
  | { type: 'runtime.status'; status: RuntimeStatus }
  | { type: 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled'; runId: string; error?: string }
  | { type: 'agent.working'; runId?: string; sessionId?: string; on: boolean }
  | { type: 'agent.message'; runId?: string; automationId?: string; message: RunMessage }
  | { type: 'agent.question'; runId: string; questionId: string; title: string; question: string; options: string[] }
  | { type: 'schedule.fired' | 'schedule.completed' | 'schedule.failed' | 'schedule.paused'; scheduleId: string; automationId: string; detail?: string }
  | { type: 'permission.request'; request: RuntimePermissionRequest };

type RuntimePermissionRequest = {
  id: string; action: string;          // runtime's own action name, e.g. 'self_mod.install_packages'
  title: string; question: string; options: string[];
  sessionId?: string; automationId?: string; payload?: unknown;
};

class RuntimeUnavailable extends Error { reason: string; hint?: string }
```

Where this differs from the sketch in the brief, and why:

- **`createSchedule` instead of `createAutomation`.** The runtime owns a timer, not FREN's product concept. FREN's `Automation` (§8) has triggers the runtime never sees (`event`, `manual`) and bodies the runtime never runs (`question`, `script`). Keeping the runtime's unit a *schedule* keeps NanoClaw's task representation out of the product model in both directions.
- **`sendMessage` returns an accepted `Run`, not a finished one.** Completion arrives as events; a 90-second HTTP wait (today's chat) is the wrong shape for tool-using work.
- **`getCapabilities()` is honest about streaming.** The UI adapts (typing indicator versus token trickle) instead of pretending.
- **`resolvePermission` is on the runtime** because the request originated there and only the runtime can complete it (NanoClaw's `onAction`).

The contract test suite (`packages/runtime/contract.test.js`) exercises every
method against a runtime factory and is run against `runtime-mock` always and
against `runtime-nanoclaw` when `FREN_RUNTIME_INTEGRATION=1` and Docker are
present.

## 8. Automation model

### 8.1 The product type

```ts
type Automation = {
  id: string;                          // FREN id, e.g. 'atm_7f3a…'
  name: string;
  trigger:
    | { type: 'schedule'; cron: string; timezone: string }
    | { type: 'event'; event: string; filter?: Record<string, unknown> }   // later; fired by the observation bus
    | { type: 'manual' };
  body:
    | { kind: 'agent'; instruction: string }              // runs in the runtime (this document)
    | { kind: 'question'; prompt: string }                // today's routine: single-turn fast lane, no tools
    | { kind: 'script'; language: string; script: string; approvedHash: string };   // today's host script (kept as-is)
  permissions: Permission[];           // scopes granted at creation; the broker consults them (§9)
  enabled: boolean;
  createdAt: number; updatedAt: number;
  lastRunAt?: number; nextRunAt?: number;
  source: 'user' | 'suggestion' | 'agent';
  revision: number;                    // bumped on every change; PATCH may send expectedRevision for compare-and-set
  pausedByRuntime?: string;            // set when the runtime auto-paused it (repeated failures); cleared on resume
  runtimeMetadata?: unknown;           // opaque: whatever the runtime adapter needs to find its schedule
};

type AutomationRun = {
  id: string; automationId: string; trigger: 'schedule' | 'manual' | 'event';
  startedAt: number; endedAt?: number;
  status: 'started' | 'ok' | 'failed' | 'blocked' | 'skipped';
  output?: string;                     // capped at 8000 chars, stored locally, never sent anywhere (privacy P6)
  delivered?: boolean;                 // the result reached the user surface; distinct from the run succeeding
  runId?: string;                      // the runtime Run when body.kind === 'agent'
};
```

One model with three bodies is how the two existing systems (routines,
script automations) and the new one fit without a rewrite. In the MVP only
`agent` bodies are created through the new path; `question` and `script`
bodies keep their existing code paths and tables and are surfaced in the same
dashboard section. Folding their storage into `automations` in `core.db` is a
later phase (§16, phase 5) and a data migration, not a redesign.

### 8.2 Where each trigger and body executes

| body \ trigger | `schedule` | `manual` | `event` (later) |
|---|---|---|---|
| `agent` | runtime schedule (`createSchedule`); NanoClaw's sweep fires it | `runtime.triggerSchedule` if a schedule exists, else `runtime.runAgent` | Core's automation engine calls `runtime.runAgent` |
| `question` | Core's own scheduler (today's `routines.js` logic moved into Core) | Core fast lane | Core fast lane |
| `script` | desktop's existing scheduler (unchanged in the MVP) | desktop `executor.run` | not offered |

The Core scheduler for `question` bodies is the existing `isDue`/`nextRunAt`
logic (`routines.js:39-63`) lifted into `packages/fren-core/scheduler.js`
with the same tests. It also serves as the fallback for `agent` bodies when
the runtime reports `scheduleTrigger` it cannot honour, which is not the case
for NanoClaw.

### 8.3 Compiling an `agent` automation into a NanoClaw task

`runtime-nanoclaw` turns `ScheduleInput` into three idempotent `ncl` calls
(§6.2) and one compiled prompt:

```
You are running FREN's automation "<name>" on behalf of its owner. It is <local time>.
Instruction:
<instruction>

Delivery contract: your final text is not shown to anyone. When you have a result, send it with
send_message to the destination named "<deliveryName>". Send exactly one message unless the
instruction asks for more. Keep it under 250 words. If you could not do the task, send one
sentence saying what stopped you.
```

The delivery contract exists because a NanoClaw task session has no chat
attached and delivers nothing by itself (§2.3). The per-automation messaging
group `automation:<id>` gives every delivered message unambiguous
provenance without parsing text.

Mapping of operations:

| FrenRuntime | ncl |
|---|---|
| `createSchedule` | `messaging-groups-create`, `destinations-add`, `tasks-create --group fren --name <slug> --prompt … --recurrence <cron>` |
| `updateSchedule({enabled:false})` / `({enabled:true})` | `tasks-pause` / `tasks-resume` |
| `updateSchedule({cron, instruction})` | `tasks-update --recurrence … --prompt …` |
| `deleteSchedule` | `tasks-delete` (retry after `tasks-cancel` if a container is running), `destinations-remove`, `messaging-groups-delete` |
| `listSchedules` | `tasks-list --group fren` → runs, failed_runs, last_run, next_run, status |
| `triggerSchedule` | `tasks-run <series>` (starts within one sweep tick, ≤ 60 s; the adapter reports `run.status = queued` until the first signal) |

Constraints the adapter surfaces as validation errors, not silent failures:
cron only (no "every 90 seconds"); at most 4 fires per day unless
`overrideFireLimit`; timezone from FREN's settings applied to the NanoClaw
group so "9 in the morning" is the user's morning.

### 8.4 What FREN keeps that NanoClaw does not have

The `Automation` row, its name, its permissions, its `source`, its run
history with output, enable/disable as a product state (a disabled automation
is paused in the runtime but still listed), and the user-facing "next run"
computed from the cron in the user's timezone. If the runtime is unavailable,
automations remain listed and editable; the UI shows "waiting for the secure
execution environment" against each `agent` body.

## 9. Permission model

### 9.1 Scopes

```ts
type Permission =
  | 'filesystem.read' | 'filesystem.write'
  | 'browser.read' | 'browser.navigate' | 'browser.submit'
  | 'email.read' | 'email.send'
  | 'calendar.read' | 'calendar.write'
  | 'shell.execute'
  | 'notification.send'
  | 'network.request'
  | 'runtime.self_modify'          // install packages, add MCP servers inside the sandbox
  | 'runtime.schedule'             // an agent creating or changing schedules by itself
  | 'runtime.agents';              // an agent creating other agents
```

The last three are FREN names for things NanoClaw's guard already holds on.
The first ten describe host and world effects that no agent can perform from
inside the container today; they are reserved for the FREN tool server (§9.4).

### 9.2 The broker

`packages/permissions` is pure: `decide(request, policy) → { decision: 'ALLOW' | 'DENY' | 'ASK_USER', reason, matchedRule? }`.
`packages/fren-core/permission-broker.js` wraps it with storage and the UI
round trip.

```ts
type PermissionRequest = {
  id: string;
  scope: Permission;
  source: 'runtime' | 'automation' | 'core';
  subject: { sessionId?: string; automationId?: string; runId?: string };
  detail: { title: string; question: string; options: string[]; payload?: unknown };   // human-readable
  runtimeRequestId?: string;           // set when the runtime must be told the answer
  createdAt: number; expiresAt: number;
};

type PermissionPolicy = {
  automationGrants: Map<automationId, Permission[]>;   // from Automation.permissions
  sessionGrants: Map<sessionId, Permission[]>;         // "always allow for this conversation"
  denied: Permission[];                                // user-level hard denies
  defaults: { [scope in Permission]?: 'ALLOW' | 'DENY' | 'ASK_USER' };
};
```

Decision order: hard deny → automation grant → session grant → default for
the scope → `ASK_USER`. MVP defaults: everything `ASK_USER` except
`network.request` (`ALLOW`, because the container has open egress anyway and
a prompt per HTTP request is meaningless until an allowlist exists; §9.4
changes that). Expiry: an unanswered request expires in 10 minutes and is
reported to the runtime as a deny, which matches NanoClaw's own approval
timeout behaviour.

### 9.3 How NanoClaw's guard feeds the broker

NanoClaw already routes every `hold` to the owner's DM as an `ask_question`
card (§2.4). FREN registers the owner (`fren:owner`) and the DM lands on the
`fren` adapter, so **the guard's approval delivery is the broker's input**
and no second mechanism is added inside NanoClaw. The adapter maps the card
to a `permission.request` runtime event; the broker maps NanoClaw's action
name to a scope:

| NanoClaw action (from `pending_approvals.action` / title) | FREN scope |
|---|---|
| `self_mod.install_packages`, `self_mod.add_mcp_server` | `runtime.self_modify` |
| `cli_command` for `groups-config-*`, `groups-restart`, mounts | `runtime.self_modify` |
| `agents.create` | `runtime.agents` |
| `a2a.send` | `runtime.agents` |
| `senders.admit`, `channels.register` | not applicable (single user; auto-deny with a logged event) |

Because host callers over `ncl.sock` never hold, everything FREN Core does on
the user's behalf (creating a schedule the user just confirmed) is allowed
without a second prompt. Because `tasks-*` verbs are `open` for agents, an
agent could schedule its own work with no hold; the MVP closes that by
setting the `fren` group's `cli_scope` to `disabled`, which also removes the
`ncl` instructions from the agent's prompt. Enabling `runtime.schedule` later
means switching to `cli_scope: group` and reconciling runtime-created tasks
into FREN automations with `source: 'agent'`.

What the broker does not do in the MVP, said plainly: it does not intercept
the agent's own tool calls inside the container. The Claude SDK runs with
`bypassPermissions` there, and the boundary that protects the host is
container isolation (`--cap-drop=ALL`, non-root, only the session and
workspace mounted). The broker gates what crosses *out* of the container.

### 9.4 Roadmap: the FREN tool server and egress control

Two later components make the first ten scopes real, both outside the
runtime interface:

- **FREN tools** — an MCP server run by Core, reachable from the container at `host.docker.internal:4527/mcp`, added to the group's `container.json` `mcpServers`. Each tool (`fren.browser.read`, `fren.notify`, `fren.files.read` with a mounted read-only path, …) calls the broker before acting. This is how "FREN wants to send this email" becomes a card without NanoClaw knowing what email is. OpenClaw's exec-approval UX (allowlist, ask-once, ask-always, per-session) is the reference for the card's options.
- **Egress allowlist** — the sandbox proxy at `:4527` already terminates the model calls; extending it into a general forward proxy and switching the group to NanoClaw's `NANOCLAW_EGRESS_LOCKDOWN` shape (internal network whose only exit is a FREN-controlled container or the host proxy) makes `network.request` a real scope. Until then the UI copy says "this automation can reach the internet".
## 10. Persistence ownership

Each store has exactly one writer process, the discipline NanoClaw already
follows for its mailboxes and FREN follows for `fren.db`.

| Store | Location | Written by | Read by | Contents | Retention |
|---|---|---|---|---|---|
| `fren.db` | `<userData>/fren.db` | desktop main | desktop main | observations, memories, suggestions, messages, settings, legacy `automations`/`automation_runs`/`routines` | as today |
| soul files, screenshots | `<userData>/` | desktop main | desktop main; Core reads `SOUL.md` text over the existing chat payload path | persona, daily logs, images | as today |
| **`core.db`** (new) | `<userData>/core.db` | Core | Core (desktop reads via HTTP) | `sessions`, `runs`, `run_messages`, `automations`, `automation_runs`, `permission_requests`, `permission_grants`, `events`, `schema_version` | runs and events pruned at 30 days; automations kept |
| NanoClaw central DB | `<runtimeDir>/data/v2.db` | NanoClaw host | NanoClaw host | entity model, container configs, pending approvals, coordination | NanoClaw's |
| NanoClaw session mailboxes | `<runtimeDir>/data/v2-sessions/…` | host (inbound), container (outbound) | the other side | messages, acks, session state | NanoClaw's |
| NanoClaw group workspace | `<runtimeDir>/groups/fren/` | container (rw), host (compose) | container; Core reads `tasks/*.md` only through `tasks-get` | `CLAUDE.md`, `memory/`, `conversations/`, `tasks/` | NanoClaw's |
| Docker image, containers | Docker daemon | NanoClaw host (build, create) | — | `nanoclaw-agent-v2-<slug>` | reaped by NanoClaw |

Rules:

- **FREN never opens a NanoClaw database or workspace file.** Everything crosses `ncl.sock` or `fren-runtime.sock`. The one temptation, reading `outbound.db` to stream sooner, is refused: it would couple FREN to the mailbox schema and break the single-reader rule NanoClaw relies on for VirtioFS.
- **`core.db` gets a migration table from day one** (`schema_version`, numbered migration functions), because FREN's current "one CREATE IF NOT EXISTS string" style cannot add a column to an existing install (§1.4) and this store will change.
- **`<runtimeDir>`** is `vendor/nanoclaw` in development (its own `.gitignore` covers `data/`, `groups/`, `logs/`, `store/`; FREN's root `.gitignore` lists them again explicitly) and `<userData>/runtime/nanoclaw-<version>/` in a packaged app, where Core copies the built host and `container/` tree on first run. Both satisfy NanoClaw's requirement that `data/` and `container/agent-runner/src` sit under `process.cwd()`.
- **Legacy tables stay where they are** until phase 5 moves `routines` and script `automations` into `core.db` behind the unified model. Until then the dashboard merges three lists.

## 11. Lifecycle: startup and shutdown

### 11.1 Core startup (`apps/gateway/server.js` → `packages/fren-core`)

1. `loadEnv()`, `pickProvider()`, `pickVoice()`, `pickVision()` as today.
2. Open `<userData>/core.db`, run migrations. `FREN_DATA_DIR` overrides the location (set by `start.js` in dev to the same folder Electron uses).
3. Build the runtime: `FREN_RUNTIME=mock|nanoclaw` (default `nanoclaw`; `mock` when `FREN_LLM_PROVIDER=mock` so offline dev needs no flags).
4. Start the event log and SSE endpoint; start the sandbox credential proxy on `127.0.0.1:4527` (`FREN_SANDBOX_PORT`), loopback only, token-checked.
5. Listen on `127.0.0.1:4519`. From this moment `/health` answers with `runtime: { state: 'starting' }`.
6. `runtime.start()` in the background; status transitions stream as `runtime.status` events. The desktop is never blocked on the runtime.
7. Recover: runs left `running` or `queued` in `core.db` from a previous life become `interrupted`; permission requests past expiry become `expired`.

### 11.2 `runtime-nanoclaw.start()`

1. **Probe the container runtime** through the `ContainerRuntime` seam (`docker version`, `docker info`, both with a 10 s timeout). Not installed → `unavailable` with hint "Install Docker Desktop"; installed but not running → `unavailable` with hint "Start Docker Desktop" and, on macOS, an offered action that runs `open -a Docker` (what NanoClaw's own setup does, `setup/container.ts:41-42`). The UI shows "secure execution environment" and the hint; Docker is named only in the hint text.
2. **Ensure the runtime install**: `<runtimeDir>` exists with `dist/index.js` and `node_modules`; if not, run `scripts/runtime-build.js` (dev) or copy the packaged tree (app). Ensure the agent image exists (`docker image inspect nanoclaw-agent-v2-<slug>:latest`); if not, run `container/build.sh` with stderr lines forwarded as `starting` progress. First build takes minutes; the status says so.
3. **Stamp the upgrade marker**: write `<runtimeDir>/data/upgrade-state.json` with the vendored version and the current `git rev-parse HEAD`/`HEAD^{tree}` of `<runtimeDir>` (the equivalent of `scripts/upgrade-state.ts set`). In a subtree, `HEAD` is FREN's commit and changes with every FREN commit, so the supervisor stamps on every start; in a packaged copy there is no `.git`, and NanoClaw accepts the version match alone (`src/upgrade-state.ts:107-119`).
4. **Listen** on `<userData>/fren-runtime.sock` (`0600`) before spawning, so the adapter can never see an absent server.
5. **Spawn** `node dist/index.js` with `cwd = <runtimeDir>`, `stdio: ['ignore', 'pipe', 'pipe']` (logs go to `<userData>/logs/runtime.log`, never to the renderer), and env limited to: `PATH`, `HOME`, `TZ`, `FREN_CORE_SOCKET`, `FREN_RUNTIME_TOKEN`, `FREN_SANDBOX_URL` (`http://host.docker.internal:4527/anthropic`), `FREN_SANDBOX_TOKEN`, `NANOCLAW_GATEWAY_PROVIDER=fren`, `NANOCLAW_INSTALL_ID=fren`, `LOG_LEVEL`. No provider key.
6. **Wait** for the adapter's `hello` on `fren-runtime.sock` (carries the token) and for `ncl.sock` to answer `help`. 30 s budget, then fail with the last stderr lines.
7. **Bootstrap entities**, all idempotent (each call is a create-if-missing by natural key), over `ncl.sock`:
   - `groups-create --folder fren --name fren` (+ `groups-config-update --cli-scope disabled --model <model> --timezone <tz>`),
   - `users-create --id fren:owner --kind fren --display-name <profile.name>`, `roles-grant --user fren:owner --role owner`,
   - `messaging-groups-create --channel-type fren --platform-id owner --instance fren --unknown-sender-policy public`,
   - `wirings-create --channel-type fren --platform-id owner --agent-group fren --engage-mode pattern --engage-pattern . --session-mode per-thread`,
   - write the persona into the group workspace through the runtime's own composition input (the group's `instructions.prepend.md` is what `project-doc-compose` reads; the adapter writes it from the `persona` passed by `createSession`; this is the one file under `groups/` the adapter touches, and only because NanoClaw defines it as the persona slot),
   - reconcile: `tasks-list --group fren` against `core.db.automations.runtime_ref`; a schedule the runtime has and FREN does not is reported as a `schedule.orphan` event (not deleted).
8. Emit `runtime.status { state: 'ready' }`.

### 11.3 Desktop startup

Unchanged except: `checkHealth` reads `health.runtime` into a new
`state.runtime` field (`unavailable | starting | ready | degraded`), opens the
SSE stream with reconnect and `Last-Event-ID`, and re-broadcasts each event to
**all** windows as `fren:coreEvent` (fixing the orb-only push targeting noted
in §1.6). The orb's dot gains a second state for the runtime; the dashboard
gains a status block using the existing `browserBlock()` pattern.

### 11.4 Shutdown

- Desktop quit → `start.js` sees the child exit and kills the gateway (dev). In a packaged app the desktop sends `POST /v1/runtime/stop` then terminates Core.
- `runtime-nanoclaw.stop()`: SIGTERM the host; wait up to 10 s for exit (NanoClaw's `shutdown()` closes sockets and the DB but **leaves containers running**, `src/index.ts:177-196`); then stop every container labelled `nanoclaw-install=fren` through the `ContainerRuntime` seam; close `fren-runtime.sock`. An ambient companion must not leave agents working after the user quit it.
- Core marks in-flight runs `interrupted` with reason `shutdown` and persists the event log before exit.

## 12. Failure recovery

| Failure | Detected by | Effect | Recovery |
|---|---|---|---|
| Docker not installed / not running at start | probe in `start()` | status `unavailable` + hint; chat falls back to the fast lane; automations listed but idle | user installs/starts Docker; Core re-probes every 30 s while `unavailable` and starts automatically |
| Docker stops while running | host's `docker events` stream ends; next spawn fails `runtime-unavailable` | status `degraded`; new runs fail fast with a readable reason | same re-probe; NanoClaw's sweep retries pending rows with backoff |
| NanoClaw host crashes | child `exit` event | status `degraded`; open runs `interrupted` | supervisor restarts with backoff `[1, 2, 5, 15, 30] s`, honouring NanoClaw's own circuit breaker file; after five failures status `unavailable` with the last stderr lines; NanoClaw adopts still-running containers on restart |
| Core crashes | desktop health poll (30 s) and SSE disconnect | orb dot off; chat unavailable | `start.js` shuts the pair down in dev; the packaged desktop restarts Core; on restart §11.1 step 7 and §11.2 step 7 reconcile |
| Container crashes mid-run | NanoClaw heartbeat/claim logic | NanoClaw retries the inbound row up to 5× with backoff; the adapter sees typing stop and later resume | run stays `running` until `turn.completed` or the run timeout (10 min) marks it `failed` with "the agent stopped responding" |
| Agent never delivers (unwrapped output) | NanoClaw nudges once; still nothing | `turn.completed` arrives with zero messages | run `completed` with a synthetic message "I finished but produced nothing to show"; logged as `run.empty` for diagnosis |
| Scheduled fire fails | the adapter's schedule watch: the fired row's acknowledgement, or `failed_runs` moving | `automation_runs` row `failed` ("the run failed in the secure execution environment": the host records no reason) | NanoClaw backs off; after 8 consecutive failures it pauses the task with a note in the run log → the adapter emits `schedule.paused` → Core switches the automation off with the reason (`enabled: false`, `pausedByRuntime`), the orb says so once, the card shows why and offers Resume; resuming from FREN clears the reason and resumes the task |
| `fren-runtime.sock` disconnects | the host's link reconnects (0.5 s → 10 s backoff) and the fren adapter reports itself disconnected | nothing is attempted and nothing is counted: an adapter that says it is not connected is skipped by delivery (`ChannelAdapterOfflineError`, upstream-able), so the host's mailbox is the queue and no row is marked failed during a gap | on reconnect the host drains the rows in order; a chat reply lands on its run if still open, else in the transcript; an automation result lands on the run the row opens; runs waiting on a host row are watched again |
| Upgrade tripwire refuses boot | host exits 1 with the banner on stderr | status `unavailable` with the banner | supervisor re-stamps the marker once and retries; if it still refuses, the hint says the runtime install is inconsistent |
| Approval unanswered | broker expiry (10 min) | request `expired`; runtime told `deny` | the agent sees a rejection and continues; nothing is silently approved |

Idempotency is what makes these recoveries safe: every bootstrap call
creates-if-missing, every `createSchedule` derives its `ncl` names from the
FREN automation id, and every event has a monotonic id so the desktop can
resume the stream.

## 13. Docker and container strategy

**MVP: Docker, named only in one place.** `packages/runtime-nanoclaw/container-runtime.js`
is the probe seam: `detect() → { kind: 'docker', available, running, version, hint }`,
`ensureImage(progress)`, `stopLabeled(label)`. NanoClaw itself shells the
`docker` binary directly (§2.5), so today the seam is about *probing and
messaging*, not substitution. The UI vocabulary is fixed: "secure execution
environment"; "preparing", "not installed", "not running"; the hint text is
the only place a product name appears.

**Assumed in the MVP:** Docker Desktop installed by the user, the daemon
reachable, `host.docker.internal` resolving to the host so containers can
reach the Core proxy. On Docker Desktop for macOS this reaches services bound
to `127.0.0.1`, which is how NanoClaw's own Ollama recipe works
(`docs/ollama.md:25-30`). On Linux `host-gateway` is the bridge address and
the proxy must bind it as well; the proxy binds `127.0.0.1` by default and
`FREN_SANDBOX_BIND` widens it.

**Roadmap, in order of leverage:**

1. **Apple Container** on macOS 26 (this machine runs 26.5). NanoClaw's `SessionDriver` registry is the seam (`registerSessionDriver`, `NANOCLAW_RUNTIME_DRIVER`); a driver is `prepare/listSessions/watchSessions/reapResidue` over the `container` CLI, plus an image build path. The mailbox design already assumes VirtioFS semantics (`journal_mode=DELETE`, `mmap_size=0`), so the two-file protocol carries over. Because `ensureReady` is optional, this driver can also make the host boot without Docker. This is the "download FREN → drag → works" path and does not touch FREN's product layer.
2. **Docker Sandboxes / microVM** runtimes: same seam, `runtimeTier: 'vm'` already exists on `SessionSpec`.
3. **Bundled Docker CLI + a managed daemon** is rejected: licence and support burden, and it still needs a VM on macOS.

**Not solved now, deliberately:** invisible installation. Phase 1 makes the
product usable without any container runtime (mock runtime, fast-lane chat,
`question` automations), so "install Docker" is a feature gate, not a wall.

## 14. Upstream NanoClaw maintenance strategy

Four options were weighed:

| Option | Upstream merges | Packaging | Fragility |
|---|---|---|---|
| **Vendor as `git subtree`** (recommended) | `git subtree pull --squash`; conflicts only where FREN's overlay and upstream touch the same lines | one repo, one clone, the tree is on disk for the build | low: overlay is additive files plus one-line barrel appends, exactly what upstream's skills do |
| Fork repository consumed by clone/install | fine for upstreamable fixes | requires fetching at build time or a second checkout | medium: version drift between repos; contributors need two remotes |
| Git submodule | clean history | detached HEADs, `--recursive` everywhere, Electron packagers handle them badly | high for a small team |
| Separate process from an external NanoClaw install | zero source coupling | the product depends on a directory it does not ship | high: unpinned, unbuildable offline |

**Recommendation: subtree, with the overlay committed inside it, plus a check.**

- `vendor/nanoclaw` is `git subtree add --prefix vendor/nanoclaw https://github.com/nanocoai/nanoclaw main --squash` at `5c3082a`; `vendor/NANOCLAW_UPSTREAM` records the commit; `scripts/nanoclaw-sync.sh` wraps `git subtree pull` and runs the check.
- FREN's additions are limited to what upstream's own skills add: `src/channels/fren.ts` (+ one import line in `src/channels/index.ts`), `src/gateway-providers/fren.ts` (+ one line in `src/gateway-providers/installed.ts`), `src/modules/fren/` for the delivery provenance and turn-completion hooks (+ one line in `src/modules/index.ts`), and their tests. No schema migration, no change to router, delivery, sweep, container-runner or guard. `.env.example` and `package.json` are untouched (config rides env, no new dependency).
- `scripts/nanoclaw-overlay-check.js` asserts the overlay files exist and the three barrel lines are present; `npm test` runs it, so a subtree pull that dropped a line fails before it ships.
- Upstreamable changes (a bug fix, a `SessionDriver` for Apple Container) go to a `DemocracyEarth/nanoclaw` fork as PRs against upstream; FREN keeps consuming trunk through the subtree so the vendored tree never diverges from a published commit except by the overlay.
- Upstream's `/update-nanoclaw` controller is **not** used: it assumes a live install with a service and `data/` to snapshot. FREN's build script does the equivalent: install with the pinned pnpm (`npx pnpm@10.34.5`), `tsc`, rebuild the image when `container/` changed (compare the `agent-runner-lock-sha256` label NanoClaw already stamps on the image).
- Cadence: pull upstream at most once per FREN release; read `CHANGELOG.md` for the two things that can break the overlay, the `ChannelAdapter` interface and the gateway-provider registry, both of which have tests upstream that the overlay tests mirror.

## 15. Migration path to alternative runtimes

The contract is the product's insurance. Three runtimes are foreseeable:

- **`runtime-mock`** (phase 1) — in-process, deterministic, no Docker. Implements every method; `sendMessage` echoes a canned reply after a delay and emits the full event sequence; schedules fire on a fake clock the tests control. It is the reference implementation for the contract tests and what `FREN_LLM_PROVIDER=mock` uses.
- **`runtime-openclaw`** (later) — OpenClaw is a separate gateway process with a WebSocket protocol, sessions, cron with isolated sessions and delivery targets, per-agent sandboxes, and exec approvals. The adapter maps `sendMessage` to a session message, `createSchedule` to a cron job whose delivery target is a FREN channel plugin, `permission.request` to OpenClaw's exec-approval events, and `getCapabilities()` to `{ tokenStreaming: true, toolEvents: true, turnBoundary: 'exact' }`. FREN's UI would light up token streaming without changing a product concept.
- **A custom in-process runtime** — technically the mock grown up: the Claude Agent SDK on the host with a restricted tool set. The seam allows it; this document recommends against it because it discards the isolation that makes `shell.execute` inside the sandbox acceptable.

What makes the migration real rather than aspirational:

1. The contract test suite runs against every adapter; a new runtime is done when it passes.
2. No FREN table stores a runtime concept: `runtime_ref` is opaque JSON, `Run.messages` is FREN's shape, `Automation` never mentions tasks or sessions.
3. `getCapabilities()` is consulted by the UI, so a richer runtime is used to the full and a poorer one is not misrepresented.
4. The desktop knows only `runtime.state` and `runtime.kind`.

## 16. MVP implementation phases

Each phase leaves `npm start` working and `npm test` green. Phases 1 and 2
are the vertical slice.

### Phase 0: this document (done)

### Phase 1: contract, Core, mock runtime, UI (no Docker needed) — done

Landed on branch `nanoclaw-runtime` as eight commits after this document. What
exists: `packages/runtime` (contract + 14 contract tests), `packages/runtime-mock`,
`packages/shared/cron.js`, `packages/fren-core` (store with migrations, event log
over server-sent events, runs, automations, permission broker, routes),
`packages/observer`, `packages/permissions`, the gateway mounting Core, and the
desktop wired end to end (event stream client, run lane in both chat surfaces,
automation proposals and cards, approval cards, a Requests section, the
environment's state in words). `FREN_RUNTIME` selects the runtime; only `mock`
exists until phase 2. `docs/privacy.md`, the README and `FREN_FACTS` were
updated in the same commit as the interface.

Deliverables: `packages/runtime` (types, errors, contract tests), `packages/runtime-mock`, `packages/fren-core` (`core.db` with migrations, runs, sessions, automations, automation engine with the lifted `isDue` scheduler, permission broker, event log, SSE), `packages/observer` and `packages/permissions` (types and pure functions with tests), new routes mounted in `apps/gateway/server.js`, desktop: `state.runtime`, SSE consumer, `fren:run`, `fren:automationIntent`, `fren:automations2` list with enable/disable/delete/run-now, approval card in the panel, dashboard status block and runs section; the desktop also scrubs `FREN_VISION_API_KEY` alongside the other four keys; `docs/privacy.md` and `FREN_FACTS` updated for what an automation can now do.

Exit criteria: with `FREN_LLM_PROVIDER=mock`, a user can chat through the runtime (bubbles arrive as events), say "every morning at 9 …", confirm, see the automation listed, toggle it, run it now, see its result, and answer a permission card the mock raises. All 15 milestone steps pass against the mock except 7 ("executes in a Docker container").

### Phase 2: NanoClaw runtime (Docker and a provider key needed) — done, verified in a real container

Landed as three commits. `vendor/nanoclaw` is the subtree at `5c3082a1` with the
three overlay files and three barrel lines (typechecked; upstream's suites still
pass); `scripts/runtime-build.js`, `scripts/nanoclaw-overlay-check.js` and
`scripts/nanoclaw-sync.sh` exist; `packages/runtime-nanoclaw` implements the
contract over the host's two sockets; Core runs the sandbox credential proxy;
`FREN_RUNTIME=auto` selects the host when it is built. The contract suite runs
against the adapter through a fake host that speaks both sockets
(`packages/runtime-nanoclaw/test/fake-host.js`), so the adapter's behaviour is
tested on a machine with no container runtime. On this machine the gateway
reports `unavailable: no container runtime is installed` with the install hint,
which is the designed outcome.

**Verified on 2026-09-02 with Docker Desktop 4.89 and a DeepSeek key only.**
The first real run found four things, all fixed the same day: the host stores
an inbound id as `<id>:<agentGroupId>` (the turn watcher now matches by
prefix); the task commands take the agent group's id, not its folder; the
vendored build names the image by a hash of the checkout path that the host's
`NANOCLAW_INSTALL_ID` override does not follow (the adapter derives the same
hash); and macOS caps Unix socket paths near 104 bytes (the bridge falls back
to a short private directory). Two product gaps were closed in the same pass:
the persona slot (`groups/fren/instructions.prepend.md`) is written from the
persona Core passes, so the agent introduces itself as fren; and deleting an
automation whose container is still running now cancels the task and deletes
it once the run ends.

What the run showed: bootstrap creates the group, owner, role, surface and
wiring on the first start and finds them present on the next; a chat run
spawns a container, reaches DeepSeek's Anthropic-compatible endpoint through
the sandbox proxy (the proxy rewrites the requested model to `deepseek-chat`),
delivers the reply mid-turn, and closes on the container's own
acknowledgement; the same conversation is resumed inside the container on the
next message; an automation created from FREN becomes a task plus a delivery
surface, run-now wakes its own session on the next sweep tick (about a minute),
the agent sends its result to `automation-<id>` and FREN records `READY`,
delivered, with the run tied to the automation. A real hold was verified the same evening: with the
group's `cli_scope` set to `group`, the agent ran `ncl groups config update`
from its shell, the host's guard held it, `requestApproval` resolved the owner's
DM to the `owner` surface and delivered the card, FREN raised
`permission.requested` with scope `runtime.self_modify`, the owner approved it in
the interface 36 seconds later, the host replayed the command with the approval
as its grant, and the agent reported the result in a message of its own (no run
behind it, which is why the orb now speaks unsolicited agent messages too).
`cli_scope` stays `disabled` by default; enabling it is the `runtime.schedule`
and `runtime.self_modify` decision the permission model describes.

Deliverables: `vendor/nanoclaw` subtree + overlay (`fren` channel, `fren` gateway provider, provenance module) with upstream-style tests, `scripts/runtime-build.js`, `scripts/nanoclaw-overlay-check.js`, `packages/runtime-nanoclaw` (supervisor, `ncl` client, `fren-runtime.sock` server, bootstrap, task compiler, `container-runtime.js` probe, sandbox proxy target), the sandbox credential proxy in Core, integration test gated on `FREN_RUNTIME_INTEGRATION=1`.

Exit criteria: milestone steps 1–15 pass end to end with a real container; the same UI, no code path in the desktop changed between phase 1 and 2.

### Phase 3: robustness

What remains here is packaging: the built host and the agent image under `<userData>/runtime` for an installed app. Done: run timeouts (an hour for a scheduled run, ten minutes for a chat turn); orphan reporting (`schedule.orphan`); the re-probe loop; a gap on the bridge needs no reconciliation because nothing is marked failed during it (see the failure table; the fren adapter is skipped while it reports disconnected, a change small enough to go upstream); run-now feeds the host's reconcile queue instead of waiting for the sweep (upstream-able, two lines in `tasks.ts`); a host left running by an earlier Core life is stopped before a new one starts (`runtime-host.pid` next to the log); the runtime log rotates at 5 MB, three files kept.

Done ahead of the rest, because the milestone made the gap visible: the adapter's schedule watch (`packages/runtime-nanoclaw/schedule-watch.js`) reads the host's task list every 15 s and turns fires FREN did not start into runs (watched to their acknowledgement when caught due, opened and closed at once when only the counters tell), and the host's auto-pause into `schedule.paused`. Core treats that as the automation going off with a reason, on the event and again at reconcile if the pause happened while Core was away; a person's Resume is the only thing that clears it. The same change made schedules survive a Core restart: the task list shortens prompts, so the adapter reads the whole task to recover the automation id, instead of creating a second task.

### Phase 4: permissions beyond the guard

The FREN tool server over MCP (`notification.send` first, then `browser.read` via the existing sensor), per-automation grants in the creation flow, egress allowlist at the proxy.

### Phase 5: one automation model

Move `routines` (→ `question` bodies) and script `automations` (→ `script` bodies) into `core.db`; the dashboard renders one list with three body kinds; retire the two 30-second loops in `index.js` in favour of Core's scheduler for `question` bodies. Observation producers start posting to the bus; the first context selector is built with its own privacy review.

## 17. The smallest plan for the vertical slice

Ordered, each a commit or a small PR, each keeping the app runnable.

1. **`packages/runtime`**: typedefs, event names, `RuntimeUnavailable`, `contract.test.js` parameterised by a factory. Commit.
2. **`packages/runtime-mock`** passing the contract tests. Commit.
3. **`packages/fren-core/store.js`**: `core.db` with `schema_version`, migrations 001 (sessions, runs, run_messages, automations, automation_runs, permission_requests, events). Tests with a temp file. Commit.
4. **`packages/fren-core/events.js`** + SSE route `GET /v1/events` with `Last-Event-ID`; `packages/fren-core/runs.js` (`POST /v1/runs`, `GET /v1/runs/:id`, cancel) wired to the runtime; `/health.runtime`. Mount in `server.js` under the existing auth. Tests with `createServer(provider, voice, vision, { runtime: mock })`. Commit.
5. **Desktop**: `state.runtime`, SSE consumer in main with `fren:coreEvent` broadcast to all windows, preload `run`, `onCoreEvent`, `runtimeStatus`; panel uses `fren:run` when `runtime.state === 'ready'`, else `fren:chat`. Commit. (`npm start` now shows a runtime dot; mock runtime replies through events.)
6. **Automations in Core**: `automations.js` routes (list, create, patch, delete, run-now, intent), `automation-engine.js` (validate, compile, map to `createSchedule`/`triggerSchedule`, `question`-body scheduler lifted from `routines.js` with its tests), `intelligence.buildAutomationIntentRequest` + `AUTOMATION_INTENT_SCHEMA`. Commit.
7. **Desktop automations UI**: `looksScheduled` → `fren:automationIntent` → confirm → create; dashboard list for `agent` bodies beside the existing cards; run-now, toggle, delete; results via events. `docs/privacy.md`, README, `FREN_FACTS` updated. Commit. **Phase 1 exit.**
8. **Permission broker**: `packages/permissions` decide(), `permission-broker.js`, routes, panel card, dashboard "Requests". Mock runtime raises one request per `runAgent` when `FREN_MOCK_ASK=1`. Commit.
9. **Vendor NanoClaw**: `git subtree add` at `5c3082a`; `vendor/NANOCLAW_UPSTREAM`; root `.gitignore` entries; `scripts/runtime-build.js` (pinned pnpm, `tsc`); `npm run runtime:build`. Commit (large, mechanical).
10. **Overlay**: `src/channels/fren.ts` (client of `FREN_CORE_SOCKET`, NDJSON, `supportsThreads: true`, `deliver` rejects when disconnected, `setTyping` forwards, `onAction` on `action` frames), `src/gateway-providers/fren.ts` (contributes `ANTHROPIC_BASE_URL=$FREN_SANDBOX_URL`, `ANTHROPIC_AUTH_TOKEN=$FREN_SANDBOX_TOKEN`), `src/modules/fren/index.ts` (post-delivery provenance `{ runId: in_reply_to, seq }`, turn-completion watcher), barrel lines, vitest files mirroring upstream's integration-point tests; `scripts/nanoclaw-overlay-check.js` in `npm test`. Commit.
11. **`packages/runtime-nanoclaw`**: `container-runtime.js` probe, `supervisor.js`, `ncl-client.js` (one frame per connection), `bridge.js` (the `fren-runtime.sock` server and protocol), `bootstrap.js` (§11.2 step 7), `schedules.js` (compiler and the six `ncl` mappings), `index.js` implementing `FrenRuntime`; unit tests with a fake `ncl` socket and a fake adapter peer; contract tests gated on `FREN_RUNTIME_INTEGRATION=1`. Commit.
12. **Sandbox proxy** in Core (`/anthropic/*` on `:4527`, token check, upstream = Anthropic or `ANTHROPIC_BASE_URL`-compatible endpoint from `.env`; header rewrite; no body logging). Commit.
13. **Wire it**: `FREN_RUNTIME=nanoclaw` default when Docker is detected; `start()` sequence; `stop()`; status hints. Run the milestone by hand with Docker and a key; fix; commit. **Phase 2 exit.**

Estimated shape: steps 1–8 are pure FREN and testable on this machine today;
steps 9–13 need Docker Desktop and either an Anthropic key or the DeepSeek
Anthropic-compatible endpoint configured as the proxy upstream.

## 18. Open questions and risks, with the decision taken for each

| Question | Decision now | Revisit when |
|---|---|---|
| Which model runs inside the sandbox on this machine (only `DEEPSEEK_API_KEY` is set)? | Proxy upstream defaults to Anthropic; `FREN_SANDBOX_UPSTREAM=deepseek` points the same proxy at DeepSeek's Anthropic-compatible endpoint with `deepseek-chat` as the model. Tool-use quality there is untested; the supported upstream path for DeepSeek is NanoClaw's `/add-opencode`, which is a later overlay if the compatible endpoint disappoints. | first real run |
| Does `ensureUserDm('fren:owner')` reuse the `owner` messaging group or fail on the unique key? | Assumed reuse (same natural key). If it mints a new group, the adapter treats any thread-less delivery on channel `fren` as the system surface, so the UI is unaffected either way. | phase 2 step 11 |
| Does a task session need a wiring, or is a destination row enough for delivery? | Destination row (`destinations-add`) per §2.3 and `src/delivery.ts:429-446`. | phase 2 step 11 |
| Turn-completion signal | Overlay watches the inbound row's ack (`completed`) and emits `turn.completed`; quiet-window fallback of 3 s after the last delivery when the watcher is unavailable. | phase 2 step 10 |
| `tasks-run` latency up to 60 s | Accepted; the UI shows "starting within a minute". A `reconcile-now` verb would be a one-line upstream PR later. | after phase 2 |
| Open egress from containers | Accepted for the MVP and disclosed in `docs/privacy.md`. | phase 4 |
| `groups/fren/instructions.prepend.md` written by the adapter | The only workspace file FREN writes; it is NanoClaw's persona slot. If upstream moves it, only `bootstrap.js` changes. | subtree pulls |
| Two 30-second schedulers remain in `index.js` until phase 5 | Accepted; `agent` bodies never touch them. | phase 5 |
| Should agents be allowed to schedule their own work? | No (`cli_scope: disabled`). | when `runtime.schedule` gets a UI |
