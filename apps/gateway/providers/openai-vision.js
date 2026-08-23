// A vision provider for anything that speaks the OpenAI chat format.
//
// Vision is the one thing DeepSeek's chat models cannot do, and Claude is
// expensive for what amounts to "describe this screenshot" — so this exists to
// let a cheap model do it. It is deliberately generic rather than tied to one
// vendor: Qwen-VL, GLM-4V, Moonshot, OpenRouter, a local llama.cpp server and
// anything else with an OpenAI-compatible endpoint all work by setting a base
// URL, a model and a key.
//
// Plain fetch, no SDK — the same reasoning as the DeepSeek provider.
const DEFAULTS = {
  // Alibaba's DashScope, because Qwen-VL is the cheapest capable option at the
  // time of writing and its endpoint is OpenAI-shaped.
  baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-plus',
};

function createOpenAIVisionProvider() {
  const apiKey = process.env.FREN_VISION_API_KEY;
  if (!apiKey) throw new Error('FREN_VISION_API_KEY is not set');

  const baseUrl = (process.env.FREN_VISION_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const model = process.env.FREN_VISION_MODEL || DEFAULTS.model;

  return {
    name: 'openai-vision',
    model,

    /**
     * Answer a question about one image.
     *
     * Each provider builds its own wire format from the same neutral inputs,
     * because OpenAI and Anthropic disagree about how an image rides in a
     * message and the gateway should not have to know which one it is talking
     * to.
     */
    async see({ system, question, image, mediaType = 'image/jpeg', maxTokens = 600 }) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:${mediaType};base64,${image}` } },
                { type: 'text', text: question },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        // PRIVACY: the body may echo the request. Status and model only.
        throw new Error(`vision provider returned ${res.status} for model ${model}`);
      }
      const json = await res.json();
      const choice = json && json.choices && json.choices[0];
      return (choice && choice.message && choice.message.content) || '';
    },
  };
}

module.exports = { createOpenAIVisionProvider, DEFAULTS };
