// Deterministic offline provider — no network, no credentials. Used in tests
// and whenever the Anthropic SDK is unavailable.

// Best-effort: pull app names out of timeline lines like
// "14:03-14:12 (9m) Chrome — GitHub PR #42". Empty when nothing matches.
function deriveApps(messages) {
  const text = (messages || [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const apps = [];
  for (const line of text.split('\n')) {
    const m = /^\d{2}:\d{2}-\d{2}:\d{2} \(\d+m\) (.+?)(?: — .*)?$/.exec(line);
    if (m && !apps.includes(m[1])) apps.push(m[1]);
  }
  return apps;
}

function createMockProvider() {
  return {
    name: 'mock',
    async complete({ messages, schema }) {
      if (schema) {
        const apps = deriveApps(messages);
        return JSON.stringify({
          activity: 'working across ' + (apps.length > 0 ? apps.join(', ') : 'your apps'),
          applications: [],
          confidence: 0.3,
        });
      }
      return 'fren (mock mode): no LLM is configured, so this is a canned reply.';
    },
  };
}

module.exports = { createMockProvider };
