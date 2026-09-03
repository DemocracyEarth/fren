/**
 * Where the runner's fixed locations live.
 *
 * Inside the container these are the canonical mount points and nothing
 * sets the overrides. A driver that runs the runner as a plain process on
 * the host (no container, no mounts) hands the same locations over as real
 * host paths, one env var per location. Every path the runner would
 * otherwise hard-code resolves through here, so both ways of running are
 * the same code with different roots.
 */
const env = process.env;

/** The session dir: mailbox DBs, heartbeat, outbox, inbox, extra mounts. */
export const WORKSPACE_DIR = env.NANOCLAW_WORKSPACE_DIR || '/workspace';
/** The agent group's folder: CLAUDE.md, container.json, memory, working files. */
export const AGENT_DIR = env.NANOCLAW_AGENT_DIR || `${WORKSPACE_DIR}/agent`;
/** The shared runner source (this tree), for commands that re-enter it. */
export const APP_SRC_DIR = env.NANOCLAW_APP_SRC_DIR || '/app/src';
/** The session context the host writes before spawn. */
export const SESSION_CONTEXT_PATH = env.NANOCLAW_SESSION_CONTEXT || '/app/.nanoclaw-session.json';
/** Operator-allowlisted extra directories appear as children of this dir. */
export const EXTRA_DIR = env.NANOCLAW_EXTRA_DIR || `${WORKSPACE_DIR}/extra`;
/** Outbound files, one folder per message id. */
export const OUTBOX_DIR = `${WORKSPACE_DIR}/outbox`;
/** The Claude Code executable the SDK drives; the image installs it at /pnpm/claude. */
export const CLAUDE_EXECUTABLE = env.NANOCLAW_CLAUDE_EXECUTABLE || '/pnpm/claude';
