import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator, emptyState } from '../server/coordinator.js';
import { solve } from '../shared/hp.js';

const cfg = {
  replicas: 2,
  maxReplicas: 4,
  distinctIp: false,
  trustFloor: -3,
  knownAnswerRate: 1,
  attempts: { light: 2000, standard: 2000 },
  leaseTtlMs: 60_000,
};

const make = () => new Coordinator(emptyState(), cfg, { rand: () => 0 });
const honest = (u) => ({ ...solve(u.sequence, u.seed, u.attempts), ms: 10 });

test('a unit validates only once two distinct devices agree', () => {
  const c = make();
  const { unit } = c.assign('A');
  const r1 = c.submit('A', unit.id, honest(unit));
  assert.equal(r1.status, 'open');
  assert.equal(r1.replicas, 1);

  // Same device cannot be its own replica.
  assert.equal(c.submit('A', unit.id, honest(unit)).ok, false);

  // The next device is routed to the pending unit first.
  const { unit: u2 } = c.assign('B');
  assert.equal(u2.id, unit.id);
  const r2 = c.submit('B', unit.id, honest(unit));
  assert.equal(r2.status, 'validated');
  assert.equal(c.s.devices.A.trust, 1);
  assert.equal(c.s.devices.B.trust, 1);
  assert.ok(c.s.best[unit.benchmarkId]);
});

test('a unit is not handed to a third device while two leases are outstanding', () => {
  const c = make();
  const { unit } = c.assign('A');
  assert.equal(c.assign('B').unit.id, unit.id);
  assert.notEqual(c.assign('C').unit.id, unit.id);
});

test('invalid or inconsistent results are rejected outright', () => {
  const c = make();
  const { unit } = c.assign('A');
  const good = honest(unit);
  assert.match(c.submit('A', unit.id, { ...good, contacts: good.contacts + 1 }).reason, /contacts/);
  assert.match(c.submit('A', unit.id, { ...good, fold: good.fold.replace(/./g, 'R').slice(0, -2) + 'LL' }).reason, /invalid fold|contacts/);
  assert.match(c.submit('A', unit.id, { ...good, dead: good.dead + 5 }).reason, /attempts/);
  assert.equal(c.s.devices.A.rejected, 3);
});

test('disagreeing replicas trigger a tie-breaker and the liar loses trust', () => {
  const c = make();
  const { unit } = c.assign('A');
  const good = honest(unit);
  // Lazy cheater: runs fewer attempts but pads the histogram to look complete.
  const lazy = solve(unit.sequence, unit.seed, 100);
  const fake = { ...lazy, dead: lazy.dead + unit.attempts - 100, ms: 1 };

  c.submit('A', unit.id, good);
  const r = c.submit('B', unit.id, fake);
  assert.equal(r.status, 'disputed');

  const { unit: u3 } = c.assign('C');
  assert.equal(u3.id, unit.id, 'disputed unit goes to a third device');
  assert.equal(c.submit('C', unit.id, honest(unit)).status, 'validated');
  assert.ok(c.s.devices.B.trust < 0);
  assert.ok(c.s.devices.A.trust > 0 && c.s.devices.C.trust > 0);
});

test('validated units are re-used as known-answer checks in captcha mode', () => {
  const c = make();
  const { unit } = c.assign('A');
  c.submit('A', unit.id, honest(unit));
  c.assign('B');
  c.submit('B', unit.id, honest(unit));

  const { unit: ku, known } = c.assign('D', { mode: 'captcha' });
  assert.equal(known, true);
  assert.equal(ku.id, unit.id);
  const lazy = solve(unit.sequence, unit.seed + 1, unit.attempts);
  const res = c.submit('D', unit.id, lazy);
  assert.equal(res.known, true);
  assert.equal(res.matched, false);
  assert.equal(c.s.stats.knownAnswerFailures, 1);
});
