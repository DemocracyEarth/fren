import { describe, expect, it } from 'vitest';

import { frenContribution } from './fren.js';
import { looksLikeCredential } from '../drivers/types.js';

describe('FREN gateway provider', () => {
  it('contributes the proxy URL and a token that is not a credential', () => {
    const c = frenContribution({ FREN_SANDBOX_URL: 'http://host.docker.internal:4527/anthropic', FREN_SANDBOX_TOKEN: 'fren-0123456789abcdef0123456789abcdef' });
    expect(c.env.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:4527/anthropic');
    expect(c.env.ANTHROPIC_AUTH_TOKEN).toBe('fren-0123456789abcdef0123456789abcdef');
    expect(looksLikeCredential(c.env.ANTHROPIC_AUTH_TOKEN)).toBe(false);
  });

  it('refuses to contribute without the proxy or the token', () => {
    expect(() => frenContribution({ FREN_SANDBOX_TOKEN: 'x' })).toThrow(/FREN_SANDBOX_URL/);
    expect(() => frenContribution({ FREN_SANDBOX_URL: 'http://h' })).toThrow(/FREN_SANDBOX_TOKEN/);
  });
});
