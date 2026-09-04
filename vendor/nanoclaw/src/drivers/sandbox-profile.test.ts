import { describe, expect, it } from 'vitest';

import { NEVER_EXEC, renderSandboxProfile, sbPath } from './sandbox-profile.js';

const base = { runtimeDir: '/opt/fren/runtime', writableDirs: ['/data/sessions/s1', '/data/groups/fren'], tmpDir: '/data/tmp/s1', network: 'proxy' as const, proxyPort: 4527 };

describe('sandbox profile', () => {
  it('denies by default and names every allowance', () => {
    const p = renderSandboxProfile(base);
    expect(p.split('\n')[0]).toBe('(version 1)');
    expect(p.split('\n')[1]).toBe('(deny default)');
    expect(p).toContain('(allow file-write* (subpath "/data/sessions/s1") (subpath "/data/groups/fren") (subpath "/data/tmp/s1") (literal "/dev/null"))');
    expect(p).toContain('(subpath "/opt/fren/runtime")');
    expect(p).not.toMatch(/\(allow default\)/);
  });

  it("grants the network by the session's grant, and nothing else", () => {
    expect(renderSandboxProfile(base)).toContain('(allow network-outbound (remote ip "localhost:4527"))');
    expect(renderSandboxProfile(base)).not.toContain('(allow network-outbound)\n');
    const internet = renderSandboxProfile({ ...base, network: 'internet' });
    expect(internet).toContain('(allow network-outbound)\n');
    expect(internet).toContain('com.apple.trustd');
    const none = renderSandboxProfile({ ...base, network: 'none' });
    expect(none).not.toContain('network-outbound');
    expect(none).not.toContain('trustd');
    expect(() => renderSandboxProfile({ ...base, proxyPort: undefined })).toThrow(/needs a port/);
  });

  it('never lets a task reach the desktop, the keychain, or privilege, even when asked', () => {
    const p = renderSandboxProfile({ ...base, tools: ['/usr/bin/open', '/usr/bin/osascript', '/usr/bin/sudo', '/usr/local/bin/rg'] });
    for (const bad of NEVER_EXEC) expect(p).not.toContain(`(literal "${bad}")`);
    expect(p).toContain('(literal "/usr/local/bin/rg")');
    expect(p).not.toContain('"/Users/');
  });

  it('quotes paths and refuses what a path must never be', () => {
    expect(sbPath('/a/b c/"d"')).toBe('"/a/b c/\\"d\\""');
    expect(sbPath('/a\\b')).toBe('"/a\\\\b"');
    expect(() => sbPath('relative/path')).toThrow(/absolute/);
    expect(() => sbPath('/a/../b')).toThrow(/climbs/);
    expect(() => sbPath('/a\nb')).toThrow(/control/);
    // A path that tries to close the rule and open another cannot: it is a quoted string, not syntax.
    const p = renderSandboxProfile({ ...base, writableDirs: ['/data/x") (allow default) (literal "'] });
    expect(p).not.toMatch(/^\(allow default\)/m);
    expect(p).toContain('\\"');
  });

  it('grants TLS validation under the proxy grant but resolves names only under internet', () => {
    const base = { runtimeDir: '/opt/rt', writableDirs: ['/w'], tmpDir: '/t' };
    const proxy = renderSandboxProfile({ ...base, network: 'proxy', proxyPort: 4527 });
    expect(proxy).toContain('com.apple.trustd');
    expect(proxy).toContain('com.apple.SecurityServer');
    expect(proxy).not.toContain('mDNSResponder');
    expect(proxy).toContain('(remote ip "localhost:4527")');
    expect(proxy).not.toContain('(allow network-outbound)');
    const internet = renderSandboxProfile({ ...base, network: 'internet' });
    expect(internet).toContain('com.apple.trustd');
    expect(internet).toContain('mDNSResponder');
    const none = renderSandboxProfile({ ...base, network: 'none' });
    expect(none).not.toContain('com.apple.trustd');
    expect(none).not.toContain('network-outbound');
  });

});
