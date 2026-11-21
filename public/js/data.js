import { api, fmt, esc, API_BASE } from './client.js';
import { drawFold } from './fold-render.js';

const $ = (id) => document.getElementById(id);
const BAR = '#0a6b52'; // site accent; passes the lightness band and 3:1 contrast on white
let summary = null;
let selected = new URLSearchParams(location.search).get('benchmark');

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function compact(n) {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function tiles() {
  const t = summary.totals;
  const items = [
    ['Validated units archived', fmt.format(t.validatedUnits)],
    ['Conformations in dataset', fmt.format(t.conformations)],
    ['Archive size', bytes(summary.archiveBytes)],
    ['Solver version', summary.solver],
    ['Replicas per unit', summary.validation.match(/\d+/)[0]],
  ];
  $('tiles').innerHTML = items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function selector() {
  const sel = $('bench');
  sel.innerHTML = summary.benchmarks
    .map((b) => `<option value="${esc(b.id)}">${esc(b.name)} (${b.units} units)</option>`)
    .join('');
  if (!summary.benchmarks.some((b) => b.id === selected)) {
    selected = (summary.benchmarks.find((b) => b.units > 0) || summary.benchmarks[0]).id;
  }
  sel.value = selected;
  sel.onchange = () => {
    selected = sel.value;
    history.replaceState(null, '', `?benchmark=${encodeURIComponent(selected)}`);
    renderBenchmark();
  };
}

/** Single-series column chart, log y. Hover gives the exact count; table view below. */
function chart(b) {
  const host = $('chart');
  const hist = b.histogram;
  if (!hist.length) {
    host.innerHTML = '<p class="muted small">No validated units yet. Start a volunteer to fill this in.</p>';
    $('table').innerHTML = '';
    return;
  }
  const W = host.clientWidth || 520;
  const H = 240;
  const m = { t: 12, r: 8, b: 34, l: 48 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = Math.max(hist.length, (b.bestKnown ?? 0) + 1);
  const band = iw / n;
  const bw = Math.min(24, band * 0.72);
  const maxV = Math.max(...hist);
  const top = Math.ceil(Math.log10(Math.max(10, maxV)));
  const y = (v) => (v <= 0 ? ih : ih - (Math.log10(Math.max(1, v)) / top) * ih);

  let grid = '';
  for (let p = 0; p <= top; p++) {
    const yy = m.t + y(10 ** p);
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" class="grid"/>`;
    grid += `<text x="${m.l - 8}" y="${yy + 4}" text-anchor="end" class="tick">${compact(10 ** p)}</text>`;
  }

  let bars = '';
  let xs = '';
  const step = Math.ceil(n / 16);
  for (let i = 0; i < n; i++) {
    const v = hist[i] || 0;
    const cx = m.l + band * i + band / 2;
    if (v > 0) {
      const y0 = m.t + ih;
      const y1 = m.t + y(v);
      const r = Math.min(4, bw / 2, y0 - y1);
      const x0 = cx - bw / 2;
      bars += `<path d="M${x0},${y0} V${y1 + r} Q${x0},${y1} ${x0 + r},${y1} H${x0 + bw - r} Q${x0 + bw},${y1} ${x0 + bw},${y1 + r} V${y0} Z" fill="${BAR}"/>`;
    }
    bars += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
    if (i % step === 0 || i === n - 1) xs += `<text x="${cx}" y="${H - m.b + 16}" text-anchor="middle" class="tick">${i}</text>`;
  }

  let ref = '';
  if (b.bestKnown != null) {
    const cx = m.l + band * b.bestKnown + band / 2;
    ref = `<line x1="${cx}" x2="${cx}" y1="${m.t}" y2="${m.t + ih}" class="ref"/>
           <text x="${Math.min(cx, W - m.r - 4)}" y="${m.t + 10}" text-anchor="end" dx="-5" class="tick">best known ${b.bestKnown}</text>`;
  }

  host.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Conformations sampled by number of H-H contacts for ${esc(b.name)}">
    ${grid}${ref}${bars}
    <line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}" class="axis"/>
    ${xs}
    <text x="${m.l + iw / 2}" y="${H - 2}" text-anchor="middle" class="tick">H–H contacts</text>
  </svg>`;

  const tip = $('tip');
  const total = hist.reduce((a, v) => a + v, 0);
  host.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('mouseenter', () => r.classList.add('on'));
    r.addEventListener('mousemove', (e) => {
      const i = Number(r.dataset.i);
      const v = hist[i] || 0;
      tip.hidden = false;
      tip.innerHTML = `<b>${i} contacts</b> (energy ${-i})<br>${fmt.format(v)} conformations<br><span class="muted">${((v / total) * 100).toPrecision(2)}% of completed attempts</span>`;
      const box = host.getBoundingClientRect();
      tip.style.left = `${e.clientX - box.left + 14}px`;
      tip.style.top = `${e.clientY - box.top + host.offsetTop - 10}px`;
    });
    r.addEventListener('mouseleave', () => {
      r.classList.remove('on');
      tip.hidden = true;
    });
  });

  $('table').innerHTML = `<table><thead><tr><th>H–H contacts</th><th>Energy</th><th>Conformations</th></tr></thead><tbody>${hist
    .map((v, i) => (v ? `<tr><td>${i}</td><td>${-i}</td><td class="mono">${fmt.format(v)}</td></tr>` : ''))
    .reverse()
    .join('')}</tbody></table>`;
}

function folds(b) {
  const host = $('folds');
  if (!b.topFolds.length) {
    host.innerHTML = '<p class="muted small">None yet.</p>';
    return;
  }
  host.innerHTML = b.topFolds
    .slice(0, 6)
    .map(
      (f, i) => `<figure class="fold">
        <canvas data-i="${i}"></canvas>
        <figcaption><b style="color:var(--ink)">${f.contacts} contacts</b>, found by ${f.foundBy} unit${f.foundBy > 1 ? 's' : ''}<br>First in ${esc(f.unitId)}</figcaption>
      </figure>`,
    )
    .join('');
  host.querySelectorAll('canvas').forEach((c) => drawFold(c, b.sequence, b.topFolds[c.dataset.i].fold, { maxCell: 12 }));
}

async function record(b) {
  $('benchDownload').href = `${API_BASE}/api/data/validated.jsonl?download&benchmark=${encodeURIComponent(b.id)}`;
  if (!b.units) {
    $('record').textContent = 'No validated units for this sequence yet.';
    return;
  }
  const text = await (await fetch(`${API_BASE}/api/data/validated.jsonl?benchmark=${encodeURIComponent(b.id)}`)).text();
  const last = text.trim().split('\n').pop();
  const rec = JSON.parse(last);
  // Keep the histogram on one line so the record stays readable.
  $('record').textContent = JSON.stringify({ ...rec, histogram: '__H__' }, null, 2).replace('"__H__"', JSON.stringify(rec.histogram));
}

function renderBenchmark() {
  const b = summary.benchmarks.find((x) => x.id === selected);
  $('seqline').innerHTML =
    `${b.amino ? `Amino acids: ${esc(b.amino)}<br>HP model: ` : ''}` +
    b.sequence.replace(/H/g, '<span class="H">H</span>') +
    `<br>${b.sequence.length} residues, ${fmt.format(b.conformations)} conformations sampled, ${fmt.format(b.deadEnds)} dead ends`;
  chart(b);
  folds(b);
  record(b);
}

$('tableToggle').onclick = () => {
  const t = $('table');
  t.hidden = !t.hidden;
  $('tableToggle').setAttribute('aria-expanded', String(!t.hidden));
  $('tableToggle').textContent = t.hidden ? 'Show as a table' : 'Hide the table';
};

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => summary && chart(summary.benchmarks.find((x) => x.id === selected)), 150);
});

// Download links live on the API host, which may differ from this page's host.
for (const a of document.querySelectorAll('[data-api-href]')) a.href = API_BASE + a.dataset.apiHref;

async function citizen() {
  const c = await api('/api/citizen');
  if (!c.enabled || !c.workflow) {
    $('citizenIntro').textContent = 'Citizen-science tasks are disabled or Zooniverse could not be reached.';
    return;
  }
  const w = c.workflow;
  $('citizenIntro').innerHTML =
    `Photo checks ask “${esc(w.question)}” about photos from the live <a href="${esc(w.projectUrl)}" target="_blank" rel="noopener">${esc(w.projectName)}</a> project on Zooniverse (workflow ${esc(w.workflow)}). ` +
    (c.forwarding
      ? 'Counted answers are sent to Zooniverse.'
      : 'Answers are collected here for the research team. Sending them to Zooniverse stays off until the project approves it.');
  const s = c.stats;
  $('citizenTiles').innerHTML = [
    ['Answers collected', s.classifications],
    ['Counted toward consensus', s.counted],
    ['Photos with consensus', s.consensus],
    ['Photos still needing answers', s.open],
    ['Known-answer checks failed', `${s.goldFailures} of ${s.goldChecks}`],
    ['Forwarded to Zooniverse', s.forwarded],
  ]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(typeof v === 'number' ? fmt.format(v) : v)}</dd></div>`)
    .join('');
  $('subjects').innerHTML =
    c.recent
      .map((r) => {
        const max = Math.max(1, ...r.votes);
        const bars = w.answers
          .map((a, i) => `<div><span>${esc(a)}</span><span class="track"><i style="width:${(r.votes[i] / max) * 100}%"></i></span><b>${r.votes[i]}</b></div>`)
          .join('');
        const status = r.status === 'consensus' ? `consensus: ${esc(w.answers[r.consensus])}` : r.status === 'ambiguous' ? 'ambiguous' : `${r.counted} answer${r.counted > 1 ? 's' : ''} so far`;
        return `<figure class="subject"><img src="${esc(r.image.replace("large", "small"))}" alt="Photo ${esc(r.id)}" loading="lazy" /><div class="votes">${bars}</div><figcaption class="muted" style="margin-top:4px">Photo ${esc(r.id)}: ${status}</figcaption></figure>`;
      })
      .join('') || '<p class="muted small">No answers yet. Try the classify CAPTCHA on the demo page.</p>';
}
citizen().catch(() => ($('citizenIntro').textContent = 'Could not load citizen-science data.'));

summary = await api('/api/data/summary.json');
tiles();
selector();
renderBenchmark();
