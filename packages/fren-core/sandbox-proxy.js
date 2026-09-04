'use strict';
/**
 * The sandbox proxy: the one door out of the secure execution environment.
 *
 * It carries two kinds of traffic, both authenticated, and it is the single
 * place either kind is allowed to leave:
 *
 *  - The MODEL lane (`/anthropic/…`). An agent is given a base URL that points
 *    here and a token that is not a key. This checks the token, swaps it for
 *    the real provider credential, and forwards the call — bodies streamed
 *    through untouched, never logged. Provider keys stay in this process.
 *
 *  - The EGRESS lane (HTTP `CONNECT`, and absolute-URI plain HTTP). Everything
 *    else the agent reaches — a web page it fetches, an API it calls — comes
 *    through here as a forward proxy. Each session presents a per-session
 *    credential; the proxy looks up that session's allowlist and lets the
 *    connection through only to a host the session may reach. Deny by default:
 *    a session with no registered policy, or one whose policy forbids the host,
 *    gets nothing. TLS is never terminated — the filter is the CONNECT
 *    authority (host:port), which is host-granular and enough.
 *
 * The seatbelt profile (the process tier) or the egress network (the container
 * tier) makes this proxy the ONLY reachable address, so a client that ignores
 * the proxy cannot leave at all. This process both runs the proxy and holds the
 * automations that declare the domains, so the allowlist is set in-process with
 * no new IPC.
 */
const MAX_JSON_BODY = 32 * 1024 * 1024;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
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

/**
 * The credential a session presents on the egress lane, derived from the one
 * host secret and the session id. The runner is handed this as the password in
 * its HTTP(S)_PROXY url (`http://s.<sessionId>:<token>@host:port`); the proxy
 * recomputes it to authenticate the CONNECT and recover the session id — so no
 * new secret and no new channel is introduced. Exported: the gateway provider
 * that sets the runner's proxy env computes the exact same value.
 */
function sessionProxyToken(baseToken, sessionId) {
  return crypto.createHmac('sha256', String(baseToken)).update(`egress:${sessionId}`).digest('hex').slice(0, 32);
}

/** A host as a bare, comparable name: lower-case, no brackets, no trailing dot. */
function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Does `host` fall under `domain` — the domain itself or any subdomain of it. */
function hostUnderDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  return h === d || h.endsWith(`.${d}`);
}

/** How long a held CONNECT waits for a person to answer before it gives up. */
const ASK_HOLD_MS = 90 * 1000;

