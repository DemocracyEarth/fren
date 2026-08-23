'use strict';
/**
 * The whole loop, over a real socket.
 *
 * The unit tests stub the gateway, which means they would keep passing if the
 * wire format between the desktop and the gateway drifted apart. This runs the
 * actual HTTP client against the actual server, with only the model itself
 * replaced — so a renamed field or a schema the prompt no longer matches shows
 * up here rather than on someone's desktop.
 */
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../../gateway/server');
const { createCuriosityWatcher } = require('../main/curiosity.js');
const soul = require('../main/soul.js');

test('fren asks, the answer is weighed, and what it learned is on disk', async () => {
  // A stub model that plays both parts: curious first, then the verdict on the
  // answer. Everything between it and the watcher is the real thing.
  const seen = [];
  const server = createServer({
    name: 'stub',
    model: 'stub',
    async complete({ system, messages }) {
      seen.push({ system, user: messages[0].content });
      if (/you get curious/i.test(system)) {
        return JSON.stringify({
          ask: true,
          question: 'What is the landing page for?',
          about: 'the landing page',
          why: 'a long stretch in one file',
        });
      }
      return JSON.stringify({ worthKeeping: true, fact: 'Building a landing page for fren.' });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.FREN_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;

  // Required before gatewayClient is loaded: it reads the URL at require time.
  delete require.cache[require.resolve('../../../packages/shared/config.js')];
  delete require.cache[require.resolve('../../../packages/shared')];
  delete require.cache[require.resolve('../main/gatewayClient.js')];
  const gateway = require('../main/gatewayClient.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-e2e-'));
  soul.writeSoul(dir, {
    name: 'Sam', tone: 'brief and plain', initiative: 'you can interrupt me',
    work: 'fren', goals: 'ship it',
  });

  const settings = new Map();
  const asked = [];
  const watcher = createCuriosityWatcher({
    memory: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => settings.set(k, v),
      getRecentMemories: () => Array.from({ length: 8 }, (_, i) => ({
        tsStart: i * 6e5, tsEnd: i * 6e5 + 5e5,
        activity: 'in Figma on the landing page', apps: ['Figma'], confidence: 0.9,
      })),
    },
    gateway,
    state: { get: () => ({ observing: true }), beginWork() {}, endWork() {} },
    soulFor: () => soul.readContext(dir).soul,
    profileFor: () => ({ volunteer: true, name: 'Sam' }),
    onQuestion: (q) => asked.push(q),
    log: () => {},
    options: { warmupMs: 0, chance: 1 },
  });

  try {
    await watcher.consider();
    assert.equal(asked.length, 1, 'a question came back through the real client');
    assert.match(asked[0].question, /landing page/);

    // SOUL.md has to reach the prompt, or the character the user wrote during
    // setup has no bearing on how fren asks things.
    assert.match(seen[0].system, /brief and plain/,
      "the user's own words about tone reached the model");

    // Now the user answers, and the durable part of it is kept.
    const { worthKeeping, fact } = await gateway.learn({
      question: asked[0].question,
      answer: 'It is for fren, the desktop companion I am building.',
    });
    assert.equal(worthKeeping, true);
    assert.equal(soul.rememberFact(dir, fact), true);

    const memoryFile = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    assert.match(memoryFile, /Building a landing page for fren\./,
      'what fren learned is in a file the user can open, edit and delete');
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.FREN_GATEWAY_URL;
  }
});
