/**
 * FREN — the gateway provider for a NanoClaw host that FREN Core runs.
 *
 * FREN overlay file (see docs/runtime-architecture.md in the FREN repo, §14).
 * Upstream never has this file; it is registered by one line in installed.ts.
 *
 * The contribution is the sanctioned pattern this seam was built for: the
 * agent gets a base URL and a placeholder-shaped token, and a proxy on the
 * host — FREN Core's sandbox proxy — swaps the token for the real credential
 * on the wire. No key enters the container, and `validateSpec` keeps it that
 * way: a value that looks like a credential is refused at spawn.
 *
 * Both values arrive from FREN Core in the host process environment when it
 * spawns this host. A host started without them refuses to spawn, loudly,
 * rather than launching an agent with nowhere to send its model calls.
 */
import { createHmac } from 'node:crypto';

import { log } from '../log.js';

import { registerGatewayProvider } from './gateway-provider-registry.js';

export const FREN_GATEWAY_KIND = 'fren';

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`FREN gateway provider: ${name} is not set — refusing to spawn a container without a model proxy`);
  }
  return value;
}

/**
 * The egress-proxy env for a session: routes the agent's OWN network calls (a
 * page it fetches, an API it hits) through FREN's sandbox proxy, which lets
 * each through only to a host the session's automation may reach. The password
 * is a per-session credential the proxy recomputes — the exact value of
 * sandbox-proxy.js's sessionProxyToken(FREN_SANDBOX_TOKEN, sessionId). NO_PROXY
 * exempts the proxy's own host so the model call (ANTHROPIC_BASE_URL) stays a
 * direct call to the /anthropic lane and is not tunnelled back into the proxy.
 */
function egressProxyEnv(baseUrl: string, token: string, sessionId: string): Record<string, string> {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    return {};
  }
  const cred = createHmac('sha256', token).update(`egress:${sessionId}`).digest('hex').slice(0, 32);
  const proxy = `${origin.protocol}//s.${sessionId}:${cred}@${origin.host}`;
  const noProxy = '127.0.0.1,localhost,host.docker.internal';
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy };
}

/** What one container gets. Exported for its test. */
export function frenContribution(env: NodeJS.ProcessEnv = process.env, sessionId?: string): { env: Record<string, string> } {
  const baseUrl = (env.FREN_SANDBOX_URL ?? '').trim();
  const token = (env.FREN_SANDBOX_TOKEN ?? '').trim();
  if (!baseUrl) throw new Error('FREN gateway provider: FREN_SANDBOX_URL is not set — refusing to spawn a container without a model proxy');
  if (!token) throw new Error('FREN gateway provider: FREN_SANDBOX_TOKEN is not set — refusing to spawn a container without a model proxy');
  return {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      // A bearer the proxy recognises. Never a provider key: the spec
      // validator refuses credential-shaped values, and so does this design.
      ANTHROPIC_AUTH_TOKEN: token,
      ...(sessionId ? egressProxyEnv(baseUrl, token, sessionId) : {}),
    },
  };
}

registerGatewayProvider(FREN_GATEWAY_KIND, () => ({
  kind: FREN_GATEWAY_KIND,
  async contribute({ key }) {
    required('FREN_SANDBOX_URL');
    required('FREN_SANDBOX_TOKEN');
    const contribution = frenContribution(process.env, key.sessionId);
    log.info('FREN gateway applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId });
    return contribution;
  },
}));
