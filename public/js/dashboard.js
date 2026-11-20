import { api, fmt, esc } from './client.js';
import { drawFold } from './fold-render.js';

const $ = (id) => document.getElementById(id);
const drawn = new Map(); // benchmark id -> fold last drawn (avoid redrawing every poll)
const CPU_DOLLARS_PER_HOUR = 0.04; // rough on-demand price of one cloud vCPU-hour

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ago = (t, now) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

function tiles(d) {
  const s = d.stats;
  const items = [
    ['Conformations sampled', fmt.format(s.conformations), true],
    ['Compute donated', duration(s.cpuMs)],
    ['Units validated (2 devices agree)', fmt.format(d.units.validated), true],
    ['Awaiting 2nd device', fmt.format(d.units.awaitingReplica)],
    ['Disputed → tie-breaker', fmt.format(d.units.disputed)],
    ['Devices (active / total)', `${s.activeDevices} / ${s.devices}`],
    ['CAPTCHAs passed / failed', `${fmt.format(s.captchaPassed)} / ${fmt.format(s.captchaFailed)}`],
    ['Invalid results rejected', fmt.format(s.resultsRejected)],
    ['Known-answer checks (failed)', `${fmt.format(s.knownAnswerChecks)} (${s.knownAnswerFailures})`],
  ];
  $('tiles').innerHTML = items
    .map(([k, v, hl]) => `<div class="tile${hl ? ' hl' : ''}"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`)
    .join('');
}

function units(d) {
  if (!d.recentUnits.length) return;
  const rep = (r) => {
    if (!r) return '<span class="rep"><span class="wait">waiting…</span></span>';
    const mark = r.agrees === true ? '<span class="ok">✓</span>' : r.agrees === false ? '<span class="no">✗</span>' : '';
    return `<span class="rep">${esc(r.device)} · ${r.contacts}c · #${esc(r.checksum.slice(0, 6))} ${mark}</span>`;
  };
  $('units').innerHTML = d.recentUnits
    .map((u) => {
      const extra = u.replicas.length > 2 ? `<div class="rep muted">+${u.replicas.length - 2} tie-breaker</div>` : '';
      const audits = u.audits ? ` <span class="muted small">+${u.audits} spot-check${u.audits > 1 ? 's' : ''}</span>` : '';
      return `<tr>
        <td class="mono">${esc(u.id)}</td>
        <td>${rep(u.replicas[0])}</td>
        <td>${rep(u.replicas[1])}${extra}</td>
        <td><span class="badge ${esc(u.status)}">${esc(u.status)}</span>${audits}</td>
      </tr>`;
    })
    .join('');
}

const FEED_TEXT = {
  validated: (e) => `✅ <b>${esc(e.unitId)}</b> validated by ${esc(e.devices?.join(' + '))}: ${e.contacts} contacts`,
  replica: (e) => `🧬 ${esc(e.deviceId)} returned <b>${esc(e.unitId)}</b> (${e.contacts} contacts), awaiting second device`,
  disputed: (e) => `⚠️ <b>${esc(e.unitId)}</b>: replicas disagree, sending to a tie-breaker`,
  inconclusive: (e) => `⛔ <b>${esc(e.unitId)}</b> inconclusive, dropped`,
  rejected: (e) => `🚫 ${esc(e.deviceId)} rejected on ${esc(e.unitId)}: ${esc(e.reason)}`,
  'known-ok': (e) => `🎯 ${esc(e.deviceId)} passed a known-answer check on ${esc(e.unitId)}`,
  'known-fail': (e) => `🎯 ${esc(e.deviceId)} <b>failed</b> a known-answer check on ${esc(e.unitId)}`,
  'new-best': (e) => `🏆 New best for <b>${esc(e.benchmarkId)}</b>: ${e.contacts} contacts`,
};

function feed(d) {
  $('feed').innerHTML =
    d.feed.map((e) => `<li><time>${ago(e.at, d.now)}</time><span>${(FEED_TEXT[e.type] || (() => esc(e.type)))(e)}</span></li>`).join('') ||
    '<li class="muted">Nothing yet.</li>';
}

