// Runs off the main thread: optional hashcash PoW, then the HP folding unit.
import { solve } from '../shared/hp.js';
import { findPow } from '../shared/pow.js';

self.onmessage = ({ data }) => {
  const { unit, pow } = data;
  const t0 = performance.now();
  let nonce = null;

  if (pow) {
    const expected = 2 ** pow.bits;
    nonce = findPow(pow.prefix, pow.bits, {
      onProgress: (n) => postMessage({ type: 'progress', phase: 'pow', fraction: Math.min(0.97, n / expected) }),
    }).nonce;
  }
  const tFold = performance.now();

  // PoW-only job (classify mode): no folding unit.
  if (!unit) {
    postMessage({ type: 'done', nonce, result: null, totalMs: Math.round(tFold - t0), powMs: Math.round(tFold - t0) });
    return;
  }

  const result = solve(unit.sequence, unit.seed, unit.attempts, {
    progressEvery: 8192,
    onProgress: (p) =>
      postMessage({ type: 'progress', phase: 'fold', fraction: p.done / p.attempts, bestFold: p.bestFold, bestContacts: p.bestContacts }),
  });
  const t1 = performance.now();
  result.ms = Math.round(t1 - tFold);

  postMessage({ type: 'done', nonce, result, totalMs: Math.round(t1 - t0), powMs: Math.round(tFold - t0) });
};
