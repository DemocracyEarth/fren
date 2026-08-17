// Local LLM gateway — a small HTTP server, the ONLY component that talks to
// the Anthropic API. The desktop app calls it over loopback with a bearer token.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config, loadEnv } = require('../../packages/shared');
const intelligence = require('../../packages/intelligence');
const { createAnthropicProvider } = require('./providers/anthropic');
const { createMockProvider } = require('./providers/mock');

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

async function handleChat(provider, body, res) {
  const question = body && body.question;
  if (typeof question !== 'string' || question.trim() === '') {
    return send(res, 400, { error: 'question must be a non-empty string' });
  }
  const request = intelligence.buildChatRequest({
    question,
    memories: Array.isArray(body.memories) ? body.memories : [],
    observations: Array.isArray(body.observations) ? body.observations : [],
  });
  const reply = await callProvider(provider, request, res);
  if (reply === null) return;
  send(res, 200, { reply });
}

async function handle(provider, req, res, pathname) {
  if (req.method === 'GET' && pathname === '/health') {
    return send(res, 200, { ok: true, provider: provider.name, model: config.MODEL });
  }

  if (req.method === 'POST' && (pathname === '/v1/summarize' || pathname === '/v1/chat')) {
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
    return handleChat(provider, body, res);
  }

  send(res, 404, { error: 'not found' });
}

function createServer(provider) {
  return http.createServer((req, res) => {
    const started = Date.now();
    const pathname = (req.url || '/').split('?')[0];
    res.on('finish', () => {
      // PRIVACY: method, path, status, duration only. Never log bodies.
      console.log(`[gateway] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    handle(provider, req, res, pathname).catch((err) => {
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

function pickProvider() {
  const forced = (process.env.FREN_LLM_PROVIDER || '').toLowerCase();
  if (forced === 'mock') return createMockProvider();
  if (forced !== 'anthropic' && !hasAnthropicCredentials()) {
    console.warn(
      '[gateway] no Anthropic credentials found (set ANTHROPIC_API_KEY in .env); using mock provider'
    );
    return createMockProvider();
  }
  try {
    return createAnthropicProvider();
  } catch (err) {
    console.warn(`[gateway] anthropic provider unavailable (${err.message}); falling back to mock`);
    return createMockProvider();
  }
}

if (require.main === module) {
  loadEnv();
  const provider = pickProvider();
  const server = createServer(provider);
  server.listen(config.GATEWAY_PORT, '127.0.0.1', () => {
    console.log(
      `[gateway] listening on http://127.0.0.1:${config.GATEWAY_PORT} (provider=${provider.name}, model=${config.MODEL})`
    );
  });
}

module.exports = { createServer };
