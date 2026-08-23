// Local LLM gateway — a small HTTP server, the ONLY component that talks to a
// model provider. The desktop app calls it over loopback with a bearer token
// and never learns which provider or model answered.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config, loadEnv } = require('../../packages/shared');
const intelligence = require('../../packages/intelligence');
const { createAnthropicProvider } = require('./providers/anthropic');
const { createOpenAIVisionProvider } = require('./providers/openai-vision');
const { createDeepSeekProvider } = require('./providers/deepseek');
const { createMockProvider } = require('./providers/mock');
const { createElevenLabsProvider } = require('./providers/elevenlabs');

const MAX_BODY_BYTES = 1024 * 1024;

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.status = status;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(413, 'request body too large');
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const err = new Error('malformed JSON body');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', () => fail(400, 'request aborted'));
  });
}

async function callProvider(provider, request, res) {
  try {
    return await provider.complete(request);
  } catch (err) {
    // Message only — never a stack, never the request/response bodies.
    send(res, 502, { error: (err && err.message) || 'provider error' });
    return null;
  }
}

async function handleSummarize(provider, body, res) {
  const observations = body && body.observations;
  if (!Array.isArray(observations) || observations.length === 0) {
    return send(res, 400, { error: 'observations must be a non-empty array' });
  }
  const request = intelligence.buildSummarizeRequest(observations);
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  const summary = intelligence.parseSummary(raw);
  if (!summary) return send(res, 502, { error: 'model returned an unparseable summary' });
  send(res, 200, summary);
}

/**
 * Pull the actual answer out of a spoken reply. Falls back to the raw answer on
 * any failure — a messy stored name is far better than a lost one.
 */
async function handleExtract(provider, body, res) {
  const { field, question, answer } = body || {};
  if (typeof answer !== 'string' || !answer.trim()) {
    return send(res, 400, { error: 'answer must be a non-empty string' });
  }
  const request = intelligence.buildExtractRequest({
    field: String(field || ''),
    question: String(question || ''),
    answer,
    asked: (body && body.asked && typeof body.asked === 'object') ? body.asked : {},
  });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    const kind = ['answer', 'question', 'correction'].includes(parsed.kind) ? parsed.kind : 'answer';
    const value = typeof parsed.value === 'string' ? parsed.value.trim() : '';
    return send(res, 200, {
      kind,
      // A plain answer must never come back empty: they did reply, and losing
      // it is worse than keeping it untidy. A question legitimately has none.
      value: kind === 'question' ? '' : (value || answer.trim()),
      corrects: typeof parsed.corrects === 'string' ? parsed.corrects.trim() : '',
      reply: typeof parsed.reply === 'string' ? parsed.reply.trim() : '',
    });
  } catch {
    send(res, 200, { kind: 'answer', value: answer.trim(), corrects: '', reply: '' });
  }
}

/** Look at recent summaries and decide whether anything is worth saying. */
async function handlePattern(provider, body, res) {
  const memories = body && body.memories;
  if (!Array.isArray(memories) || memories.length === 0) {
    return send(res, 400, { error: 'memories must be a non-empty array' });
  }
  const request = intelligence.buildPatternRequest({ memories });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    // Silence is the default, so an unusable answer means silence.
    send(res, 200, {
      interrupt: !!parsed.interrupt,
      reason: String(parsed.reason || ''),
      confidence: Number(parsed.confidence) || 0,
      message: String(parsed.message || ''),
      pattern: String(parsed.pattern || ''),
      occurrences: Number(parsed.occurrences) || 0,
    });
  } catch {
    send(res, 200, { interrupt: false, reason: 'unparseable', confidence: 0, message: '', pattern: '', occurrences: 0 });
  }
}

/**
 * Answer a question about ONE screenshot the user asked fren to take.
 *
 * The image is passed straight through to the provider and never written to
 * disk here, never logged, and never kept: it exists for the duration of this
 * request.
 */
