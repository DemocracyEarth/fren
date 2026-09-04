import { describe, expect, it } from 'vitest';

import { frenContribution } from './fren.js';
import { createHmac } from 'node:crypto';

import { looksLikeCredential } from '../drivers/types.js';

describe('FREN gateway provider', () => {
  it('contributes the proxy URL and a token that is not a credential', () => {
    const c = frenContribution({ FREN_SANDBOX_URL: 'http://host.docker.internal:4527/anthropic', FREN_SANDBOX_TOKEN: 'fren-0123456789abcdef0123456789abcdef' });
    expect(c.env.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:4527/anthropic');
    expect(c.env.ANTHROPIC_AUTH_TOKEN).toBe('fren-0123456789abcdef0123456789abcdef');
    expect(looksLikeCredential(c.env.ANTHROPIC_AUTH_TOKEN)).toBe(false);
  });

  it('routes a session\'s own egress through the proxy with a per-session credential, exempting the model host', () => {
    const c = frenContribution({ FREN_SANDBOX_URL: 'http://127.0.0.1:4527/anthropic', FREN_SANDBOX_TOKEN: 'host-secret' }, 'sess-xyz');
    const cred = createHmac('sha256', 'host-secret').update('egress:sess-xyz').digest('hex').slice(0, 32);
    expect(c.env.HTTPS_PROXY).toBe(`http://s.sess-xyz:${cred}@127.0.0.1:4527`);
    expect(c.env.HTTP_PROXY).toBe(c.env.HTTPS_PROXY);
    expect(c.env.NO_PROXY).toContain('127.0.0.1');
    expect(c.env.NO_PROXY).toContain('host.docker.internal');
    // The model call still points at the /anthropic lane, not the proxy tunnel.
    expect(c.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4527/anthropic');
    // No proxy env at all when no session is named (back-compat).
    expect(frenContribution({ FREN_SANDBOX_URL: 'http://h:1/anthropic', FREN_SANDBOX_TOKEN: 't' }).env.HTTPS_PROXY).toBeUndefined();
  });

  it('refuses to contribute without the proxy or the token', () => {
    expect(() => frenContribution({ FREN_SANDBOX_TOKEN: 'x' })).toThrow(/FREN_SANDBOX_URL/);
    expect(() => frenContribution({ FREN_SANDBOX_URL: 'http://h' })).toThrow(/FREN_SANDBOX_TOKEN/);
  });
});
