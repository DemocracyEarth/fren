// Local LLM gateway — a small HTTP server, the ONLY component that talks to a
// model provider. The desktop app calls it over loopback with a bearer token
// and never learns which provider or model answered.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config, loadEnv } = require('../../packages/shared');
const { forSpeech } = require('../../packages/shared/speech');
const intelligence = require('../../packages/intelligence');
const { createAnthropicProvider } = require('./providers/anthropic');
const { createOpenAIVisionProvider } = require('./providers/openai-vision');
const { createDeepSeekProvider } = require('./providers/deepseek');
const { createMockProvider } = require('./providers/mock');
const { createElevenLabsProvider } = require('./providers/elevenlabs');
const { createCore } = require('../../packages/fren-core');
const { openCoreStore } = require('../../packages/fren-core/store');
const { createMockRuntime } = require('../../packages/runtime-mock');
const { createSandboxProxy, chooseUpstream, DEFAULT_PORT: SANDBOX_PORT } = require('../../packages/fren-core/sandbox-proxy');

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

/**
 * A model or voice id the caller chose, or nothing.
 *
 * These reach a URL path (ElevenLabs) and a JSON body (everyone else), so the
 * shape is checked rather than trusted. Anything that does not look like an id
 * is dropped and the configured default is used — a bad preference should
 * degrade to the default, never to an error and never to a request somewhere
 * unintended.
 *
 * Note what is deliberately NOT accepted here: base URLs and API keys. The
 * base URL is where the key is sent, so a caller-supplied destination for a
 * credential is an exfiltration primitive, not a setting. Keys live in .env and
 * nowhere else.
 */
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
function safeId(v) {
  return typeof v === 'string' && ID.test(v) ? v : undefined;
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

/** Draft an automation. fren writes it down; the user decides what to run. */
async function handleAutomate(provider, body, res) {
  const { pattern, message } = body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return send(res, 400, { error: 'message must be a non-empty string' });
  }
  const request = intelligence.buildAutomationRequest({
    pattern: String(pattern || ''),
    message,
    memories: Array.isArray(body.memories) ? body.memories : [],
    platform: String(body.platform || 'macOS'),
  });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  try {
    const p = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    send(res, 200, {
      feasible: !!p.feasible,
      approach: String(p.approach || ''),
      steps: Array.isArray(p.steps) ? p.steps.map(String).slice(0, 12) : [],
      script: String(p.script || ''),
      language: String(p.language || ''),
      caveats: String(p.caveats || ''),
    });
  } catch {
    // An unusable draft is not a draft. Saying so beats showing nonsense the
    // user might run.
    send(res, 200, {
      feasible: false, approach: '', steps: [], script: '', language: '',
      caveats: 'I could not put together a usable draft for this one.',
    });
  }
}

/** Is this a request for a repeating routine, and if so, what? */
async function handleRoutine(provider, body, res) {
  const text = body && body.text;
  if (typeof text !== 'string' || !text.trim()) {
    return send(res, 400, { error: 'text must be a non-empty string' });
  }
  const request = intelligence.buildRoutineRequest({ text });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  try {
    const p = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    const days = Array.isArray(p.days)
      ? [...new Set(p.days.map(Number).filter((n) => n >= 0 && n <= 6))].sort()
      : [];
    send(res, 200, {
      isRoutine: !!p.isRoutine,
      name: String(p.name || '').slice(0, 60),
      prompt: String(p.prompt || '').slice(0, 400),
      hour: Math.min(23, Math.max(0, Number(p.hour) || 0)),
      minute: Math.min(59, Math.max(0, Number(p.minute) || 0)),
      days,
      reason: String(p.reason || ''),
    });
  } catch {
    // Unreadable means "not a routine". Silence is the safe direction.
    send(res, 200, { isRoutine: false, name: '', prompt: '', hour: 0, minute: 0, days: [], reason: '' });
  }
}

/**
 * Hello.
 *
 * Free-text, not JSON: a greeting has no fields, and asking for a schema here
 * only teaches the model to sound like a form. The length cap is enforced on
 * this side because "one sentence" is a request, not a guarantee.
 */
