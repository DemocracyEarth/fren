// Thin HTTP client for the local LLM gateway. The desktop app never talks to
// a model provider directly and never holds provider credentials.
const { config } = require('../../../packages/shared');
const { createEventStream } = require('./coreEvents');

/**
 * What the user chose, merged into every request that goes out.
 *
 * Held here rather than threaded through a dozen call sites, and applied only
 * to POST bodies. The gateway validates each field again and falls back to its
 * own default for anything it does not like, so this is a preference rather
 * than an instruction.
 */
let overrides = {};
function setOverrides(next) {
  overrides = next && typeof next === 'object' ? next : {};
}

function withOverrides(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if (overrides.chatModel) out.model = overrides.chatModel;
  return out;
}

async function request(pathname, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${config.GATEWAY_URL}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.GATEWAY_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(withOverrides(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Core answers with { error } — surface that sentence, not the status.
    let detail = text.slice(0, 200);
    try { detail = JSON.parse(text).error || detail; } catch { /* keep the text */ }
    throw new Error(`gateway ${pathname} -> ${res.status} ${detail}`);
  }
  return res.json();
}

/** Speech audio comes back as bytes, not JSON. */
async function speak(text) {
  const res = await fetch(`${config.GATEWAY_URL}/v1/speak`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      text,
      // Voice is its own choice, not the chat model.
      ...(overrides.voiceId ? { voice: overrides.voiceId } : {}),
      ...(overrides.voiceModel ? { voiceModel: overrides.voiceModel } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gateway /v1/speak -> ${res.status} ${detail.slice(0, 160)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Core's push channel. Resumable: pass `since: 'latest'` to skip history, and
 * the stream itself remembers where it got to across reconnects.
 */
function openEvents({ since = 'latest', onEvent, onStatus }) {
  return createEventStream({
    url: `${config.GATEWAY_URL}/v1/events`,
    token: config.GATEWAY_TOKEN,
    since,
    onEvent,
    onStatus,
  });
}

module.exports = {
  speak,
  setOverrides,
  openEvents,
  health: () => request('/health', { timeoutMs: 3_000 }),
  summarize: (observations) =>
    request('/v1/summarize', { method: 'POST', body: { observations } }),
  chat: (payload) => request('/v1/chat', { method: 'POST', body: payload, timeoutMs: 90_000 }),
  extract: (payload) => request('/v1/extract', { method: 'POST', body: payload, timeoutMs: 20_000 }),
  pattern: (payload) => request('/v1/pattern', { method: 'POST', body: payload, timeoutMs: 60_000 }),
  vision: (payload) => request('/v1/vision', { method: 'POST', body: payload, timeoutMs: 90_000 }),
  automate: (payload) => request('/v1/automate', { method: 'POST', body: payload, timeoutMs: 90_000 }),
  routine: (payload) => request('/v1/routine', { method: 'POST', body: payload, timeoutMs: 30_000 }),
  curious: (payload) => request('/v1/curious', { method: 'POST', body: payload, timeoutMs: 45_000 }),
  suggest: (payload) => request('/v1/suggest', { method: 'POST', body: payload, timeoutMs: 45_000 }),
  learn: (payload) => request('/v1/learn', { method: 'POST', body: payload, timeoutMs: 20_000 }),
  // Short: a greeting that arrives after the user has started working is not a
  // greeting. Better to miss it than to interrupt with a late hello.
  greet: (payload) => request('/v1/greet', { method: 'POST', body: payload, timeoutMs: 8_000 }),

  // ---- FREN Core: runs and the secure execution environment ----------------
  runtimeStatus: () => request('/v1/runtime/status', { timeoutMs: 5_000 }),
  // Accepted, not answered: the answer arrives as events.
  startRun: (payload) => request('/v1/runs', { method: 'POST', body: payload, timeoutMs: 15_000 }),
  getRun: (id) => request(`/v1/runs/${encodeURIComponent(id)}`, { timeoutMs: 10_000 }),
  cancelRun: (id) => request(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, timeoutMs: 10_000 }),
};
