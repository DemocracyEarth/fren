// Anthropic provider — the ONLY code in fren that talks to the Anthropic API.
const { config } = require('../../../packages/shared');

const DEFAULT_MODEL = 'claude-haiku-4-5';

function createAnthropicProvider() {
  // Lazy require: npm install may still be running; mock mode must work
  // without the SDK on disk. A failure here is caught by the provider picker.
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // default credential resolution (ANTHROPIC_API_KEY etc.)
  const model = config.MODEL || DEFAULT_MODEL;

  return {
    name: 'anthropic',
    model,
    // Per-call override; falls back to the configured default.
    async complete({ system, messages, schema, maxTokens, model: override }) {
      const useModel = override || model;
      const response = await client.messages.create({
        model: useModel,
        max_tokens: maxTokens || 1024,
        system,
        messages,
        ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {}),
      });
      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    },

    /** Answer a question about one image, in Anthropic's message shape. */
    async see({ system, question, image, mediaType = 'image/jpeg', maxTokens = 600 }) {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: question },
          ],
        }],
      });
      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    },
  };
}

module.exports = { createAnthropicProvider, DEFAULT_MODEL };