async function handleGreet(provider, body, res) {
  // Every other endpoint degrades acceptably to the canned mock string. A hello
  // that says "no LLM is configured, so this is a canned reply" is worse than
  // no hello at all, and mock mode is what you get with no keys set.
  if (provider.name === 'mock') return send(res, 200, { text: '' });
  const request = intelligence.buildGreetingRequest({
    profile: body.profile && typeof body.profile === 'object' ? body.profile : null,
    lastSeenMs: Number(body.lastSeenMs) || null,
    lastActivity: typeof body.lastActivity === 'string' ? body.lastActivity : '',
    facts: typeof body.facts === 'string' ? body.facts : '',
    avoid: Array.isArray(body.avoid) ? body.avoid.map(String).slice(-4) : [],
    automations: Array.isArray(body.automations) ? body.automations.map(String).slice(0, 8) : [],
    routines: Array.isArray(body.routines) ? body.routines.map(String).slice(0, 6) : [],
  });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  const text = String(raw || '')
    .replace(/^["']|["']$/g, '')     // models like to quote a line they were told to say
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
  send(res, 200, { text });
}

/**
 * Is there anything here worth being curious about?
 *
 * Answering "no" is the common case and the correct default, so every failure
 * mode below resolves to silence rather than to a question. A companion that
 * asks something dull has spent credibility it does not get back.
 */
async function handleSuggest(provider, body, res) {
  const quiet = { worth: false, message: '', about: '' };
  const request = intelligence.buildSuggestRequest({
    moment: typeof body.moment === 'string' ? body.moment.slice(0, 40) : 'check-in',
    memories: Array.isArray(body.memories) ? body.memories : [],
    observations: Array.isArray(body.observations) ? body.observations : [],
    browser: body.browser && typeof body.browser === 'object' ? body.browser : null,
    awayMinutes: Number(body.awayMinutes) || 0,
    reading: body.reading && typeof body.reading === 'object' ? body.reading : null,
    profile: body.profile && typeof body.profile === 'object' ? body.profile : null,
    soul: typeof body.soul === 'string' ? body.soul : '',
  });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  try {
    const p = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    const message = String(p.message || '').trim();
    send(res, 200, {
      worth: !!p.worth && message.length > 0,
      message: message.slice(0, 400),
      about: String(p.about || '').slice(0, 80),
    });
  } catch {
    // Staying quiet is always recoverable; a garbled interruption is not.
    send(res, 200, quiet);
  }
}

async function handleCuriosity(provider, body, res) {
  const quiet = { ask: false, question: '', about: '', why: '' };
  const request = intelligence.buildCuriosityRequest({
    memories: Array.isArray(body.memories) ? body.memories : [],
    profile: body.profile && typeof body.profile === 'object' ? body.profile : null,
    soul: typeof body.soul === 'string' ? body.soul : '',
    asked: Array.isArray(body.asked) ? body.asked.map(String).slice(0, 40) : [],
  });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  try {
    const p = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    const question = String(p.question || '').trim();
    send(res, 200, {
      ask: !!p.ask && question.length > 0,
      question: question.slice(0, 240),
      about: String(p.about || '').slice(0, 80),
      why: String(p.why || '').slice(0, 200),
    });
  } catch {
    send(res, 200, quiet);
  }
}

/** Did the answer contain anything worth keeping? Usually not. */
async function handleLearn(provider, body, res) {
  const { question, answer } = body || {};
  if (typeof answer !== 'string' || !answer.trim()) {
    return send(res, 400, { error: 'answer must be a non-empty string' });
  }
  const request = intelligence.buildLearnRequest({
    question: String(question || '').slice(0, 300),
    answer: answer.slice(0, 1000),
  });
  const raw = await callProvider(provider, request, res);
  if (raw === null) return;
  try {
    const p = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    const fact = String(p.fact || '').trim();
    send(res, 200, { worthKeeping: !!p.worthKeeping && fact.length > 0, fact: fact.slice(0, 200) });
  } catch {
    // Remembering nothing is recoverable; remembering nonsense is not, because
    // it goes in a file the user reads and then colours every later reply.
    send(res, 200, { worthKeeping: false, fact: '' });
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
    // What is on screen in the user's browser, from the browser sensor.
    browser: body.browser && typeof body.browser === 'object' ? body.browser : null,
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
  // Written for a screen, read by a voice: marks, emoji and quotes go, pauses stay.
  const spoken = forSpeech(text) || text.trim();
  try {
    const { audio, contentType } = await voice.speak(spoken.slice(0, 2000), {
      voice: safeId(body.voice),
      model: safeId(body.voiceModel),
    });
    res.writeHead(200, { 'content-type': contentType, 'content-length': audio.length });
    res.end(audio);
  } catch (err) {
    send(res, 502, { error: (err && err.message) || 'voice error' });
  }
}

async function handle(provider, voice, vision, core, req, res, pathname) {
  if (req.method === 'GET' && pathname === '/health') {
    return send(res, 200, {
      ok: true,
      provider: provider.name,
      model: provider.model,
      voice: voice ? voice.name : null,
      // What is actually in effect right now, so the settings UI can show the
      // defaults it is overriding instead of guessing at them.
      voiceId: voice ? voice.voice : null,
      voiceModel: voice ? voice.model : null,
      // The desktop app needs this to know whether the screen-looking toggle
      // can be offered at all.
      vision: vision ? vision.name : null,
      // The secure execution environment, if one is wired: its state, and a
      // kind for the About box. Never a product name in the state itself.
      runtime: core ? core.runtimeStatus() : null,
      runtimeKind: core ? core.runtimeKind() : null,
    });
  }

  // Core routes: runs, sessions, automations, permissions, events. Same bearer
  // token, JSON bodies only where a method carries one, then Core's router.
  if (core && core.owns(pathname)) {
    if (req.headers.authorization !== `Bearer ${config.GATEWAY_TOKEN}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    let body = null;
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
    if (hasBody && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT')) {
      try {
        body = await readJson(req);
      } catch (err) {
        return send(res, err.status || 400, { error: err.message });
      }
    }
    const query = Object.fromEntries(new URL(req.url || '/', 'http://127.0.0.1').searchParams);
    return core.handle(req, res, pathname, body, query);
  }

  if (req.method === 'POST' && (pathname === '/v1/summarize' || pathname === '/v1/chat' ||
                                pathname === '/v1/speak' || pathname === '/v1/extract' ||
                                pathname === '/v1/pattern' || pathname === '/v1/vision' ||
                                pathname === '/v1/automate' || pathname === '/v1/routine' ||
                                pathname === '/v1/curious' || pathname === '/v1/learn' ||
                                pathname === '/v1/suggest' ||
                                pathname === '/v1/greet')) {
    if (req.headers.authorization !== `Bearer ${config.GATEWAY_TOKEN}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(res, err.status || 400, { error: err.message });
    }
    // One place decides what model this request runs on. Every handler builds
    // its request through intelligence.build*Request, so the override is merged
    // in here rather than threaded through nine call sites.
    const chosen = safeId(body && body.model);
    if (chosen) {
      const inner = provider;
      provider = {
        name: inner.name,
        model: chosen,
        // `r`, not `req` — the HTTP request is already named that in this scope.
        complete: (r) => inner.complete({ ...r, model: chosen }),
      };
    }

    if (pathname === '/v1/summarize') return handleSummarize(provider, body, res);
    if (pathname === '/v1/extract') return handleExtract(provider, body, res);
    if (pathname === '/v1/pattern') return handlePattern(provider, body, res);
    if (pathname === '/v1/vision') return handleVision(vision, body, res);
    if (pathname === '/v1/automate') return handleAutomate(provider, body, res);
    if (pathname === '/v1/routine') return handleRoutine(provider, body, res);
    if (pathname === '/v1/curious') return handleCuriosity(provider, body, res);
    if (pathname === '/v1/suggest') return handleSuggest(provider, body, res);
    if (pathname === '/v1/learn') return handleLearn(provider, body, res);
    if (pathname === '/v1/greet') return handleGreet(provider, body, res);
    if (pathname === '/v1/speak') return handleSpeak(voice, body, res);
    return handleChat(provider, body, res);
  }

  send(res, 404, { error: 'not found' });
}

function createServer(provider, voice = null, vision = null, { core = null } = {}) {
  return http.createServer((req, res) => {
    const started = Date.now();
    const pathname = (req.url || '/').split('?')[0];
    res.on('finish', () => {
      // PRIVACY: method, path, status, duration only. Never log bodies.
      console.log(`[gateway] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    handle(provider, voice, vision, core, req, res, pathname).catch((err) => {
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
  const core = buildCore(provider);
  const server = createServer(provider, voice, vision, { core });
  server.listen(config.GATEWAY_PORT, '127.0.0.1', () => {
    console.log(
      `[gateway] listening on http://127.0.0.1:${config.GATEWAY_PORT} ` +
        `(provider=${provider.name}, model=${provider.model}, ` +
        `voice=${voice ? voice.name : 'none'}, vision=${vision ? vision.name : 'none'}, ` +
        `runtime=${core.runtimeKind()})`
    );
    core.start().catch((err) => console.error(`[core] failed to start: ${err.message}`));
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    core.stop().catch(() => {}).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Which secure execution environment runs agents.
 *
 * FREN_RUNTIME picks: `nanoclaw` (the vendored host: agents as sandboxed processes, or containers),
 * `mock` (nothing runs; for development and demos), or `auto` — the default:
 * the vendored host when it has been built (`npm run runtime:build`), else
 * the mock. Whether the container runtime itself is present is the host
 * adapter's to report, in words, through the environment's status.
 */
function pickRuntime(provider, { sandboxUrl, sandboxToken, model }) {
  const chosen = (process.env.FREN_RUNTIME || 'auto').toLowerCase();
  const runtimeDir = path.join(config.REPO_ROOT, 'vendor', 'nanoclaw');
  const built = fs.existsSync(path.join(runtimeDir, 'dist', 'index.js'));
  if (chosen === 'mock' || (chosen === 'auto' && (!built || provider.name === 'mock'))) {
    if (chosen === 'auto' && !built && provider.name !== 'mock') {
      console.warn('[core] the runtime host is not built (npm run runtime:build); agent runs use the mock runtime');
    }
    return createMockRuntime({ replyDelayMs: 600 });
  }
  const { createNanoclawRuntime } = require('../../packages/runtime-nanoclaw');
  return createNanoclawRuntime({
    dataDir: config.DATA_DIR, runtimeDir, sandboxUrl, sandboxToken, model,
    // FREN_RUNTIME_TIER: process (sandboxed process, nothing to install) | container | auto.
    tier: process.env.FREN_RUNTIME_TIER || 'auto',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, log: console.log,
  });
}

function buildCore(provider) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const store = openCoreStore(path.join(config.DATA_DIR, 'core.db'));
  // The sandbox proxy: the one door a model call has out of the environment.
  // Listening before the runtime starts, so a container never finds it absent.
  const upstream = chooseUpstream();
  const sandbox = createSandboxProxy({ upstream, log: console.log });
  const sandboxPort = Number(process.env.FREN_SANDBOX_PORT) || SANDBOX_PORT;
  sandbox.listen(sandboxPort, process.env.FREN_SANDBOX_BIND || '127.0.0.1')
    .then(() => console.log(`[sandbox] proxy on 127.0.0.1:${sandboxPort} (upstream=${upstream.kind})`))
    .catch((err) => console.error(`[sandbox] proxy could not listen: ${err.message}`));
  if (upstream.kind === 'none') console.warn('[sandbox] no model credential for the environment; agents there cannot think until one is set');
  const runtime = pickRuntime(provider, {
    sandboxUrl: process.env.FREN_SANDBOX_URL || `http://host.docker.internal:${sandboxPort}/anthropic`,
    sandboxToken: sandbox.token,
    model: upstream.model,
  });
  // The fast lane's model, for reading intent out of what someone said.
  // The environment's one exit is the sandbox proxy; its allowlist is the union
  // of the domains the enabled automations declare. FREN_EGRESS=open keeps the
  // old open reach for anyone who needs it; the default confines.
  const setEgressAllow = (policy) => sandbox.setDefaultAllow(
    process.env.FREN_EGRESS === 'open' ? { mode: 'open', hosts: [] } : policy,
  );
  const core = createCore({ store, runtime, complete: (request) => provider.complete(request), log: console.log, setEgressAllow });
  const stop = core.stop.bind(core);
  core.stop = async () => { await stop(); await sandbox.close(); };
  return core;
}

module.exports = { createServer };
