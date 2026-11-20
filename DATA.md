# FoldPass results data

## Where solved data goes

```
device solves unit ──▶ /api/solve or /api/result
                        │  instant check: self-avoiding fold, correct energy, histogram sums to attempts
                        ▼
                 unit.results[] in data/state.json      (working memory: pending replicas, trust, leases)
                        │  2nd device returns a bit-identical fingerprint → validated
                        ▼
      data/results/validated.jsonl   ◀── permanent, append-only, one line per validated unit
                        │
                        ├─ state.science: per-sequence aggregates (merged histogram, top distinct folds)
                        ├─ /api/data/validated.jsonl   (?benchmark=S1-20 to filter, &download to save)
                        ├─ /api/data/best-folds.csv
                        ├─ /api/data/summary.json
                        └─ npm run reproduce            (re-runs archived units, checks every fingerprint)
```

Unvalidated, disputed and rejected results never reach the archive. `state.json` is trimmed at 5,000 units, but the archive is never trimmed.

## Record schema (`foldpass.validated.v1`)

| Field | Meaning |
|---|---|
| `unit` | Work-unit ID, `<benchmark>.<n>` |
| `benchmark`, `sequence` | Which HP sequence was folded |
| `lattice`, `energy_model` | `2D-square`; E = −1 per non-bonded H–H contact |
| `solver` | Solver version. Results are only comparable within a version |
| `seed`, `attempts` | Together with `sequence` and `solver`, fully determine the output |
| `best_fold` | Lowest-energy fold found, as absolute moves `R U L D` from residue 0 |
| `best_fold_canonical` | Same structure with rotation and mirror image normalised (for deduplication) |
| `contacts`, `energy` | H–H contacts of the best fold, and `-contacts` |
| `histogram` | `histogram[k]` = number of completed attempts that ended with `k` contacts |
| `dead_ends` | Attempts where the growing chain trapped itself |
| `checksum` | FNV-style rolling hash over the energy of every attempt, in order |
| `replicas` | The agreeing devices (keyed hash, not the real ID), their compute time and submit time |
| `disagreeing_replicas` | How many devices returned something else before quorum |
| `validated_at` | ISO timestamp |

## Trust model

- **Validity is checked, not trusted:** the server re-derives the energy of every submitted fold.
- **Completeness is replicated:** `checksum` + `histogram` + `dead_ends` can only be matched by running every attempt, so a device that skips work gets outvoted.
- **Reproducibility:** `node scripts/reproduce.js <file> --all` re-runs records locally and fails loudly on any mismatch.

## Limitations

- The 2D HP model is a coarse abstraction of protein folding. Optimal folds for S1–S8 are already known, and the network mostly rediscovers or approaches them.
- `histogram` holds raw counts from a **biased** sampler, not a density-of-states or Boltzmann estimate. Turning it into thermodynamics would need Rosenbluth weights recorded per attempt.
- The KRAS and TP53 entries are amino-acid fragments mapped to H/P by hydrophobicity. They are illustrative, not structural predictions.

## Publishing

1. Export `validated.jsonl` plus `summary.json`.
2. Deposit on Zenodo (free DOI) under CC0, with this file as the README and the git commit hash of the solver.
3. Cite the DOI anywhere you report results. Anyone can verify the data with `scripts/reproduce.js`.