function createSandboxProxy({ upstream, token = crypto.randomBytes(16).toString('hex'), log = () => {}, requestImpl = null, askEgress = null }) {
  const prefix = '/anthropic';
  let askEgressFn = askEgress;
  // The FREN tools lane (/mcp): a handler that runs a named tool for the agent
  // and a manifest describing them. Injected by Core, which gates each tool.
  let toolHandler = null;
  let toolManifestFn = () => [];
  // sessionId -> { mode: 'open' | 'list' | 'off', hosts: string[] }
  //   open — forward anywhere (an interactive session, the person present)
  //   list — only hosts under these domains (an automation, confined)
  //   off  — nothing (a session that must not reach out at all)
  // A session with no entry is denied: fail closed until a policy is set.
  const sessionAllow = new Map();
  // The install-wide policy every authenticated session falls back to when it
  // has no per-session entry. FREN Core sets this to the union of the domains
  // its enabled automations declare, so the environment reaches only those and
  // the model host — nothing else. Null means deny (an install with no
  // automation that declares a domain reaches nothing but the model).
  let defaultAllow = null;
  // Hosts a person allowed on the spot for one session (an "allow once" answer
  // to an ask-card). Additive over the policy, and gone when the session clears.
  const sessionGrantedHosts = new Map(); // sessionId -> Set<host/domain>

  /** Recover the session id from a CONNECT/forward request's proxy credential, or null. */
  function egressSession(req) {
    const header = req.headers['proxy-authorization'] || '';
    const m = /^Basic\s+(.+)$/i.exec(header);
    if (!m) return null;
    let user = '';
    let pass = '';
    try {
      const decoded = Buffer.from(m[1].trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      user = i >= 0 ? decoded.slice(0, i) : decoded;
      pass = i >= 0 ? decoded.slice(i + 1) : '';
    } catch {
      return null;
    }
    if (!user.startsWith('s.')) return null;
    const sessionId = user.slice(2);
    const expected = sessionProxyToken(token, sessionId);
    // Constant-time compare; lengths are fixed so a mismatch here is a forgery.
    const a = Buffer.from(pass);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return sessionId;
  }

  /** May this session reach this host? Deny-by-default; the model host is not decided here. */
  function egressAllowed(sessionId, host) {
    const granted = sessionGrantedHosts.get(sessionId);
    if (granted) { for (const d of granted) if (hostUnderDomain(host, d)) return true; }
    const policy = sessionAllow.get(sessionId) || defaultAllow;
    if (!policy) return false;
    if (policy.mode === 'open') return true;
    if (policy.mode === 'off') return false;
    return policy.hosts.some((d) => hostUnderDomain(host, d));
  }

  /**
   * A host was refused. Ask the person (if Core wired an asker), holding the
   * connection meanwhile, and resolve to whether it may now proceed. The wait
   * is bounded and abandoned if the client hangs up first; a "yes" that lands
   * after that still records the grant, so the agent's retry gets through.
   */
  function holdAndAsk(sessionId, host, clientSocket) {
    if (!askEgressFn) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (done) return; done = true; clearTimeout(timer); clientSocket.removeListener('close', onGone); clientSocket.removeListener('error', onGone); resolve(v); };
      const onGone = () => settle(false);
      const timer = setTimeout(() => settle(false), ASK_HOLD_MS);
      clientSocket.on('close', onGone);
      clientSocket.on('error', onGone);
      Promise.resolve(askEgressFn(sessionId, host)).then((ok) => settle(!!ok)).catch(() => settle(false));
    });
  }

  /** Coerce a policy input into {mode, hosts}; null clears (deny). */
  function toPolicy(spec) {
    if (spec == null) return null;
    const s = Array.isArray(spec) ? { mode: 'list', hosts: spec } : spec;
    const mode = s.mode === 'open' || s.mode === 'off' ? s.mode : 'list';
    const hosts = (s.hosts || []).map(normalizeHost).filter(Boolean);
    return { mode: mode === 'list' && hosts.length === 0 ? 'off' : mode, hosts };
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    // Forward-proxy lane for plain HTTP: an absolute-URI request (the shape a
    // client sends to a proxy). HTTPS arrives as CONNECT, handled separately.
    if (/^https?:\/\//i.test(url)) return handleForward(req, res);
    // The FREN tools lane: the agent's MCP client talks to it here, direct
    // (loopback, NO_PROXY-exempt), on the same port and install token.
    if (url === '/mcp' || url.startsWith('/mcp?') || url.startsWith('/mcp/')) return handleTools(req, res);
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

  /**
   * The FREN tools lane: a minimal MCP (Streamable-HTTP, JSON-RPC 2.0) server.
   * The agent's MCP client connects here; the install token authenticates it,
   * and each tools/call is handed to Core, which gates it before acting. Bodies
   * are never logged, like the other lanes.
   */
  function handleTools(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      return res.end(JSON.stringify({ error: 'method not allowed' }));
    }
    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-api-key'] || '');
    if (!presented || presented !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_JSON_BODY) chunks.push(c); });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      }
      const send = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
      // A notification (no id) — nothing to answer.
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        return res.end();
      }
      try {
        if (msg.method === 'initialize') {
          const wanted = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
          return reply({ protocolVersion: wanted, capabilities: { tools: {} }, serverInfo: { name: 'fren', version: '1.0.0' } });
        }
        if (msg.method === 'tools/list') {
          return reply({ tools: toolManifestFn() });
        }
        if (msg.method === 'tools/call') {
          const params = msg.params || {};
          if (!toolHandler) return reply({ content: [{ type: 'text', text: 'tools are not available' }], isError: true });
          const out = await toolHandler(String(params.name || ''), params.arguments || {});
          return reply({ content: [{ type: 'text', text: String((out && out.text) || '') }], isError: !!(out && out.isError) });
        }
        if (msg.method === 'ping') return reply({});
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      } catch (err) {
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } });
      }
    });
  }

  /** Plain-HTTP forward proxy: authenticate the session, check the host, relay. */
  function handleForward(req, res) {
    const sessionId = egressSession(req);
    if (!sessionId) {
      res.writeHead(407, { 'content-type': 'application/json', 'proxy-authenticate': 'Basic realm="fren-egress"' });
      return res.end(JSON.stringify({ error: 'proxy authentication required' }));
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad request' }));
    }
    if (!egressAllowed(sessionId, target.hostname)) {
      log(`[sandbox] egress DENY ${sessionId} http ${target.hostname}`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `egress to ${target.hostname} is not allowed for this automation` }));
    }
    log(`[sandbox] egress allow ${sessionId} http ${target.hostname}`);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers.connection;
    headers.host = target.host;
    const out = http.request({
      hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers,
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(out);
    req.on('aborted', () => out.destroy());
  }

  // HTTPS (and any tunnelled protocol): authenticate, check the host, splice raw.
  server.on('connect', async (req, clientSocket, head) => {
    const sessionId = egressSession(req);
    if (!sessionId) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fren-egress"\r\n\r\n');
      return clientSocket.destroy();
    }
    const [rawHost, rawPort] = String(req.url || '').split(':');
    const host = normalizeHost(rawHost);
    const port = Number(rawPort) || 443;
    let allowed = !!host && egressAllowed(sessionId, host);
    if (!allowed && host) {
      // Not on the list — hold the line and ask the person before refusing.
      allowed = await holdAndAsk(sessionId, host, clientSocket);
    }
    if (clientSocket.destroyed) return;
    if (!allowed) {
      log(`[sandbox] egress DENY ${sessionId} connect ${host}:${port}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return clientSocket.destroy();
    }
    log(`[sandbox] egress allow ${sessionId} connect ${host}:${port}`);
    const upstreamSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
    clientSocket.on('close', () => upstreamSocket.destroy());
  });

  return {
    server,
    token,
    upstream,
    /** Recomputes the per-session egress credential; exported for the env that sets it. */
    sessionToken(sessionId) {
      return sessionProxyToken(token, sessionId);
    },
    /**
     * Set a session's egress policy. `spec` is {mode, hosts}: 'open' forwards
     * anywhere, 'list' allows only hosts under `hosts` (domains), 'off' denies
     * all. A plain array is shorthand for {mode:'list', hosts}. Null/undefined
     * clears the policy back to deny-by-default.
     */
    setSessionAllow(sessionId, spec) {
      const policy = toPolicy(spec);
      if (!policy) { sessionAllow.delete(sessionId); return; }
      sessionAllow.set(sessionId, policy);
    },
    clearSession(sessionId) {
      sessionAllow.delete(sessionId);
      sessionGrantedHosts.delete(sessionId);
    },
    /** Wire (or replace) the asker Core answers refused hosts with. */
    setAskEgress(fn) {
      askEgressFn = fn;
    },
    /** Wire the FREN tools lane: a runner of a named tool and a manifest of them. */
    setToolHandler(handler, manifest) {
      toolHandler = handler || null;
      if (typeof manifest === 'function') toolManifestFn = manifest;
    },
    /** Record an "allow once" answer: this session may now reach this host. */
    grantSessionHost(sessionId, host) {
      const h = normalizeHost(host);
      if (!h) return;
      if (!sessionGrantedHosts.has(sessionId)) sessionGrantedHosts.set(sessionId, new Set());
      sessionGrantedHosts.get(sessionId).add(h);
    },
    /** The fallback policy for every authenticated session without its own. */
    setDefaultAllow(spec) {
      defaultAllow = toPolicy(spec);
    },
    defaultAllowFor() {
      return defaultAllow ? { mode: defaultAllow.mode, hosts: [...defaultAllow.hosts] } : null;
    },
    /** The policy a session carries right now (for tests and status), or null. */
    sessionAllowFor(sessionId) {
      const p = sessionAllow.get(sessionId);
      return p ? { mode: p.mode, hosts: [...p.hosts] } : null;
    },
    listen(port = DEFAULT_PORT, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { createSandboxProxy, chooseUpstream, sessionProxyToken, normalizeHost, hostUnderDomain, DEFAULT_PORT };
