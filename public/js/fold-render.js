import { evaluateFold } from '../shared/hp.js';

const DEFAULTS = {
  h: '#ff7a59',
  p: '#6fd3c5',
  bond: 'rgba(200, 210, 240, 0.55)',
  contact: 'rgba(255, 122, 89, 0.75)',
  bg: '#0e1528',
  maxCell: 26,
  pad: 10,
};

/** Draw a 2D HP fold on a canvas: H = filled coral, P = hollow teal, dashed lines = H-H contacts. */
export function drawFold(canvas, sequence, fold, options = {}) {
  const o = { ...DEFAULTS, ...options };
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
  if (!fold) return;

  const ev = evaluateFold(sequence, fold);
  if (!ev.valid) return;
  const xs = ev.coords.map((c) => c[0]);
  const ys = ev.coords.map((c) => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cell = Math.min(o.maxCell, (w - 2 * o.pad) / (maxX - minX + 1), (h - 2 * o.pad) / (maxY - minY + 1));
  const ox = (w - (maxX - minX) * cell) / 2;
  const oy = (h - (maxY - minY) * cell) / 2;
  const P = ([x, y]) => [ox + (x - minX) * cell, oy + (maxY - y) * cell];

  // H-H contacts
  ctx.save();
  ctx.setLineDash([Math.max(2, cell * 0.12), Math.max(2, cell * 0.12)]);
  ctx.strokeStyle = o.contact;
  ctx.lineWidth = Math.max(1, cell * 0.08);
  for (const [i, j] of ev.pairs) {
    const [x1, y1] = P(ev.coords[i]);
    const [x2, y2] = P(ev.coords[j]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();

  // Backbone
  ctx.strokeStyle = o.bond;
  ctx.lineWidth = Math.max(1.5, cell * 0.16);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ev.coords.forEach((c, i) => {
    const [x, y] = P(c);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();

  // Residues
  const r = Math.max(2, cell * 0.3);
  ev.coords.forEach((c, i) => {
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
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}
