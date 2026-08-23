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
const { spawn } = require('node:child_process');
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
  // Named rather than given a single path: python3 lives somewhere different
  // on nearly every machine. resolveCommand below turns this into an ABSOLUTE
  // path from a fixed list — approval binds the script, and it has to bind what
  // interprets the script too, or a writable directory earlier on PATH decides
  // what "approved" means.
  python: {
    candidates: ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'],
    args: (f) => [f], ext: '.py', platforms: ['darwin', 'linux'],
  },
  powershell: {
    candidates: [
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ],
    args: (f) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
    ext: '.ps1',
    platforms: ['win32'],
  },
};

/**
 * The absolute path of the interpreter, or nothing.
 *
 * Never resolved through PATH. An inherited PATH means a writable directory
 * earlier in it can supply the interpreter, and then the hash guards the script
 * while something else entirely decides what running it means.
 */
function resolveCommand(runner) {
  if (runner.cmd) return fs.existsSync(runner.cmd) ? runner.cmd : null;
  for (const c of runner.candidates || []) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

function runnerFor(language, platform = process.platform) {
  const key = String(language || '').toLowerCase().trim();
  const r = RUNNERS[key];
  if (!r) return { error: `fren cannot run "${language || 'an unnamed language'}"` };
  if (!r.platforms.includes(platform)) {
    return { error: `${key} scripts do not run on ${platform}` };
  }
  // Only resolve for the platform we are actually on; a cross-platform check is
  // about support, not about what exists on this disk.
  if (platform === process.platform && !resolveCommand(r)) {
    return { error: `no interpreter for ${key} was found in a known location` };
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
      // A fixed PATH rather than the inherited one, for the same reason the
      // interpreter is resolved absolutely: what a script resolves a command to
      // should not depend on what happened to be in this process's environment.
      PATH: process.platform === 'win32'
        ? 'C:\\Windows\\System32;C:\\Windows'
        : '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME || os.homedir(),
      USER: process.env.USER || '',
      LANG: process.env.LANG || 'en_US.UTF-8',
      TMPDIR: os.tmpdir(),
    };

    // spawn, not execFile, and DETACHED — so the script gets its own process
    // group. execFile's timeout signals one pid, which a script escapes simply
    // by backgrounding its work: the shell exits, the run is reported over, and
    // the real work carries on unbounded. An audit demonstrated exactly that,
    // with three processes still alive after the "hard timeout" fired.
    const child = spawn(resolveCommand(runner), runner.args(file), {
      detached: true,
      env,
      cwd: os.homedir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    /** Take down the whole group, not just the shell that started it. */
    const killGroup = () => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } else {
          process.kill(-child.pid, 'SIGKILL');   // negative pid == the group
        }
      } catch { /* already gone */ }
    };

    let out = '';
    let overflowed = false;
    const collect = (buf) => {
      if (out.length >= MAX_OUTPUT) { overflowed = true; return; }
      out += buf.toString();
      if (out.length > MAX_OUTPUT) { out = out.slice(0, MAX_OUTPUT); overflowed = true; }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);

    const finish = (status, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever happened, nothing from this run outlives it. A script that
      // backgrounds work and exits immediately would otherwise be reported
      // finished while its real work continues — and, worse, be marked
      // VERIFIED and become eligible for scheduling on that basis.
      killGroup();
      try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* gone */ }
      const text = [extra, out.trim(), overflowed ? '…output truncated' : '']
        .filter(Boolean).join('\n').slice(0, MAX_OUTPUT);
      resolve({ status, output: text || '(no output)' });
    };

    child.on('error', (err) => finish('failed', `could not start the interpreter: ${err.message}`));
    child.on('close', (code, signal) => {
      if (timedOut) {
        return finish('failed', `timed out after ${Math.round(timeoutMs / 1000)}s and was stopped`);
      }
      if (signal) return finish('failed', `stopped by ${signal}`);
      if (code !== 0) return finish('failed', `exited with code ${code}`);
      finish('ok');
    });
  });
}

module.exports = { run, scan, hashScript, runnerFor, FORBIDDEN, RUNNERS, TIMEOUT_MS };
