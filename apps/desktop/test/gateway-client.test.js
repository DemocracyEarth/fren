'use strict';
// The chosen chat model rides in every POST body the desktop sends — which is
// right for the fast lane and wrong for the one request whose `model` field is
// itself the message.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { config } = require('../../../packages/shared');

test('telling the gateway the chosen model sends exactly that, even "none"', async (t) => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const before = config.GATEWAY_URL;
  config.GATEWAY_URL = `http://127.0.0.1:${fake.address().port}`;
  t.after(() => { config.GATEWAY_URL = before; fake.close(); });

  const gateway = require('../main/gatewayClient');
  gateway.setOverrides({ chatModel: 'deepseek-v4-pro' });
  t.after(() => gateway.setOverrides({}));

  // The fast lane: the override is merged in.
  await gateway.chat({ question: 'hi' });
  assert.equal(seen[0].body.model, 'deepseek-v4-pro');

  // Going back to the default while an override is still held here must reach
  // the gateway as null — not be rewritten into the very model being dropped.
  await gateway.setRuntimeModel('');
  assert.equal(seen[1].url, '/v1/runtime/model');
  assert.equal(seen[1].auth, `Bearer ${config.GATEWAY_TOKEN}`);
  assert.deepEqual(seen[1].body, { model: null });

  await gateway.setRuntimeModel('deepseek-v4-flash');
  assert.deepEqual(seen[2].body, { model: 'deepseek-v4-flash' });
});
