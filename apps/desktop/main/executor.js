'use strict';
/**
 * Running a script fren wrote.
 *
 * This is the most dangerous thing in the codebase, so it is worth being exact
 * about what protects you, and in what order:
 *
 *   1. YOU READ IT. Nothing runs that has not been shown in full and approved.
 *      Approval is bound to a hash of the exact text, so editing the script
 *      voids it rather than inheriting it.
 *   2. IT RAN BY HAND FIRST. Nothing is scheduled that has not already run
 *      successfully while you watched. A schedule is a promotion, not a start.
 *   3. THE SCAN BELOW. It is the LAST line, not the first. A blocklist cannot
 *      be complete and should never be mistaken for a sandbox — it exists to
 *      catch the obviously catastrophic, so that a moment's inattention during
 *      review is not unrecoverable.
 *
 * Beyond that: no shell interpolation anywhere, a hard timeout, output capped,
 * and a reduced environment so a script does not inherit every variable this
 * process happens to be holding.
 */
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT = 8000;

/** Approval is bound to the exact text. Change a character and it is void. */
function hashScript(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Things no drafted automation has any business doing.
 *
 * Each entry says what it is protecting against, because a bare regex list
 * rots: without the reason, nobody can tell later whether a pattern is still
 * earning its place or is just in the way.
 */
const FORBIDDEN = [
  // Destroying data
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)/i, why: 'recursive or forced delete' },
  { re: /\brmdir\s+\/|\bunlink\s+\//i, why: 'deleting an absolute path' },
  { re: /\bmkfs|\bdiskutil\s+(erase|reformat)|\bdd\s+if=/i, why: 'formatting or raw disk writes' },
  { re: />\s*\/dev\/(disk|sd|nvme)/i, why: 'writing to a raw device' },
  { re: /\bshred\b|\btruncate\s+-s\s*0/i, why: 'destroying file contents' },

  // Becoming someone else
  { re: /\bsudo\b|\bdoas\b|\bsu\s+-|\bpkexec\b/i, why: 'privilege escalation' },
  { re: /\bchown\s+-R\s+\/|\bchmod\s+(-R\s+)?777\s+\//i, why: 'changing ownership of system paths' },

  // Running something nobody reviewed
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z|k|da)?sh\b/i, why: 'piping a download straight into a shell' },
  { re: /\bbase64\s+(-d|--decode)[^\n|]*\|\s*(ba)?sh\b/i, why: 'running obfuscated code' },
  // `python\b` does not match `python3` — n and 3 are both word characters, so
  // there is no boundary between them. Version suffixes have to be explicit.
  { re: /\b(curl|wget)\b[^\n]*\|\s*(python[\d.]*|node|perl|ruby|osascript)\b/i,
    why: 'piping a download into an interpreter' },
  { re: /\bInvoke-Expression\b|\biex\b\s*\(/i, why: 'evaluating a downloaded string (PowerShell)' },

  // Credentials
  { re: /\bsecurity\s+(find|dump)-(generic|internet)-password|\bkeychain\b/i, why: 'reading the keychain' },
  { re: /\.ssh\/id_|\.aws\/credentials|\.netrc\b|\bGPG_TTY\b/i, why: 'reading private keys or credentials' },
  { re: /\bcat\b[^\n]*\.env\b|\bprintenv\b[^\n]*\|\s*(curl|nc)\b/i, why: 'exfiltrating environment secrets' },

  // Persistence and system state
  { re: /\bcrontab\b|\blaunchctl\s+(load|bootstrap)|\bsystemctl\s+enable\b/i, why: 'installing something persistent' },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b/i, why: 'shutting the machine down' },
  { re: /\bdefaults\s+write\s+(com\.apple|\/)/i, why: 'changing system settings' },
  { re: /\bnc\s+-l|\bncat\b[^\n]*-e\b/i, why: 'opening a listening socket' },
];

/**
 * Look for the obviously catastrophic. Returns every reason it was refused,
 * rather than the first, so a review shows the whole picture at once.
 */
function scan(script) {
  const text = String(script || '');
  const blocked = FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.why);
  return { safe: blocked.length === 0, blocked: [...new Set(blocked)] };
}

/** How each language is run. Anything not listed here cannot be executed. */
const RUNNERS = {
  bash: { cmd: '/bin/bash', args: (f) => [f], ext: '.sh', platforms: ['darwin', 'linux'] },
  sh: { cmd: '/bin/sh', args: (f) => [f], ext: '.sh', platforms: ['darwin', 'linux'] },
  zsh: { cmd: '/bin/zsh', args: (f) => [f], ext: '.sh', platforms: ['darwin', 'linux'] },
  applescript: { cmd: '/usr/bin/osascript', args: (f) => [f], ext: '.scpt', platforms: ['darwin'] },
  python: { cmd: 'python3', args: (f) => [f], ext: '.py', platforms: ['darwin', 'linux', 'win32'] },
  powershell: {
    cmd: 'powershell.exe',
    args: (f) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
    ext: '.ps1',
    platforms: ['win32'],
  },
};

function runnerFor(language, platform = process.platform) {
  const key = String(language || '').toLowerCase().trim();
  const r = RUNNERS[key];
  if (!r) return { error: `fren cannot run "${language || 'an unnamed language'}"` };
  if (!r.platforms.includes(platform)) {
    return { error: `${key} scripts do not run on ${platform}` };
  }
  return { runner: r };
}

/**
 * Run one script. Resolves with a result rather than throwing, because a
 * failure here is an outcome to record, not an exception to lose.
 */
function run({ script, language, timeoutMs = TIMEOUT_MS, platform = process.platform }) {
  return new Promise((resolve) => {
    const check = scan(script);
    if (!check.safe) {
      return resolve({
        status: 'blocked',
        output: 'Refused before running — ' + check.blocked.join('; ') + '.',
      });
    }
    const { runner, error } = runnerFor(language, platform);
    if (error) return resolve({ status: 'blocked', output: error });

    let file;
    try {
      file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fren-run-')),
                       `automation${runner.ext}`);
      fs.writeFileSync(file, script, { mode: 0o600 });
    } catch (err) {
      return resolve({ status: 'failed', output: `could not stage the script: ${err.message}` });
    }

    // A reduced environment. A drafted script has no business inheriting every
    // variable this process happens to be holding.
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME || os.homedir(),
      USER: process.env.USER || '',
      LANG: process.env.LANG || 'en_US.UTF-8',
      TMPDIR: os.tmpdir(),
    };

    execFile(runner.cmd, runner.args(file), {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT * 4,
      env,
      cwd: os.homedir(),
      windowsHide: true,
    }, (err, stdout, stderr) => {
      try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* gone */ }
      const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, MAX_OUTPUT);
      if (err && err.killed) {
        return resolve({ status: 'failed', output: `timed out after ${Math.round(timeoutMs / 1000)}s\n${out}` });
      }
      if (err) return resolve({ status: 'failed', output: out || err.message });
      resolve({ status: 'ok', output: out || '(no output)' });
    });
  });
}

module.exports = { run, scan, hashScript, runnerFor, FORBIDDEN, RUNNERS, TIMEOUT_MS };