function benches(d) {
  const host = $('benches');
  if (!host.children.length) {
    host.innerHTML = d.benchmarks
      .map(
        (b) => `<div class="bench" id="b-${esc(b.id)}">
          <div class="name">${esc(b.name)}</div>
          <div class="seq">${b.sequence.replace(/H/g, '<span class="H">H</span>')}</div>
          <canvas></canvas>
          <div class="small stat"></div>
          <div class="meter"><i></i></div>
        </div>`,
      )
      .join('');
  }
  for (const b of d.benchmarks) {
    const el = document.getElementById(`b-${b.id}`);
    const best = b.best?.contacts ?? 0;
    const lit = b.bestKnown ? ` / ${b.bestKnown} best known` : ' (no published optimum)';
    el.querySelector('.stat').innerHTML =
      `<b>${b.best ? best : '–'}</b> contacts${esc(lit)} <span class="muted">· ${b.validatedUnits} units · ${b.tier}</span>`;
    el.querySelector('.meter i').style.width = b.bestKnown ? `${Math.min(100, (best / b.bestKnown) * 100)}%` : b.best ? '100%' : '0%';
    if (b.best && drawn.get(b.id) !== b.best.fold) {
      drawFold(el.querySelector('canvas'), b.sequence, b.best.fold, { maxCell: 16 });
      drawn.set(b.id, b.best.fold);
    }
  }
}

function devices(d) {
  $('devices').innerHTML =
    d.devices
      .map(
        (v) => `<tr>
          <td><span class="dot${v.active ? ' on' : ''}"></span></td>
          <td class="mono">${esc(v.id)} <span class="muted">${esc(v.label)}</span></td>
          <td class="mono" style="color:${v.trust < 0 ? 'var(--bad)' : 'inherit'}">${v.trust}</td>
          <td>${v.agreed}</td><td>${v.disagreed}</td><td>${v.rejected}</td>
          <td class="mono">${fmt.format(v.conformations)}</td>
        </tr>`,
      )
      .join('') || '<tr><td colspan="7" class="muted">No devices yet.</td></tr>';
}

function economics(d) {
  const s = d.stats;
  const avgMs = s.captchaPassed ? s.captchaMsTotal / s.captchaPassed : null;
  if (!avgMs) {
    $('economics').innerHTML = '<p class="muted">Solve a CAPTCHA on the demo page to measure the real per-solve cost.</p>';
    return;
  }
  const perMillionHours = (avgMs * 1e6) / 3.6e6;
  const dollars = perMillionHours * CPU_DOLLARS_PER_HOUR;
  $('economics').innerHTML = `
    <table>
      <tr><td>Average solve time (client-reported)</td><td class="mono">${(avgMs / 1000).toFixed(2)} s</td></tr>
      <tr><td>Human cost</td><td>${(avgMs / 1000).toFixed(1)} s once per sign-up, no puzzle to squint at</td></tr>
      <tr><td>Bot cost per 1M solves</td><td class="mono">${fmt.format(Math.round(perMillionHours))} CPU-hours ≈ $${fmt.format(Math.round(dollars))}</td></tr>
      <tr><td>Science per 1M solves</td><td class="mono">${fmt.format(Math.round((s.conformations / Math.max(1, s.resultsAccepted)) * 1e6 / 2))} replicated conformations</td></tr>
    </table>
    <p class="muted" style="margin-top:10px">That's cheap for a determined bot farm (at ~$${CPU_DOLLARS_PER_HOUR}/vCPU-hour), so PoW alone isn't a wall.
    It's a cost floor to pair with rate limits and risk signals. The upside: even bots that pay it end up doing replicated, verified folding work.</p>`;
}

async function tick() {
  try {
    const d = await api('/api/stats');
    tiles(d);
    units(d);
    feed(d);
    benches(d);
    devices(d);
    economics(d);
    $('live').innerHTML = '<span class="dot on"></span> live';
  } catch {
    $('live').innerHTML = '<span class="dot"></span> offline';
  }
  setTimeout(tick, 1500);
}
tick();
