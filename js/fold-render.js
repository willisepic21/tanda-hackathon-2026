import { evaluateFold } from '../shared/hp.js';

const DEFAULTS = {
  h: '#e4572e',
  p: '#1f8a84',
  bond: 'rgba(60, 68, 76, 0.45)',
  contact: 'rgba(228, 87, 46, 0.75)',
  bg: '#ffffff',
  maxCell: 26,
  pad: 10,
};

function prepare(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * Draw a chain from (possibly fractional) lattice coordinates.
 * H = filled coral, P = hollow teal, dashed lines = H-H contacts (faded by contactAlpha).
 */
export function drawCoords(canvas, sequence, coords, pairs = [], options = {}) {
  const o = { ...DEFAULTS, contactAlpha: 1, ...options };
  const { ctx, w, h } = prepare(canvas);
  if (!coords?.length) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cell = Math.min(o.maxCell, (w - 2 * o.pad) / (maxX - minX + 1), (h - 2 * o.pad) / (maxY - minY + 1));
  const ox = (w - (maxX - minX) * cell) / 2;
  const oy = (h - (maxY - minY) * cell) / 2;
  const P = ([x, y]) => [ox + (x - minX) * cell, oy + (maxY - y) * cell];

  if (pairs.length && o.contactAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = o.contactAlpha;
    ctx.setLineDash([Math.max(2, cell * 0.12), Math.max(2, cell * 0.12)]);
    ctx.strokeStyle = o.contact;
    ctx.lineWidth = Math.max(1, cell * 0.08);
    for (const [i, j] of pairs) {
      const [x1, y1] = P(coords[i]);
      const [x2, y2] = P(coords[j]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.strokeStyle = o.bond;
  ctx.lineWidth = Math.max(1.5, cell * 0.16);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  coords.forEach((c, i) => {
    const [x, y] = P(c);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();

  const r = Math.max(2, cell * 0.3);
  coords.forEach((c, i) => {
    const [x, y] = P(c);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (sequence[i] === 'H') {
      ctx.fillStyle = o.h;
      ctx.fill();
    } else {
      ctx.fillStyle = o.bg;
      ctx.fill();
      ctx.strokeStyle = o.p;
      ctx.lineWidth = Math.max(1, r * 0.4);
      ctx.stroke();
    }
    if (i === 0) {
      ctx.strokeStyle = o.p;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

/** Draw a 2D HP fold (a string of R/U/L/D moves). */
export function drawFold(canvas, sequence, fold, options = {}) {
  if (!fold) return void prepare(canvas);
  const ev = evaluateFold(sequence, fold);
  if (!ev.valid) return void prepare(canvas);
  drawCoords(canvas, sequence, ev.coords, ev.pairs, options);
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Animates a chain folding: it starts fully stretched out and moves smoothly
 * into each new fold handed to setFold(). Residues 0 and 1 are fixed in every
 * fold, so each step reads as the chain rearranging, not jumping.
 */
export class FoldAnimator {
  constructor(canvas, sequence, options = {}) {
    this.canvas = canvas;
    this.sequence = sequence;
    this.options = options;
    this.duration = reducedMotion() ? 0 : (options.duration ?? 420);
    this.current = Array.from({ length: sequence.length }, (_, i) => [i, 0]); // unfolded
    this.from = this.current;
    this.to = this.current;
    this.pairs = [];
    this.fold = null;
    this.start = 0;
    this.raf = 0;
    this.render(1);
  }

  /** Move to a new fold. Returns a promise that resolves when the move finishes. */
  setFold(fold) {
    if (!fold || fold === this.fold) return Promise.resolve();
    const ev = evaluateFold(this.sequence, fold);
    if (!ev.valid) return Promise.resolve();
    this.fold = fold;
    this.from = this.current.map((c) => c.slice());
    this.to = ev.coords;
    this.pairs = ev.pairs;
    this.start = performance.now();
    cancelAnimationFrame(this.raf);
    return new Promise((resolve) => {
      const step = (now) => {
        const t = this.duration ? Math.min(1, (now - this.start) / this.duration) : 1;
        this.render(t);
        if (t < 1) this.raf = requestAnimationFrame(step);
        else resolve();
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  render(t) {
    const e = ease(t);
    this.current = this.to.map(([x, y], i) => [this.from[i][0] + (x - this.from[i][0]) * e, this.from[i][1] + (y - this.from[i][1]) * e]);
    drawCoords(this.canvas, this.sequence, this.current, this.pairs, { ...this.options, contactAlpha: e * e });
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }
}
