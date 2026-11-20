import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { evaluateFold, solve } from '../shared/hp.js';
import { sha256Hex, findPow } from '../shared/pow.js';
import { BENCHMARKS } from '../shared/benchmarks.js';
import { verifyPow } from '../server/tokens.js';

test('benchmark sequences are well formed', () => {
  for (const b of BENCHMARKS) {
    assert.match(b.sequence, /^[HP]+$/, b.id);
    const len = Number(b.id.match(/-(\d+)$/)?.[1]);
    if (b.id.startsWith('S')) assert.equal(b.sequence.length, len, b.id);
  }
});

test('evaluateFold counts contacts and rejects collisions', () => {
  // H H / H H square: residues 0 and 3 are lattice neighbours -> 1 contact.
  assert.equal(evaluateFold('HHHH', 'RUL').contacts, 1);
  assert.equal(evaluateFold('HPPH', 'RUL').contacts, 1);
  assert.equal(evaluateFold('HPPP', 'RUL').contacts, 0);
  assert.equal(evaluateFold('HHHH', 'RRR').contacts, 0);
  assert.equal(evaluateFold('HHHHH', 'RULD').valid, false); // returns to origin
  assert.equal(evaluateFold('HHHH', 'RU').valid, false); // wrong length
  assert.equal(evaluateFold('HHHH', 'RUX').valid, false);
});

test('solver is deterministic and its output verifies', () => {
  const seq = BENCHMARKS[0].sequence;
  const a = solve(seq, 42, 5000);
  const b = solve(seq, 42, 5000);
  const c = solve(seq, 43, 5000);
  assert.deepEqual(a, b);
  assert.notEqual(a.checksum, c.checksum);
  const ev = evaluateFold(seq, a.fold);
  assert.ok(ev.valid);
  assert.equal(ev.contacts, a.contacts);
  assert.equal(a.histogram.reduce((x, y) => x + y, 0) + a.dead, 5000);
});

test('pure-JS SHA-256 matches node:crypto and PoW verifies server-side', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'prefix:123456'])
    assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s).digest('hex'));
  const { nonce } = findPow('test-prefix', 12);
  assert.ok(verifyPow('test-prefix', nonce, 12));
  assert.ok(!verifyPow('other-prefix', nonce, 30));
});