async function handleVision(vision, body, res) {
  if (!vision) {
    return send(res, 503, {
      error: 'no vision-capable model is configured. Screen looking needs an ' +
             'ANTHROPIC_API_KEY; DeepSeek\'s chat models cannot see images.',
    });
  }
  const question = body && body.question;
  const image = body && body.image;
  if (typeof question !== 'string' || !question.trim()) {
    return send(res, 400, { error: 'question must be a non-empty string' });
  }
  if (typeof image !== 'string' || !image) {
    return send(res, 400, { error: 'image must be base64 data' });
  }

  const request = intelligence.buildVisionRequest({
    question,
    soul: typeof body.soul === 'string' ? body.soul : '',
    userDoc: typeof body.userDoc === 'string' ? body.userDoc : '',
  });

  // Each provider builds its own wire format: OpenAI and Anthropic disagree
  // about how an image rides in a message, and the gateway should not have to
  // know which one it is holding.
  try {
    const reply = await vision.see({
      system: request.system,
      question,
      image,
      mediaType: body.mediaType || 'image/jpeg',
    });
    send(res, 200, { reply: String(reply || '').trim() });
  } catch (err) {
    // PRIVACY: never log the question or anything about the image.
    console.warn(`[gateway] vision failed (${err.message})`);
    send(res, 502, { error: (err && err.message) || 'vision provider error' });
  }
}

async function handleChat(provider, body, res) {
  const question = body && body.question;
  if (typeof question !== 'string' || question.trim() === '') {
    return send(res, 400, { error: 'question must be a non-empty string' });
  }
  const request = intelligence.buildChatRequest({
    question,
    memories: Array.isArray(body.memories) ? body.memories : [],
    observations: Array.isArray(body.observations) ? body.observations : [],
    // What the user told fren about themselves during setup. Never logged.
    profile: body.profile && typeof body.profile === 'object' ? body.profile : null,
    // SOUL.md and USER.md, as the user has them on disk.
    soul: typeof body.soul === 'string' ? body.soul : '',
    userDoc: typeof body.userDoc === 'string' ? body.userDoc : '',
  });
  const reply = await callProvider(provider, request, res);
  if (reply === null) return;
  send(res, 200, { reply });
}

async function handleSpeak(voice, body, res) {
  const text = body && body.text;
  if (typeof text !== 'string' || text.trim() === '') {
    return send(res, 400, { error: 'text must be a non-empty string' });
  }
  if (!voice) return send(res, 503, { error: 'no voice provider configured' });
  try {
    const { audio, contentType } = await voice.speak(text.slice(0, 2000));
    res.writeHead(200, { 'content-type': contentType, 'content-length': audio.length });
    res.end(audio);
  } catch (err) {
    send(res, 502, { error: (err && err.message) || 'voice error' });
  }
}

async function handle(provider, voice, vision, req, res, pathname) {
  if (req.method === 'GET' && pathname === '/health') {
    return send(res, 200, {
      ok: true,
      provider: provider.name,
      model: provider.model,
      voice: voice ? voice.name : null,
      // The desktop app needs this to know whether the screen-looking toggle
      // can be offered at all.
      vision: vision ? vision.name : null,
    });
  }

  if (req.method === 'POST' && (pathname === '/v1/summarize' || pathname === '/v1/chat' ||
                                pathname === '/v1/speak' || pathname === '/v1/extract' ||
                                pathname === '/v1/pattern' || pathname === '/v1/vision')) {
    if (req.headers.authorization !== `Bearer ${config.GATEWAY_TOKEN}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(res, err.status || 400, { error: err.message });
    }
    if (pathname === '/v1/summarize') return handleSummarize(provider, body, res);
    if (pathname === '/v1/extract') return handleExtract(provider, body, res);
    if (pathname === '/v1/pattern') return handlePattern(provider, body, res);
    if (pathname === '/v1/vision') return handleVision(vision, body, res);
    if (pathname === '/v1/speak') return handleSpeak(voice, body, res);
    return handleChat(provider, body, res);
  }

  send(res, 404, { error: 'not found' });
}

function createServer(provider, voice = null, vision = null) {
  return http.createServer((req, res) => {
    const started = Date.now();
    const pathname = (req.url || '/').split('?')[0];
    res.on('finish', () => {
      // PRIVACY: method, path, status, duration only. Never log bodies.
      console.log(`[gateway] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    handle(provider, voice, vision, req, res, pathname).catch((err) => {
      if (!res.headersSent) {
        send(res, 502, { error: (err && err.message) || 'internal error' });
      }
    });
  });
}

