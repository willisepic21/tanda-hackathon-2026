import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CitizenScience, emptyCitizenState, cleanLabel, forwardClassification } from '../server/citizen.js';
import { createApp } from '../server/app.js';
import { emptyState } from '../server/coordinator.js';
import { CONFIG } from '../server/config.js';
import { findPow } from '../shared/pow.js';

// A fake Panoptes API: one workflow with a 3-answer question and N single-image subjects.
function fakeZooniverse(nSubjects = 40) {
  const calls = [];
  const subjects = Array.from({ length: nSubjects }, (_, i) => ({ id: String(1000 + i), locations: [{ 'image/jpeg': `https://img.test/${i}.jpg` }], retired: false }));
  subjects.push({ id: '9999', locations: [{ 'image/jpeg': 'https://img.test/a.jpg' }, { 'image/jpeg': 'https://img.test/b.jpg' }] }); // multi-frame: skipped
  let served = 0;
  const fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (/\/workflows\/\d+$/.test(url))
      return json({ workflows: [{ display_name: 'Test WF', version: '4.47', tasks: { T0: { type: 'single', question: '**How many** squirrels?', answers: [{ label: '0' }, { label: '![x](https://i/x.png)1' }, { label: '2 or more' }] } } }] });
    if (/\/projects\/\d+$/.test(url)) return json({ projects: [{ display_name: 'SquirrelMapper', slug: 'x/squirrelmapper' }] });
    if (url.includes('/subjects/queued')) {
      const page = subjects.slice(served, served + 20);
      served += 20;
      return json({ subjects: page });
    }
    if (url.endsWith('/classifications')) return json({ classifications: [{ id: '1' }] }, 201);
    return json({}, 404);
  };
  return { fetch, calls };
}

const cfg = { ...CONFIG.citizen, enabled: true, poolSize: 10, retireAfter: 3, consensus: 0.8, maxVotes: 6, forward: { enabled: false } };

test('cleanLabel strips Zooniverse markdown', () => {
  assert.equal(cleanLabel('![Neutrophil](https://x/y.jpg =30x)Neutrophil'), 'Neutrophil');
  assert.equal(cleanLabel('**How many** squirrels?'), 'How many squirrels?');
});

test('bootstrap -> consensus -> known-answer checks gate counting', async () => {
  const z = fakeZooniverse();
  const records = [];
  const c = new CitizenScience(emptyCitizenState(), cfg, { fetch: z.fetch, rand: () => 0, onClassification: (r) => records.push(r) });
  const w = await c.init();
  assert.deepEqual(w.answers, ['0', '1', '2 or more']);
  assert.equal(w.question, 'How many squirrels?');
  assert.ok(!c.s.subjects['9999'], 'multi-image subjects are skipped');

  // Bootstrap: no gold yet, three devices agree on subject A -> consensus.
  const first = c.pick('d1');
  assert.equal(first.bootstrap, true);
  assert.equal(first.subjectIds.length, 1);
  const A = first.subjectIds[0];
  assert.equal(c.submit('d1', [A], [1], { bootstrap: true }).ok, true);
  assert.notEqual(c.pick('d2').subjectIds[0], A, 'least-answered subjects are served first');
  for (const d of ['d2', 'd3']) assert.equal(c.submit(d, [A], [1], { bootstrap: true }).ok, true);
  assert.equal(c.s.subjects[A].status, 'consensus');
  assert.equal(c.s.subjects[A].consensus, 1);

  // Now every challenge contains the known-answer subject plus an unknown one.
  const p = c.pick('d4');
  assert.equal(p.bootstrap, false);
  assert.equal(p.subjectIds.length, 2);
  const gi = p.subjectIds.indexOf(A);
  const ui = 1 - gi;
  const wrong = [];
  wrong[gi] = 0;
  wrong[ui] = 2;
  const bad = c.submit('d4', p.subjectIds, wrong, { bootstrap: false });
  assert.equal(bad.ok, false);
  assert.equal(c.s.subjects[p.subjectIds[ui]].counted, 0, 'failed visitor contributes nothing');

  const p5 = c.pick('d5');
  const right = [];
  right[p5.subjectIds.indexOf(A)] = 1;
  right[1 - p5.subjectIds.indexOf(A)] = 2;
  const good = c.submit('d5', p5.subjectIds, right, { bootstrap: false });
  assert.deepEqual([good.ok, good.verified, good.counted], [true, true, 1]);

  assert.ok(records.some((r) => r.role === 'known-answer'));
  assert.ok(records.every((r) => r.workflow_version === '4.47'));
  assert.match(c.consensusCsv(), /^subject_id,project_id,workflow_id,task,status/);
});

test('forwardClassification posts a Panoptes classification with the bearer token', async () => {
  const z = fakeZooniverse();
  const body = await forwardClassification(
    { task: 'T0', answer: 2, workflow_version: '4.47', started_at: 'a', finished_at: 'b', project_id: '8149', workflow_id: '30253', subject_id: '1000' },
    { api: 'https://z.test/api', token: 'tok', fetch: z.fetch },
  );
  const call = z.calls.at(-1);
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(body.classifications.annotations, [{ task: 'T0', value: 2 }]);
  assert.deepEqual(body.classifications.links, { project: '8149', workflow: '30253', subjects: ['1000'] });
});

test('classify CAPTCHA over HTTP: too-fast answers fail, real answers pass and verify', async (t) => {
  const z = fakeZooniverse();
  let clock = 1_000_000;
  const config = { ...CONFIG, port: 0, powBits: { desktop: 8, mobile: 8 }, citizen: cfg };
  const server = http.createServer(createApp({ config, state: emptyState(), secret: 's', now: () => clock, citizenFetch: z.fetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.port = server.address().port;
  t.after(() => server.close());
  const post = async (p, b) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return r.json();
  };

  const summary = await (await fetch(base + '/api/citizen')).json(); // waits for init
  assert.equal(summary.workflow.projectName, 'SquirrelMapper');

  const deviceToken = (await post('/api/device', {})).deviceToken;
  const ask = () => post('/api/challenge', { siteKey: 'demo-site-key', deviceToken, task: 'classify' });

  const ch = await ask();
  assert.equal(ch.task, 'classify');
  assert.equal(ch.classify.items.length, 1);
  assert.ok(!JSON.stringify(ch).includes('consensus'));
  const nonce = findPow(ch.pow.prefix, ch.pow.bits).nonce;
  assert.match((await post('/api/solve', { challenge: ch.challenge, nonce, answers: [1] })).reason, /too quickly/);

  const ch2 = await ask();
  clock += 3000;
  const ok = await post('/api/solve', { challenge: ch2.challenge, nonce: findPow(ch2.pow.prefix, ch2.pow.bits).nonce, answers: [1] });
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(ok.classify.counted, 1);

  const v = await post('/api/siteverify', { token: ok.passToken, secret: CONFIG.sites['demo-site-key'].secret });
  assert.equal(v.success, true);
  assert.equal(v.task, 'classify');

  // Fold mode still works and is the default.
  const fold = await post('/api/challenge', { siteKey: 'demo-site-key', deviceToken });
  assert.equal(fold.task, 'fold');
  assert.ok(z.calls.every((c) => !c.url.endsWith('/classifications')), 'nothing forwarded without permission');
});
