// HP lattice protein model on the 2D square lattice.
// This file is shared by the browser workers (solver) and the server (verifier).
//
// A fold is a string of absolute moves, one per bond: R, U, L, D.
// Energy = -(number of H-H topological contacts), i.e. pairs of H residues
// that are lattice neighbours but not adjacent in the chain.
//
// The solver is deliberately DETERMINISTIC: it uses integer-only maths and a
// seeded PRNG, so two honest devices given the same (sequence, seed, attempts)
// produce bit-identical output. That is what makes 2-device replication work.

export const DIR_CHARS = 'RULD';
/** Bump whenever solver output could change: results are only comparable within one version. */
export const SOLVER_VERSION = 'chaingrowth-1';
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
export const MAX_LEN = 128;

export function isValidSequence(seq) {
  return typeof seq === 'string' && seq.length >= 3 && seq.length <= MAX_LEN && /^[HP]+$/.test(seq);
}

export function foldToCoords(fold) {
  const coords = [[0, 0]];
  let x = 0, y = 0;
  for (const ch of fold) {
    const d = DIR_CHARS.indexOf(ch);
    if (d < 0) return null;
    x += DX[d];
    y += DY[d];
    coords.push([x, y]);
  }
  return coords;
}

const cellKey = (x, y) => (x + 512) * 2048 + (y + 512);

/** Cheap O(n) verification: is the fold self-avoiding, and how many H-H contacts does it have? */
export function evaluateFold(sequence, fold) {
  if (!isValidSequence(sequence)) return { valid: false, error: 'invalid sequence' };
  if (typeof fold !== 'string' || fold.length !== sequence.length - 1) {
    return { valid: false, error: 'fold length must equal sequence length - 1' };
  }
  const coords = foldToCoords(fold);
  if (!coords) return { valid: false, error: 'fold may only contain R, U, L, D' };
  const occ = new Map();
  for (let i = 0; i < coords.length; i++) {
    const k = cellKey(coords[i][0], coords[i][1]);
    if (occ.has(k)) return { valid: false, error: `chain collides with itself at residue ${i}` };
    occ.set(k, i);
  }
  let contacts = 0;
  const pairs = [];
  for (let i = 0; i < coords.length; i++) {
    if (sequence[i] !== 'H') continue;
    for (let d = 0; d < 4; d++) {
      const j = occ.get(cellKey(coords[i][0] + DX[d], coords[i][1] + DY[d]));
      if (j !== undefined && j > i + 1 && sequence[j] === 'H') {
        contacts++;
        pairs.push([i, j]);
      }
    }
  }
  return { valid: true, contacts, energy: -contacts, coords, pairs };
}

/** mulberry32: tiny, fast, integer-only PRNG. Returns uint32. Deterministic on every JS engine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// Growth bias toward placements that create H-H contacts (index = contacts gained).
const WEIGHTS = [1, 8, 40, 160, 400];

/**
 * Biased Monte Carlo chain-growth search. Each attempt grows the chain residue
 * by residue, preferring moves that create H-H contacts and avoiding dead ends.
 *
 * Returns the best fold plus a full fingerprint of the run (energy histogram,
 * dead-end count and a rolling checksum over every attempt), so that a second
 * device repeating the unit must have done ALL the work to match it.
 */
export function solve(sequence, seed, attempts, { onProgress, progressEvery = 4096 } = {}) {
  if (!isValidSequence(sequence)) throw new Error('invalid sequence');
  const n = sequence.length;
  const H = new Uint8Array(n);
  for (let i = 0; i < n; i++) H[i] = sequence.charCodeAt(i) === 72 ? 1 : 0; // 'H'

  const G = 2 * n + 5;
  const off = n + 2;
  const grid = new Int16Array(G * G).fill(-1);
  const step = [1, G, -1, -G]; // R, U, L, D in cell-index space (cell = y*G + x)
  const pos = new Int32Array(n);
  const dirs = new Uint8Array(n - 1);
  const bestDirs = new Uint8Array(n - 1);
  const w = new Int32Array(4);
  const gain = new Int32Array(4);
  const hist = new Array(n).fill(0);
  const rng = mulberry32(seed);
  const start = off * G + off;

  let best = -1;
  let dead = 0;
  let checksum = 0x811c9dc5;

  for (let a = 0; a < attempts; a++) {
    // Residues 0 and 1 are fixed (0,0) -> (1,0) to remove rotational symmetry.
    grid[start] = 0; pos[0] = start;
    grid[start + 1] = 1; pos[1] = start + 1;
    dirs[0] = 0;
    let placed = 2;
    let contacts = 0;
    let ok = true;

    for (let i = 2; i < n; i++) {
      const p = pos[i - 1];
      let total = 0;
      for (let d = 0; d < 4; d++) {
        const q = p + step[d];
        w[d] = 0;
        if (grid[q] !== -1) continue;
        let c = 0, free = 0;
        for (let e = 0; e < 4; e++) {
          const j = grid[q + step[e]];
          if (j === -1) free++;
          else if (H[i] && j !== i - 1 && H[j]) c++;
        }
        if (free === 0 && i < n - 1) continue; // would trap the chain
        gain[d] = c;
        w[d] = WEIGHTS[c];
        total += w[d];
      }
      if (total === 0) { ok = false; break; }
      let r = rng() % total;
      let d = 0;
      while (r >= w[d]) { r -= w[d]; d++; }
      const q = p + step[d];
      grid[q] = i; pos[i] = q; dirs[i - 1] = d;
      contacts += gain[d];
      placed++;
    }
    for (let k = 0; k < placed; k++) grid[pos[k]] = -1;

    if (ok) {
      hist[contacts]++;
      if (contacts > best) { best = contacts; bestDirs.set(dirs); }
      checksum = Math.imul(checksum ^ (contacts + 1), 16777619) >>> 0;
    } else {
      dead++;
      checksum = Math.imul(checksum ^ 0x9e37, 16777619) >>> 0;
    }

    if (onProgress && (a + 1) % progressEvery === 0) {
      onProgress({ done: a + 1, attempts, bestContacts: best, bestFold: best >= 0 ? dirsToFold(bestDirs) : null });
    }
  }

  let last = hist.length - 1;
  while (last > 0 && hist[last] === 0) last--;
  return {
    solver: SOLVER_VERSION,
    fold: best >= 0 ? dirsToFold(bestDirs) : null,
    contacts: best,
    histogram: hist.slice(0, last + 1),
    dead,
    checksum: checksum.toString(16).padStart(8, '0'),
  };
}

/**
 * Canonical form of a fold, so mirror images count as one structure: rotate so
 * the first move is R, then reflect so the first turn off the x-axis is U.
 */
export function canonicalFold(fold) {
  if (!fold) return fold;
  const rot = DIR_CHARS.indexOf(fold[0]);
  let out = '';
  for (const ch of fold) out += DIR_CHARS[(DIR_CHARS.indexOf(ch) - rot + 4) % 4];
  const firstTurn = out.search(/[UD]/);
  if (firstTurn >= 0 && out[firstTurn] === 'D') out = out.replace(/[UD]/g, (c) => (c === 'U' ? 'D' : 'U'));
  return out;
}

function dirsToFold(dirs) {
  let s = '';
  for (let i = 0; i < dirs.length; i++) s += DIR_CHARS[dirs[i]];
  return s;
}

/** Map an amino-acid sequence onto the HP alphabet (hydrophobic -> H). Illustrative mapping. */
export function aminoToHP(aa) {
  return aa.toUpperCase().replace(/[^A-Z]/g, '').replace(/./g, (c) => ('AVILMFWC'.includes(c) ? 'H' : 'P'));
}
