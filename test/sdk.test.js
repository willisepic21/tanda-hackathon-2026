import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { emptyState } from '../server/coordinator.js';
import { CONFIG } from '../server/config.js';
import { solve } from '../shared/hp.js';
import { findPow } from '../shared/pow.js';
import { createVerifier } from '../sdk/node/foldpass-server.js';

async function startServer() {
  const config = { ...CONFIG,
    citizen: { ...CONFIG.citizen, enabled: false }, port: 0, attempts: { light: 2000, standard: 2000 }, powBits: { desktop: 8, mobile: 8 }, knownAnswerRate: 0 };
  const server = http.createServer(createApp({ config, state: emptyState(), secret: 's' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, origin) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  return { server, base, post };
}

async function getToken(post, siteKey, origin) {
  const deviceToken = (await post('/api/device', {})).body.deviceToken;
  const ch = await post('/api/challenge', { siteKey, deviceToken }, origin);
  if (ch.status !== 200) return ch;
  const { unit, pow } = ch.body;
  const sol = await post('/api/solve', { challenge: ch.body.challenge, nonce: findPow(pow.prefix, pow.bits).nonce, result: solve(unit.sequence, unit.seed, unit.attempts) }, origin);
  return sol;
}

test('origin allowlist and hostname in siteverify', async (t) => {
  const { server, base, post } = await startServer();
  t.after(() => server.close());

  const blocked = await getToken(post, 'locked-site-key', 'https://evil.test');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'BAD_ORIGIN');

  const ok = await getToken(post, 'locked-site-key', 'https://example.com');
  assert.equal(ok.body.success, true);

  const v = createVerifier({ secret: 'locked-secret', host: base });
  const r = await v.verify(ok.body.passToken);
  assert.equal(r.success, true);
  assert.equal(r.hostname, 'example.com');
  assert.ok(r.challengeTs);
  assert.equal((await v.verify(ok.body.passToken)).success, false, 'one-time use');
});

test('node verifier enforces hostnames and fails closed', async (t) => {
  const { server, base, post } = await startServer();
  t.after(() => server.close());

  const sol = await getToken(post, 'demo-site-key', 'https://shop.test');
  const strict = createVerifier({ secret: CONFIG.sites['demo-site-key'].secret, host: base, hostnames: ['mysite.com'] });
  const r = await strict.verify(sol.body.passToken);
  assert.equal(r.success, false);
  assert.match(r.reason, /shop\.test/);

  const down = createVerifier({ secret: 'x', host: 'http://127.0.0.1:1', timeoutMs: 500 });
  assert.equal((await down.verify('anything')).success, false);
  assert.equal((await down.verify('')).reason, 'missing token');

  // Middleware rejects without a token.
  const mw = createVerifier({ secret: 'x', host: base }).middleware();
  let status, nexted = false;
  await mw({ body: {}, headers: {} }, { set statusCode(s) { status = s; }, setHeader() {}, end() {} }, () => (nexted = true));
  assert.equal(status, 403);
  assert.equal(nexted, false);
});
