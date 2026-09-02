'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createEventStream, parseFrames } = require('../main/coreEvents');

test('frames parse, comments are skipped, partial frames wait', () => {
  const text = ': connected\n\nid: 1\nevent: run.started\ndata: {"id":1,"type":"run.started","runId":"r"}\n\nid: 2\ndata: {"id":2,"type":"x"}\n\nid: 3\ndata: {"id":3,';
  const { events, rest } = parseFrames(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'run.started');
  assert.equal(events[1].id, 2);
  assert.ok(rest.startsWith('id: 3'));
});

test('the client resumes from the last id after the server drops it', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const since = new URL(req.url, 'http://x').searchParams.get('since');
    requests.push({ since, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      res.write('id: 1\ndata: {"id":1,"type":"a"}\n\nid: 2\ndata: {"id":2,"type":"b"}\n\n');
      res.end(); // the server drops the connection
    } else {
      res.write('id: 3\ndata: {"id":3,"type":"c"}\n\n');
      // stays open until the client closes
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const seen = [];
  const statuses = [];
  const stream = createEventStream({
    url: `http://127.0.0.1:${server.address().port}/v1/events`,
    token: 't',
    since: 'latest',
    backoffMs: [5],
    onEvent: (e) => seen.push(e),
    onStatus: (s) => statuses.push(s),
  });
  const deadline = Date.now() + 2000;
  while (seen.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  stream.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  assert.deepEqual(seen.map((e) => e.type), ['a', 'b', 'c']);
  assert.equal(requests[0].since, 'latest');
  assert.equal(requests[1].since, '2', 'reconnects asking for what came after the last id');
  assert.equal(requests[0].auth, 'Bearer t');
  assert.equal(stream.lastId(), 3);
  assert.ok(statuses.includes('disconnected'));
});

test('close stops the loop even while waiting to reconnect', async () => {
  let hits = 0;
  const stream = createEventStream({
    url: 'http://127.0.0.1:1/v1/events', token: 't', backoffMs: [50],
    onEvent: () => {}, onStatus: () => { hits += 1; },
    fetchImpl: async () => { throw new Error('refused'); },
  });
  await new Promise((r) => setTimeout(r, 20));
  stream.close();
  const before = hits;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(hits, before, 'no attempts after close');
});
