import { aminoToHP } from './hp.js';

// Work is drawn from these sequences.
// The S-series are the standard 2D HP benchmarks (Unger & Moult 1993 and
// follow-ups); `bestKnown` is the best published contact count.
// The two cancer-protein entries are amino-acid fragments mapped to HP by
// hydrophobicity; they are illustrative and have no published optimum.
//
// tier: 'light' units are allowed on mobile; 'standard' units are desktop-only.
export const BENCHMARKS = [
  { id: 'S1-20', name: 'Benchmark S1', sequence: 'HPHPPHHPHPPHPHHPPHPH', bestKnown: 9, tier: 'light' },
  { id: 'S2-24', name: 'Benchmark S2', sequence: 'HHPPHPPHPPHPPHPPHPPHPPHH', bestKnown: 9, tier: 'light' },
  { id: 'S3-25', name: 'Benchmark S3', sequence: 'PPHPPHHPPPPHHPPPPHHPPPPHH', bestKnown: 8, tier: 'light' },
  { id: 'S4-36', name: 'Benchmark S4', sequence: 'PPPHHPPHHPPPPPHHHHHHHPPHHPPPPHHPPHPP', bestKnown: 14, tier: 'light' },
  {
    id: 'KRAS-1-40',
    name: 'KRAS 1–40 (G12/G13 region)',
    amino: 'MTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPTIEDSY',
    bestKnown: null,
    tier: 'light',
  },
  { id: 'S5-48', name: 'Benchmark S5', sequence: 'PPHPPHHPPHHPPPPPHHHHHHHHHHPPPPPPHHPPHHPPHPPHHHHH', bestKnown: 23, tier: 'standard' },
  { id: 'S6-50', name: 'Benchmark S6', sequence: 'HHPHPHPHPHHHHPHPPPHPPPHPPPPHPPPHPPPHPHHHHPHPHPHPHH', bestKnown: 21, tier: 'standard' },
  {
    id: 'TP53-94-155',
    name: 'TP53 94–155 (DNA-binding domain)',
    amino: 'SSSVPSQKTYQGSYGFRLGFLHSGTAKSVTCTYSPALNKMFCQLAKTCPVQLWVDSTPPPG',
    bestKnown: null,
    tier: 'standard',
  },
  { id: 'S7-60', name: 'Benchmark S7', sequence: 'PPHHHPHHHHHHHHPPPHHHHHHHHHHPHPPPHHHHHHHHHHHHPPPPHHHHHHPHHPHP', bestKnown: 36, tier: 'standard' },
  { id: 'S8-64', name: 'Benchmark S8', sequence: 'HHHHHHHHHHHHPHPHPPHHPPHHPPHPPHHPPHHPPHPPHHPPHHPPHPHPHHHHHHHHHHHH', bestKnown: 42, tier: 'standard' },
].map((b) => ({ ...b, sequence: b.sequence ?? aminoToHP(b.amino) }));

export const BENCHMARK_BY_ID = Object.fromEntries(BENCHMARKS.map((b) => [b.id, b]));
