#!/usr/bin/env node
// Dev runner: starts the local LLM gateway and the Electron desktop app together.
const { spawn } = require('child_process');
const path = require('path');

const root = __dirname;
const children = [];
let shuttingDown = false;

function run(name, cmd, args) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`[fren] ${name} exited (${code ?? 'signal'}), shutting down`);
      shutdown(code ?? 0);
    }
  });
  children.push(child);
}

function shutdown(code = 0) {
  shuttingDown = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('gateway', process.execPath, [path.join(root, 'apps/gateway/server.js')]);
run('desktop', path.join(root, 'node_modules/.bin/electron'), [path.join(root, 'apps/desktop')]);
