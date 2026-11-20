#!/usr/bin/env node
// Independently re-run validated units from the public archive and confirm
// every fingerprint matches. Anyone with the dataset and this repo can do this.
//
//   node scripts/reproduce.js [path/to/validated.jsonl] [--sample N] [--all]
//
// Exit code 0 = every checked record reproduced bit-for-bit.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { solve, evaluateFold, SOLVER_VERSION } from '../shared/hp.js';

const args = process.argv.slice(2);
const sampleIdx = args.indexOf('--sample');
const sample = sampleIdx >= 0 ? Number(args[sampleIdx + 1]) : 10;
const all = args.includes('--all');
const file =
  args.find((a, i) => !a.startsWith('--') && (sampleIdx < 0 || i !== sampleIdx + 1)) ??
  fileURLToPath(new URL('../data/results/validated.jsonl', import.meta.url));

if (!fs.existsSync(file)) {
  console.error(`No archive at ${file}. Validate some units first (open /volunteer?simulate).`);
  process.exit(1);
}

const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chosen = all ? records : records.sort(() => Math.random() - 0.5).slice(0, sample);
console.log(`Re-running ${chosen.length} of ${records.length} validated units with solver ${SOLVER_VERSION}…\n`);

let failures = 0;
for (const r of chosen) {
  if (r.solver !== SOLVER_VERSION) {
    console.log(`  SKIP ${r.unit}: produced by solver ${r.solver}`);
    continue;
  }
  const t = performance.now();
  const out = solve(r.sequence, r.seed, r.attempts);
  const ev = evaluateFold(r.sequence, r.best_fold);
  const same =
    out.fold === r.best_fold &&
    out.contacts === r.contacts &&
    out.checksum === r.checksum &&
    out.dead === r.dead_ends &&
    out.histogram.join(',') === r.histogram.join(',') &&
    ev.valid &&
    ev.contacts === r.contacts;
  if (!same) failures++;
  console.log(`  ${same ? 'OK  ' : 'FAIL'} ${r.unit.padEnd(16)} ${String(r.contacts).padStart(3)} contacts  #${r.checksum}  ${(performance.now() - t).toFixed(0)}ms`);
}

console.log(failures ? `\n${failures} record(s) did NOT reproduce.` : '\nAll checked records reproduced exactly.');
process.exit(failures ? 1 : 0);
