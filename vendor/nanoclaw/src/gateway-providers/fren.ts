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

/** What one container gets. Exported for its test. */
export function frenContribution(env: NodeJS.ProcessEnv = process.env): { env: Record<string, string> } {
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
    },
  };
}

registerGatewayProvider(FREN_GATEWAY_KIND, () => ({
  kind: FREN_GATEWAY_KIND,
  async contribute({ key }) {
    required('FREN_SANDBOX_URL');
    required('FREN_SANDBOX_TOKEN');
    const contribution = frenContribution();
    log.info('FREN gateway applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId });
    return contribution;
  },
}));
