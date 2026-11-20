import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { emptyState } from '../server/coordinator.js';
import { CONFIG } from '../server/config.js';
import { solve } from '../shared/hp.js';
import { findPow } from '../shared/pow.js';

test('full CAPTCHA + volunteer flow over HTTP', async (t) => {
  const config = {
    ...CONFIG,
    citizen: { ...CONFIG.citizen, enabled: false },
    port: 0,
    attempts: { light: 3000, standard: 3000 },
    powBits: { desktop: 10, mobile: 8 },
    knownAnswerRate: 0,
  };
  const server = http.createServer(createApp({ config, state: emptyState(), secret: 'test-secret' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.port = server.address().port; // so /demo/signup can call back into siteverify
  t.after(() => server.close());

  const post = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  const devA = (await post('/api/device', {})).body.deviceToken;
  const devB = (await post('/api/device', {})).body.deviceToken;

  // --- CAPTCHA on device A
  const ch = (await post('/api/challenge', { siteKey: 'demo-site-key', deviceToken: devA })).body;
  const { nonce } = findPow(ch.pow.prefix, ch.pow.bits);
  const result = solve(ch.unit.sequence, ch.unit.seed, ch.unit.attempts);

  const bad = await post('/api/solve', { challenge: ch.challenge, nonce: nonce + 1e9, result });
  assert.equal(bad.body.success, false); // wrong PoW (and the challenge is now burned)

  const ch2 = (await post('/api/challenge', { siteKey: 'demo-site-key', deviceToken: devA })).body;
  const sol = await post('/api/solve', {
    challenge: ch2.challenge,
    nonce: findPow(ch2.pow.prefix, ch2.pow.bits).nonce,
    result: solve(ch2.unit.sequence, ch2.unit.seed, ch2.unit.attempts),
  });
  assert.equal(sol.body.success, true, JSON.stringify(sol.body));
  assert.equal(sol.body.unit.status, 'open');

  // Replay of the same challenge is refused.
  assert.equal((await post('/api/solve', { challenge: ch2.challenge, nonce: 0, result })).body.success, false);

  // --- Host site backend verifies the pass token exactly once
  const signup = await post('/demo/signup', { email: 'a@b.c', token: sol.body.passToken });
  assert.equal(signup.body.ok, true, JSON.stringify(signup.body));
  assert.equal((await post('/demo/signup', { token: sol.body.passToken })).status, 403);
  assert.equal((await post('/api/siteverify', { token: sol.body.passToken, secret: 'wrong' })).body.success, false);

  // --- Device B (volunteer) gets the pending unit and validates it
  const work = (await post('/api/work', { deviceToken: devB })).body;
  assert.equal(work.unit.id, ch2.unit.id);
  const done = await post('/api/result', { lease: work.lease, result: solve(work.unit.sequence, work.unit.seed, work.unit.attempts) });
  assert.equal(done.body.status, 'validated');

  const stats = await (await fetch(`http://127.0.0.1:${config.port}/api/stats`)).json();
  assert.equal(stats.units.validated, 1);
  assert.equal(stats.stats.captchaPassed, 1);

  // Open-data exports
  const summary = await (await fetch(`http://127.0.0.1:${config.port}/api/data/summary.json`)).json();
  assert.equal(summary.totals.validatedUnits, 1);
  const csv = await (await fetch(`http://127.0.0.1:${config.port}/api/data/best-folds.csv`)).text();
  assert.match(csv, /^benchmark,sequence/);
  assert.equal(csv.trim().split('\n').length, 2);

  // Static files are served, path traversal is not.
  assert.equal((await fetch(`http://127.0.0.1:${config.port}/shared/hp.js`)).status, 200);
  assert.notEqual((await fetch(`http://127.0.0.1:${config.port}/..%2fserver%2fconfig.js`)).status, 200);
});
