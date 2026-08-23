'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createOpenAIVisionProvider, DEFAULTS } = require('../providers/openai-vision.js');

const withEnv = (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

test('refuses to exist without a key rather than failing at request time', () => {
  withEnv({ FREN_VISION_API_KEY: '' }, () => {
    assert.throws(() => createOpenAIVisionProvider(), /FREN_VISION_API_KEY/);
  });
});

test('defaults to a cheap vision model, not a frontier one', () => {
  withEnv({ FREN_VISION_API_KEY: 'k' }, () => {
    const p = createOpenAIVisionProvider();
    assert.equal(p.model, DEFAULTS.model);
    // Describing a screenshot is not work worth frontier prices.
    assert.match(DEFAULTS.model, /qwen/i);
  });
});

test('any OpenAI-compatible endpoint can be pointed at', () => {
  withEnv({
    FREN_VISION_API_KEY: 'k',
    FREN_VISION_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/',
    FREN_VISION_MODEL: 'glm-4v',
  }, () => {
    const p = createOpenAIVisionProvider();
    assert.equal(p.model, 'glm-4v');
  });
});

test('sends the image in OpenAI shape, and never leaks the body on failure', async () => {
  const saved = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    await withEnv({ FREN_VISION_API_KEY: 'k' }, async () => {
      const p = createOpenAIVisionProvider();
      await assert.rejects(
        () => p.see({ system: 's', question: 'what is this?', image: 'AAAA', mediaType: 'image/jpeg' }),
        (err) => {
          // The response body can echo the request, which for vision means the
          // image and the question. Status and model only.
          assert.match(err.message, /429/);
          assert.ok(!/AAAA/.test(err.message), 'must never put image data in an error');
          assert.ok(!/what is this/.test(err.message), 'must never put the question in an error');
          return true;
        }
      );
    });
    assert.match(sent.url, /chat\/completions$/);
    const content = sent.body.messages.at(-1).content;
    assert.equal(content[0].type, 'image_url');
    assert.match(content[0].image_url.url, /^data:image\/jpeg;base64,AAAA$/);
    assert.equal(content[1].type, 'text');
  } finally {
    globalThis.fetch = saved;
  }
});

test('both vision providers expose the same neutral see()', () => {
  withEnv({ FREN_VISION_API_KEY: 'k' }, () => {
    assert.equal(typeof createOpenAIVisionProvider().see, 'function');
  });
  // Anthropic's is asserted structurally: requiring it needs the SDK present.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'providers', 'anthropic.js'), 'utf8');
  assert.match(src, /async see\(\{/, 'anthropic must offer the same entry point');
});
