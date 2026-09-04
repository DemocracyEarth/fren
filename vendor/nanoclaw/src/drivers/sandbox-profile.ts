/**
 * The seatbelt profile the process driver runs the agent runner under.
 *
 * FREN overlay file. This is the whole security argument of the
 * no-container tier, so it is written as one pure function of its inputs,
 * deny-by-default, with every allowance named, and tested three ways: the
 * text it renders, the quoting of paths that reach it, and a live probe
 * that runs under the rendered profile and must fail to do the things a
 * rogue agent would try (see sandbox-confinement.test.ts).
 *
 * What the profile lets a runner do:
 *   - read the operating system, its own runtime and the session's folders
 *   - write only inside the session's folders and its own temp folder
 *   - run a small named set of tools (the runtime itself, a shell, coreutils
 *     the tasks need); nothing that opens applications, talks to the
 *     keychain, or scripts the desktop
 *   - reach the network according to the session's grant: the credential
 *     proxy only, the internet as well, or nothing at all
 * Everything else is denied: the person's home folder, other sessions, the
 * screen, the microphone, other processes' state.
 */

export type NetworkGrant = 'none' | 'proxy' | 'internet';

export interface SandboxProfileInput {
  /** The runtime's own directory (the Bun binary and the built runner). Read and exec. */
  runtimeDir: string;
  /** Folders the runner reads and writes: the session mailbox, the group workspace. */
  writableDirs: string[];
  /** Folders the runner may only read (shared skills, instructions). */
  readableDirs?: string[];
  /** The runner's temp folder. Read and write. */
  tmpDir: string;
  /** Extra executables the tasks may run, by absolute path. */
  tools?: string[];
  network: NetworkGrant;
  /** Where the credential proxy listens, for the 'proxy' grant (and always allowed under 'internet'). */
  proxyPort?: number;
}

/** Only absolute, control-free paths reach the profile; quotes and backslashes are escaped, never trusted. */
export function sbPath(p: string): string {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(`sandbox: not an absolute path: ${String(p)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) throw new Error('sandbox: a path with control characters');
  if (p.includes('/../') || p.endsWith('/..')) throw new Error('sandbox: a path that climbs');
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

const SYSTEM_READ = [
  '/usr', '/System', '/Library/Frameworks', '/Library/Apple', '/Library/Preferences/Logging',
  '/private/etc', '/private/var/db/timezone', '/private/var/db/mds', '/dev',
];
const ROOT_LITERALS = ['/', '/private', '/private/tmp', '/private/var', '/private/var/folders', '/Users', '/Applications', '/Library', '/Volumes', '/opt', '/tmp', '/var', '/etc'];
const SHELL_TOOLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/ls', '/bin/cat', '/bin/echo', '/bin/mkdir', '/bin/rm', '/bin/mv', '/bin/cp', '/bin/pwd', '/bin/date', '/bin/sleep',
  '/usr/bin/env', '/usr/bin/head', '/usr/bin/tail', '/usr/bin/grep', '/usr/bin/sed', '/usr/bin/awk', '/usr/bin/sort', '/usr/bin/uniq', '/usr/bin/wc', '/usr/bin/tr', '/usr/bin/cut',
  '/usr/bin/find', '/usr/bin/xargs', '/usr/bin/basename', '/usr/bin/dirname', '/usr/bin/tee', '/usr/bin/touch', '/usr/bin/which', '/usr/bin/file', '/usr/bin/diff', '/usr/bin/curl', '/usr/bin/git', '/usr/bin/tar', '/usr/bin/gzip', '/usr/bin/unzip', '/usr/bin/zip', '/usr/bin/jq', '/usr/bin/python3', '/usr/bin/perl'];
/** Never, whatever a task asks: these reach the desktop, other apps, the keychain, or privilege. */
export const NEVER_EXEC = ['/usr/bin/open', '/usr/bin/osascript', '/usr/bin/security', '/usr/bin/sudo', '/usr/bin/su', '/usr/bin/defaults', '/usr/bin/screencapture', '/usr/sbin/systemsetup', '/usr/bin/tccutil', '/usr/bin/launchctl', '/bin/launchctl', '/usr/bin/killall'];

const MACH_ALWAYS = ['com.apple.system.logger', 'com.apple.system.notification_center', 'com.apple.system.opendirectoryd.libinfo'];
// Cert validation: needed whenever the agent itself terminates TLS — under
// 'internet' (direct) and under 'proxy' (end-to-end TLS through the CONNECT
// tunnel; the proxy filters the host but never sees the plaintext).
const MACH_TLS = ['com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.SecurityServer'];
// Name resolution: only 'internet' resolves for itself. Under 'proxy' the
// proxy resolves (the client sends CONNECT host:port), so the agent needs none.
const MACH_DNS = ['com.apple.system.DNSServiceDiscovery', 'com.apple.mDNSResponder'];

export function renderSandboxProfile(input: SandboxProfileInput): string {
  const runtime = sbPath(input.runtimeDir);
  const writable = input.writableDirs.map(sbPath);
  const readable = (input.readableDirs ?? []).map(sbPath);
  const tmp = sbPath(input.tmpDir);
  const tools = (input.tools ?? []).filter((t) => !NEVER_EXEC.includes(t)).map(sbPath);
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    `(allow process-exec (subpath ${runtime}) ${[...SHELL_TOOLS.map(sbPath), ...tools].map((t) => `(literal ${t})`).join(' ')})`,
    `(allow file-read* ${SYSTEM_READ.map((p) => `(subpath ${sbPath(p)})`).join(' ')} ${ROOT_LITERALS.map((p) => `(literal ${sbPath(p)})`).join(' ')} (subpath ${runtime}) ${[...writable, ...readable, tmp].map((p) => `(subpath ${p})`).join(' ')})`,
    '(allow file-read-metadata)',
    `(allow file-write* ${[...writable, tmp].map((p) => `(subpath ${p})`).join(' ')} (literal "/dev/null"))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (subpath "/private/var/folders"))',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    `(allow mach-lookup ${MACH_ALWAYS.map((n) => `(global-name "${n}")`).join(' ')}${input.network === 'proxy' || input.network === 'internet' ? ' ' + MACH_TLS.map((n) => `(global-name "${n}")`).join(' ') : ''}${input.network === 'internet' ? ' ' + MACH_DNS.map((n) => `(global-name "${n}")`).join(' ') : ''})`,
  ];
  if (input.network === 'proxy') {
    if (!Number.isInteger(input.proxyPort)) throw new Error('sandbox: the proxy grant needs a port');
    lines.push(`(allow network-outbound (remote ip "localhost:${input.proxyPort}"))`);
  } else if (input.network === 'internet') {
    lines.push('(allow network-outbound)');
    lines.push('(allow system-socket)');
  }
  // 'none': no network rule at all; deny default covers it.
  return lines.join('\n') + '\n';
}
