#!/usr/bin/env node
'use strict';
/**
 * Build the vendored runtime host: install its dependencies with the pnpm it
 * pins (the machine's pnpm may be newer and refuse its workspace file) and
 * compile it. Builds the agent image too when a container runtime is present
 * and --image is given; otherwise says what is missing and leaves that step.
 *
 *   npm run runtime:build            # host only
 *   npm run runtime:build -- --image # host + agent image (needs the container runtime)
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'vendor', 'nanoclaw');
const PNPM = ['npx', ['-y', 'pnpm@10.34.5']];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[runtime-build] ${cmd} ${args.join(' ')} failed (${r.status})`);
    process.exit(r.status || 1);
  }
}

if (!fs.existsSync(path.join(root, 'package.json'))) {
  console.error('[runtime-build] vendor/nanoclaw is missing; the subtree was not added');
  process.exit(1);
}

console.log('[runtime-build] installing the runtime host dependencies');
run(PNPM[0], [...PNPM[1], 'install', '--frozen-lockfile']);
console.log('[runtime-build] compiling the runtime host');
run(PNPM[0], [...PNPM[1], 'run', 'build']);

if (process.argv.includes('--image')) {
  const { resolveDocker, pathWithDocker } = require('../packages/runtime-nanoclaw/container-runtime');
  const found = resolveDocker();
  const probe = found ? spawnSync(found.bin, ['info'], { stdio: 'ignore' }) : { status: 1 };
  if (probe.status !== 0) {
    console.error('[runtime-build] the container runtime is not available; skipping the agent image');
    process.exit(2);
  }
  console.log(`[runtime-build] building the agent image (docker at ${found.bin})`);
  // The build script shells `docker` by name.
  process.env.PATH = pathWithDocker(process.env);
  run('bash', ['container/build.sh']);
}
console.log('[runtime-build] done');
