// DeepSeek provider — OpenAI-compatible chat completions over plain fetch,
// so it adds no dependency. Like every provider, it lives only in the gateway;
// the desktop app never learns which model answered.
const { config } = require('../../../packages/shared');

const DEFAULT_MODEL = 'deepseek-chat';

function createDeepSeekProvider() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const model = config.MODEL || DEFAULT_MODEL;
  if (!/^deepseek/i.test(model)) {
    console.warn(
      `[gateway] FREN_MODEL="${model}" does not look like a DeepSeek model; ` +
        `leave FREN_MODEL empty to use ${DEFAULT_MODEL}`
    );
  }

  return {
    name: 'deepseek',
    model,
    // `model` overrides the configured default for this one call, so choosing
    // a model in the UI does not mean restarting the gateway.
    async complete({ system, messages, schema, maxTokens, model: override }) {
      const useModel = override || model;
      // DeepSeek offers JSON *mode*, not JSON Schema, so the shape has to go in
      // the prompt — and the word "json" must appear there or the API rejects
      // response_format. parseSummary still validates whatever comes back.
      const sys = schema
        ? `${system}\n\nRespond with a single json object and nothing else — no prose, no code fences. It must satisfy this JSON schema:\n${JSON.stringify(schema)}`
        : system;

      const baseUrl = process.env.DEEPSEEK_BASE_URL || config.DEEPSEEK_BASE_URL;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: maxTokens || 1024,
          messages: [{ role: 'system', content: sys }, ...messages],
          ...(schema ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        // Status and a short excerpt only — never the request body.
        const detail = await res.text().catch(() => '');
        throw new Error(`deepseek ${res.status}: ${detail.slice(0, 200)}`);
      }

      const data = await res.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : undefined;
      if (typeof content !== 'string' || content === '') {
        throw new Error('deepseek returned no message content');
      }
      return content;
    },
  };
}

module.exports = { createDeepSeekProvider, DEFAULT_MODEL };
