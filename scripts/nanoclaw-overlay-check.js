#!/usr/bin/env node
'use strict';
/**
 * The FREN overlay on the vendored runtime is a few added files and one
 * import line in each of three barrels — exactly what upstream's own skills
 * add. A subtree pull can drop a barrel line without a conflict. This check
 * fails loudly when it has, so `npm test` catches it before anyone ships.
 *
 * Run standalone: node scripts/nanoclaw-overlay-check.js
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'vendor', 'nanoclaw');

const FILES = [
  'src/channels/fren.ts',
  'src/gateway-providers/fren.ts',
  'src/modules/fren/index.ts',
];

const BARREL_LINES = [
  ['src/channels/index.ts', "import './fren.js';"],
  ['src/gateway-providers/installed.ts', "import './fren.js';"],
  ['src/modules/index.ts', "import './fren/index.js';"],
];

function check() {
  const problems = [];
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    return ['vendor/nanoclaw is missing (the subtree was not added)'];
  }
  for (const f of FILES) {
    if (!fs.existsSync(path.join(root, f))) problems.push(`missing overlay file ${f}`);
  }
  for (const [barrel, line] of BARREL_LINES) {
    const p = path.join(root, barrel);
    if (!fs.existsSync(p)) { problems.push(`missing barrel ${barrel}`); continue; }
    if (!fs.readFileSync(p, 'utf8').includes(line)) problems.push(`${barrel} lost its line: ${line}`);
  }
  return problems;
}

if (require.main === module) {
  const problems = check();
  if (problems.length) {
    console.error('[overlay-check] the FREN overlay on vendor/nanoclaw is incomplete:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('[overlay-check] ok');
}

module.exports = { check, FILES, BARREL_LINES, root };
