#!/usr/bin/env node
/**
 * What does a renderer cost while it just sits there?
 *
 * macOS `ps` reports CPU% as a lifetime average, and Electron's own
 * percentCPUUsage does the same, so both read ~0 for a process that has been
 * up a while. The honest measure is the DELTA in accumulated CPU time across
 * the whole process tree over a known wall-clock window.
 *
 * Every trial reports the frames the page actually scheduled, so a page that
 * failed to load cannot masquerade as a page that is cheap. Trials whose wall
 * clock drifts from the target are discarded rather than averaged in --
 * a descheduled process yields a ratio that means nothing.
 *
 * Real wattage needs `powermetrics`, which requires root. Not attempted.
 */
const { spawn, execSync } = require('node:child_process');
const path = require('path');

const ELECTRON = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const WINDOW_JS = path.join(__dirname, 'bench-window.js');
const WARMUP = 9;   // let the helper process tree finish spawning
const WINDOW = 20;
const TRIALS = Number(process.env.TRIALS || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function descendants(root) {
  const rows = execSync('ps -eo pid,ppid').toString().trim().split('\n').slice(1);
  const kids = new Map();
  for (const line of rows) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [];
  const walk = (p) => { out.push(p); for (const k of kids.get(p) || []) walk(k); };
  walk(root);
  return out;
}

/** Accumulated CPU seconds across pids. ps format is [[HH:]MM:]SS.ss */
function cpuByPid(pids) {
  const map = new Map();
  if (!pids.length) return map;
  let out;
  try { out = execSync(`ps -o pid=,cputime= -p ${pids.join(',')} 2>/dev/null`).toString(); }
  catch { return map; }
  for (const raw of out.trim().split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const [pid, time] = t.split(/\s+/);
    map.set(Number(pid), time.split(':').map(Number).reduce((a, b) => a * 60 + b, 0));
  }
  return map;
}

function cpuSeconds(pids, snapshot) {
  const map = snapshot || cpuByPid(pids);
  let total = 0;
  for (const p of pids) total += map.get(p) || 0;
  return total;
}

function trial(url, reduced) {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON, [WINDOW_JS], {
      env: { ...process.env, BENCH_URL: url, BENCH_REDUCED: reduced ? '1' : '0',
             BENCH_WARMUP: String(WARMUP), BENCH_WINDOW: String(WINDOW) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    let probe = null;
    let t0 = 0;
    let c0 = 0;
    let pids = [];
    let snapshot0 = null;
    child.stdout.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === 'ready') {
          probe = msg;
          pids = descendants(child.pid);
          snapshot0 = cpuByPid(pids);
          c0 = cpuSeconds(pids, snapshot0);
          t0 = Number(process.hrtime.bigint());
        } else if (msg.event === 'done') {
          // Only processes alive at BOTH samples can give a meaningful delta.
          // A pid that exits in between drops its accumulated time out of the
          // total and yields a negative rate, which is how this was caught.
          const now = new Set(descendants(child.pid));
          const stable = pids.filter((p) => now.has(p));
          const churn = pids.length - stable.length;
          const c0s = cpuSeconds(stable, snapshot0);
          const c1 = cpuSeconds(stable);
          const wall = (Number(process.hrtime.bigint()) - t0) / 1e9;
          if (process.env.DEBUG_BENCH) {
            console.error(`[dbg] pids=${pids.length} stable=${stable.length} ` +
              `c0s=${c0s.toFixed(2)} c1=${c1.toFixed(2)} wall=${wall.toFixed(1)}`);
            console.error(`[dbg] t0map=${JSON.stringify([...snapshot0])}`);
            console.error(`[dbg] t1map=${JSON.stringify([...cpuByPid(stable)])}`);
          }
          try { child.stdin.write('q\n'); } catch { /* already gone */ }
          resolve({ probe, frames: msg.frames, fps: msg.fps, wall, churn,
                    cpu: c1 - c0s, pct: ((c1 - c0s) / wall) * 100 });
        }
      }
    });
    child.on('exit', () => setTimeout(() => resolve(null), 50));
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

(async () => {
  const base = 'http://localhost:8777';
  const CONDITIONS = [
    ['A · blank window (control)', 'about:blank', false],
    ['B · SVG face — normal motion', `${base}/bench/svg.html`, false],
    ['B0 · SVG face — before the glow commit', `${base}/bench/svg-preglow.html`, false],
    ['C · SVG face — reduced motion', `${base}/bench/svg.html`, true],
    ['D · Three.js orb', `${base}/orb3d/index.html`, false],
  ];

  // One condition per invocation when asked, so a long matrix cannot be
  // killed halfway through and lose everything.
  const only = process.env.ONLY;
  const chosen = only
    ? CONDITIONS.filter((c) => c[0].startsWith(only + ' '))
    : CONDITIONS;

  const summary = [];
  for (const [label, url, reduced] of chosen) {
    const kept = [];
    const rejected = [];
    let probe = null;
    for (let i = 0; i < TRIALS; i++) {
      const r = await trial(url, reduced);
      await sleep(1200);
      if (!r) { rejected.push('no result'); continue; }
      probe = r.probe;
      // A descheduled process makes cpu/wall meaningless. Discard, don't average.
      if (Math.abs(r.wall - WINDOW) / WINDOW > 0.15) {
        rejected.push(`wall ${r.wall.toFixed(1)}s`); continue;
      }
      if (r.pct < 0) { rejected.push(`negative rate (${r.churn} pids exited)`); continue; }
      kept.push(r);
    }
    summary.push({
      label,
      trials: kept.length, rejected,
      status: probe ? probe.status : null,
      svg: probe ? probe.svg : null, canvas: probe ? probe.canvas : null,
      reducedSeen: probe ? probe.reduced : null,
      pct: kept.length ? +median(kept.map((k) => k.pct)).toFixed(2) : null,
      fps: kept.length ? +median(kept.map((k) => k.fps)).toFixed(1) : null,
    });
  }

  const w = Math.max(...summary.map((s) => s.label.length));
  console.log('\n' + 'condition'.padEnd(w) + '  HTTP  svg/canvas  rAF/s   CPU%  trials');
  console.log('-'.repeat(w + 42));
  for (const s of summary) {
    console.log(
      s.label.padEnd(w) +
      String(s.status ?? '—').padStart(6) +
      `${s.svg}/${s.canvas}`.padStart(12) +
      String(s.fps ?? '—').padStart(7) +
      String(s.pct ?? '—').padStart(7) +
      String(s.trials).padStart(8) +
      (s.rejected.length ? `   (dropped: ${s.rejected.join(', ')})` : '')
    );
  }
  console.log('\n' + JSON.stringify(summary));
})();
