// Anthropic provider — the ONLY code in fren that talks to the Anthropic API.
const { config } = require('../../../packages/shared');

function createAnthropicProvider() {
  // Lazy require: npm install may still be running; mock mode must work
  // without the SDK on disk. A failure here is caught by the provider picker.
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // default credential resolution (ANTHROPIC_API_KEY etc.)

  return {
    name: 'anthropic',
    async complete({ system, messages, schema, maxTokens }) {
      const response = await client.messages.create({
        model: config.MODEL,
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
  };
}

module.exports = { createAnthropicProvider };
