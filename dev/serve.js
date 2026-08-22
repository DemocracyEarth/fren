#!/usr/bin/env node
// Dev-only static server for the renderer, so the UI can be designed in a
// browser without launching Electron. Sends no-store so edits show up on
// reload instead of hiding behind the browser cache.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'apps', 'desktop', 'renderer');
const REPO = path.join(__dirname, '..');
// Dev-only aliases so the 3D prototype can load three.js and its own sources
// without moving anything into the shipped renderer.
const ALIAS = {
  '/vendor/three.module.js': path.join(REPO, 'node_modules', 'three', 'build', 'three.module.js'),
  '/vendor/three.core.js': path.join(REPO, 'node_modules', 'three', 'build', 'three.core.js'),
};
const PORT = Number(process.argv[2]) || 8777;
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};

function serveFile(file, res) {
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(body);
  });
}

http
  .createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end('bad request');   // malformed percent-escape
      return;
    }
    if (ALIAS[rel]) return serveFile(ALIAS[rel], res);
    if (rel.startsWith('/orb3d/')) {
      const p3 = path.resolve(path.join(REPO, 'dev', 'orb3d'), '.' + rel.slice('/orb3d'.length));
      if (!path.relative(path.join(REPO, 'dev', 'orb3d'), p3).startsWith('..')) return serveFile(p3, res);
    }
    // Same escape hatch for the benchmark pages.
    if (rel.startsWith('/bench/')) {
      const pb = path.resolve(path.join(REPO, 'dev', 'bench'), '.' + rel.slice('/bench'.length));
      if (!path.relative(path.join(REPO, 'dev', 'bench'), pb).startsWith('..')) return serveFile(pb, res);
    }
    const file = path.resolve(ROOT, '.' + (rel === '/' ? '/index.html' : rel));
    // Refuse anything outside the renderer directory. A prefix test would also
    // accept a sibling like <root>-other, so compare path segments.
    const within = path.relative(ROOT, file);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      // Browsers cache aggressively even with no-store, so stamp a fresh
      // token onto every local asset reference on the way out.
      let out = body;
      if (path.extname(file) === '.html') {
        const v = Date.now();
        out = Buffer.from(
          body
            .toString('utf8')
            .replace(/(href|src)="(?!https?:|\/\/|data:)([^"?#]+\.(?:css|js))"/g,
                     (_m, attr, url) => `${attr}="${url}?v=${v}"`)
        );
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store, must-revalidate',
      });
      res.end(out);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`renderer preview: http://localhost:${PORT}`));
