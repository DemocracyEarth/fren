/**
 * The FrenRuntime contract, as JSDoc typedefs. No runtime code.
 *
 * A runtime is where agents execute: isolation, sessions, timers, tool use.
 * FREN owns everything a person can see or name; the runtime owns everything
 * about running an agent. This file is the vocabulary both sides share, and
 * the only vocabulary that may cross the boundary. Nothing here names a
 * particular runtime.
 *
 * See docs/runtime-architecture.md §7 for the reasoning behind each shape.
 *
 * @typedef {'unavailable'|'starting'|'ready'|'degraded'|'stopped'} RuntimeState
 *
 * @typedef {Object} RuntimeStatus
 * @property {RuntimeState} state
 * @property {string} [reason]     for unavailable/degraded: one sentence a person can act on
 * @property {string} [hint]       for unavailable: what to do about it ("Install Docker Desktop")
 * @property {string} [step]       for starting: what is happening now
 * @property {number} [progress]   for starting: 0..1 when known
 * @property {number} [since]      for ready: epoch ms
 * @property {number} [sessions]
 * @property {number} [runs]       runs in flight
 *
 * @typedef {Object} RuntimeCapabilities
 * @property {boolean} tokenStreaming      output arrives token by token (false: whole messages)
 * @property {boolean} toolEvents          per-tool events cross the boundary
 * @property {'exact'|'inferred'} turnBoundary
 * @property {'cron'} scheduleTrigger      what ScheduleInput.cron may contain
 * @property {number|null} maxFiresPerDay  null = unlimited
 * @property {'container'|'vm'|'process'|'none'} isolation
 * @property {boolean} files               the agent can send files back
 *
 * @typedef {Object} SessionInput
 * @property {string} name
 * @property {string} [persona]            rendered persona text (SOUL.md), given to the agent as instructions
 *
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} name
 * @property {number} createdAt
 * @property {unknown} [runtimeRef]        opaque, the runtime's own handle
 *
 * @typedef {Object} MessageInput
 * @property {string} sessionId
 * @property {string} runId                minted by the caller so a retry never starts a second run
 * @property {string} text
 *
 * @typedef {Object} AgentRunInput
 * @property {string} runId
 * @property {string} instruction
 * @property {string} [sessionName]        a named session to run in; fresh when absent
 *
 * @typedef {'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted'} RunStatus
 *
 * @typedef {Object} RunMessage
 * @property {number} seq
 * @property {number} at
 * @property {string} [text]
 * @property {string[]} [files]
 * @property {unknown} [card]
 * @property {boolean} final
 *
 * @typedef {Object} Run
 * @property {string} id
 * @property {string|null} sessionId
 * @property {'chat'|'agent'|'schedule'} kind
 * @property {RunStatus} status
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {string} [error]
 * @property {RunMessage[]} messages     in delivery order
 *
 * @typedef {Object} ScheduleInput
 * @property {string} automationId       FREN's id; the runtime derives its own names from it
 * @property {string} name
 * @property {string} [cron]           five-field cron, for a schedule that repeats
 * @property {number} [at]             a moment in ms, for a schedule that fires once (no cron)
 * @property {string} timezone           IANA zone
 * @property {string} instruction        already compiled by FREN Core
 * @property {string} deliveryName       where the agent must send its result
 * @property {boolean} [enabled]         default true
 * @property {boolean} [overrideFireLimit]
 *
 * @typedef {ScheduleInput & {
 *   id: string, enabled: boolean, nextRunAt?: number, lastRunAt?: number,
 *   runs: number, failedRuns: number, pausedByRuntime?: string, runtimeRef?: unknown
 * }} Schedule
 *
 * @typedef {Object} RuntimePermissionRequest
 * @property {string} id
 * @property {string} action             the runtime's own action name
 * @property {string} title
 * @property {string} question
 * @property {string[]} options
 * @property {string} [sessionId]
 * @property {string} [automationId]
 * @property {unknown} [payload]
 *
 * @typedef {(
 *   { type: 'runtime.status', status: RuntimeStatus } |
 *   { type: 'run.started'|'run.completed'|'run.failed'|'run.cancelled', runId: string, error?: string } |
 *   { type: 'agent.working', runId?: string, sessionId?: string, on: boolean } |
 *   { type: 'agent.message', runId?: string, automationId?: string, message: RunMessage } |
 *   { type: 'agent.question', runId: string, questionId: string, title: string, question: string, options: string[] } |
 *   { type: 'schedule.fired'|'schedule.completed'|'schedule.failed'|'schedule.paused', scheduleId: string, automationId: string, runId?: string, detail?: string } |
 *   { type: 'permission.request', request: RuntimePermissionRequest }
 * )} RuntimeEvent
 *
 * @typedef {Object} FrenRuntime
 * @property {string} kind
 * @property {() => Promise<void>} start                      idempotent; throws RuntimeUnavailable
 * @property {() => Promise<void>} stop                       idempotent
 * @property {() => Promise<RuntimeStatus>} getStatus
 * @property {() => RuntimeCapabilities} getCapabilities
 * @property {(input: SessionInput) => Promise<Session>} createSession
 * @property {() => Promise<Session[]>} listSessions
 * @property {(input: MessageInput) => Promise<Run>} sendMessage   resolves when accepted, not finished
 * @property {(input: AgentRunInput) => Promise<Run>} runAgent
 * @property {(id: string) => Promise<Run>} getRun
 * @property {(id: string) => Promise<void>} cancelRun
 * @property {(input: ScheduleInput) => Promise<Schedule>} createSchedule
 * @property {(id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }) => Promise<Schedule>} updateSchedule
 * @property {(id: string) => Promise<void>} deleteSchedule
 * @property {() => Promise<Schedule[]>} listSchedules
 * @property {(id: string) => Promise<Run>} triggerSchedule
 * @property {(requestId: string, decision: 'approve'|'deny', reason?: string) => Promise<void>} resolvePermission
 * @property {(listener: (event: RuntimeEvent) => void) => (() => void)} subscribe
 */
module.exports = {};
