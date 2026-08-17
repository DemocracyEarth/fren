// Thin HTTP client for the local LLM gateway. The desktop app never talks to
// a model provider directly and never holds provider credentials.
const { config } = require('../../../packages/shared');

async function request(pathname, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${config.GATEWAY_URL}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.GATEWAY_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gateway ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

module.exports = {
  health: () => request('/health', { timeoutMs: 3_000 }),
  summarize: (observations) =>
    request('/v1/summarize', { method: 'POST', body: { observations } }),
  chat: (payload) => request('/v1/chat', { method: 'POST', body: payload, timeoutMs: 90_000 }),
};