// The SDK resolves credentials lazily (env vars or an `ant auth login`
// profile), so constructing a client without credentials succeeds and only
// fails per-request. Check up front so we can fall back to mock at startup.
function hasAnthropicCredentials() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const configDir =
    process.env.ANTHROPIC_CONFIG_DIR || path.join(os.homedir(), '.config', 'anthropic');
  try {
    return fs.readdirSync(path.join(configDir, 'credentials')).length > 0;
  } catch {
    return false;
  }
}

/**
 * Looking at a screenshot needs a model that can see, and the text provider
 * usually cannot: DeepSeek's chat models are text-only. So vision is chosen
 * SEPARATELY from text, and is simply unavailable when nothing can do it —
 * rather than silently degrading into a confident guess about an image the
 * model never received.
 */
function pickVision() {
  // Any OpenAI-compatible vision endpoint wins, because this is the cheap
  // option: describing a screenshot is not work worth paying frontier prices
  // for, and Qwen-VL or GLM-4V do it for a fraction of Claude. Anthropic is the
  // fallback for anyone who already has a key and would rather not add another.
  if (process.env.FREN_VISION_API_KEY) {
    try {
      return createOpenAIVisionProvider();
    } catch (err) {
      console.warn(`[gateway] configured vision provider unavailable (${err.message})`);
    }
  }
  if (!hasAnthropicCredentials()) return null;
  try {
    return createAnthropicProvider();
  } catch (err) {
    console.warn(`[gateway] vision unavailable (${err.message})`);
    return null;
  }
}

/** Text-to-speech is optional; without a key fren simply stays quiet. */
function pickVoice() {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  try {
    return createElevenLabsProvider();
  } catch (err) {
    console.warn(`[gateway] voice unavailable (${err.message})`);
    return null;
  }
}

/**
 * Pick the LLM behind the gateway. FREN_LLM_PROVIDER forces a choice;
 * otherwise whichever key is present wins, DeepSeek first. Anything that
 * fails to construct degrades to the offline mock rather than taking the
 * app down — fren stays usable without a model.
 */
function pickProvider() {
  const forced = (process.env.FREN_LLM_PROVIDER || '').toLowerCase();
  const attempt = (make, label) => {
    try {
      return make();
    } catch (err) {
      console.warn(`[gateway] ${label} unavailable (${err.message}); falling back to mock`);
      return null;
    }
  };

  if (forced === 'mock') return createMockProvider();
  if (forced === 'deepseek') return attempt(createDeepSeekProvider, 'deepseek') || createMockProvider();
  if (forced === 'anthropic') return attempt(createAnthropicProvider, 'anthropic') || createMockProvider();

  if (process.env.DEEPSEEK_API_KEY) {
    const p = attempt(createDeepSeekProvider, 'deepseek');
    if (p) return p;
  }
  if (hasAnthropicCredentials()) {
    const p = attempt(createAnthropicProvider, 'anthropic');
    if (p) return p;
  }
  console.warn(
    '[gateway] no model credentials found (set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY in .env); using mock provider'
  );
  return createMockProvider();
}

if (require.main === module) {
  loadEnv();
  const provider = pickProvider();
  const voice = pickVoice();
  const vision = pickVision();
  const server = createServer(provider, voice, vision);
  server.listen(config.GATEWAY_PORT, '127.0.0.1', () => {
    console.log(
      `[gateway] listening on http://127.0.0.1:${config.GATEWAY_PORT} ` +
        `(provider=${provider.name}, model=${provider.model}, ` +
        `voice=${voice ? voice.name : 'none'}, vision=${vision ? vision.name : 'none'})`
    );
  });
}

module.exports = { createServer };
