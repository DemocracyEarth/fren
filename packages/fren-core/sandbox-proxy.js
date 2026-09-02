'use strict';
/**
 * The sandbox credential proxy: the only way a model call leaves the secure
 * execution environment.
 *
 * An agent inside the environment is given a base URL that points here and
 * a token that is not a key. This proxy checks the token, swaps it for the
 * real provider credential, and forwards the request — request and response
 * bodies streamed through untouched, never logged. Provider keys stay in
 * this process, which already holds them for the fast lane.
 *
 * Upstream is Anthropic's API, or any endpoint that speaks the same protocol
 * (DeepSeek publishes one at /anthropic). Which one is chosen once, at
 * start, from what keys exist; the environment's group is told the matching
 * model name, and when the upstream serves one model the proxy enforces it:
 * an agent harness that asks for a model by its own default name still gets
 * an answer instead of a 404.
 */
const MAX_JSON_BODY = 32 * 1024 * 1024;
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const DEFAULT_PORT = 4527;
const ANTHROPIC = 'https://api.anthropic.com';
const DEEPSEEK_ANTHROPIC = 'https://api.deepseek.com/anthropic';

/** Decide the upstream from the environment. Exported for its test. */
function chooseUpstream(env = process.env) {
  const forced = (env.FREN_SANDBOX_UPSTREAM || '').toLowerCase();
  const anthropicKey = env.ANTHROPIC_API_KEY || '';
  const anthropicToken = env.ANTHROPIC_AUTH_TOKEN || '';
  const deepseekKey = env.DEEPSEEK_API_KEY || '';
  const pick = forced || (anthropicKey || anthropicToken ? 'anthropic' : deepseekKey ? 'deepseek' : 'none');
  if (pick === 'anthropic' && (anthropicKey || anthropicToken)) {
    return {
      kind: 'anthropic', baseUrl: env.FREN_SANDBOX_ANTHROPIC_URL || ANTHROPIC, model: env.FREN_SANDBOX_MODEL || null,
      headers: anthropicKey ? { 'x-api-key': anthropicKey } : { authorization: `Bearer ${anthropicToken}` },
    };
  }
  if (pick === 'deepseek' && deepseekKey) {
    return {
      kind: 'deepseek', baseUrl: env.FREN_SANDBOX_DEEPSEEK_URL || DEEPSEEK_ANTHROPIC, model: env.FREN_SANDBOX_MODEL || 'deepseek-chat',
      headers: { 'x-api-key': deepseekKey },
    };
  }
  return { kind: 'none', baseUrl: null, model: null, headers: {} };
}

function createSandboxProxy({ upstream, token = crypto.randomBytes(16).toString('hex'), log = () => {}, requestImpl = null }) {
  const prefix = '/anthropic';
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (!url.startsWith(prefix + '/') && url !== prefix) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-api-key'] || '');
    if (!presented || presented !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (!upstream || upstream.kind === 'none' || !upstream.baseUrl) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no model credential is configured for the secure execution environment' }));
    }
    const target = new URL(upstream.baseUrl.replace(/\/$/, '') + url.slice(prefix.length));
    const headers = { ...req.headers, host: target.host, ...upstream.headers };
    delete headers.authorization;
    delete headers['x-api-key'];
    Object.assign(headers, upstream.headers);
    delete headers.connection;
    const agent = target.protocol === 'https:' ? https : http;
    const doRequest = requestImpl || agent.request.bind(agent);
    const started = Date.now();
    const forward = (body) => {
      if (body !== null) headers['content-length'] = String(Buffer.byteLength(body));
      const out = doRequest({
        protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
        path: target.pathname + target.search, method: req.method, headers,
      }, (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        up.on('end', () => log(`[sandbox] ${req.method} ${target.pathname} ${up.statusCode} ${Date.now() - started}ms`));
      });
      out.on('error', (err) => {
        log(`[sandbox] upstream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'the model provider could not be reached' }));
        } else {
          res.destroy();
        }
      });
      if (body !== null) out.end(body);
      else req.pipe(out);
      req.on('aborted', () => out.destroy());
    };
    // An upstream that serves one model gets that model, whatever was asked.
    const isJson = /json/i.test(String(req.headers['content-type'] || ''));
    if (upstream.model && isJson && (req.method === 'POST' || req.method === 'PUT')) {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= MAX_JSON_BODY) chunks.push(c); });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && parsed.model !== upstream.model) {
            parsed.model = upstream.model;
            body = JSON.stringify(parsed);
          }
        } catch { /* not JSON after all: forward as is */ }
        forward(body);
      });
      return;
    }
    forward(null);
  });

  return {
    server,
    token,
    upstream,
    listen(port = DEFAULT_PORT, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createSandboxProxy, chooseUpstream, DEFAULT_PORT };
