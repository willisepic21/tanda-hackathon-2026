import { api, fmt, esc } from './client.js';
import { drawFold } from './fold-render.js';

const $ = (id) => document.getElementById(id);
const drawn = new Map(); // benchmark id -> fold last drawn (avoid redrawing every poll)
const CPU_DOLLARS_PER_HOUR = 0.04; // rough on-demand price of one cloud vCPU-hour

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const ago = (t, now) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function figures(d) {
  const s = d.stats;
  const items = [
    ['Conformations sampled', fmt.format(s.conformations)],
    ['Units validated', fmt.format(d.units.validated)],
    ['Waiting for a second device', fmt.format(d.units.awaitingReplica)],
    ['Devices active now', `${s.activeDevices} of ${s.devices}`],
    ['CAPTCHAs passed', fmt.format(s.captchaPassed)],
    ['Compute donated', duration(s.cpuMs)],
  ];
  $('figures').innerHTML = items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function units(d) {
  if (!d.recentUnits.length) return;
  const rep = (r) => {
    if (!r) return '<span class="muted">Waiting</span>';
    const mark = r.agrees === true ? ' <span class="agree">matches</span>' : r.agrees === false ? ' <span class="disagree">differs</span>' : '';
    return `${esc(r.device)}, ${r.contacts} contacts${mark}`;
  };
  $('units').innerHTML = d.recentUnits
    .map((u) => {
      const extra = u.replicas.length > 2 ? `<div class="small muted">plus ${u.replicas.length - 2} tie-breaker</div>` : '';
      const audits = u.audits ? `<div class="small muted">${u.audits} spot check${u.audits > 1 ? 's' : ''}</div>` : '';
      return `<tr>
        <td>${esc(u.id)}</td>
        <td>${rep(u.replicas[0])}</td>
        <td>${rep(u.replicas[1])}${extra}</td>
        <td><span class="status ${esc(u.status)}">${esc(u.status[0].toUpperCase() + u.status.slice(1))}</span>${audits}</td>
      </tr>`;
    })
    .join('');
}

const FEED_TEXT = {
  validated: (e) => `<b>${esc(e.unitId)}</b> validated by ${esc(e.devices?.join(' and '))}: ${e.contacts} contacts.`,
  replica: (e) => `${esc(e.deviceId)} returned <b>${esc(e.unitId)}</b> with ${e.contacts} contacts. Waiting for a second device.`,
  disputed: (e) => `<b>${esc(e.unitId)}</b>: results disagree, sent to a third device.`,
  inconclusive: (e) => `<b>${esc(e.unitId)}</b> dropped after repeated disagreement.`,
  rejected: (e) => `Rejected a result from ${esc(e.deviceId)} on ${esc(e.unitId)}: ${esc(e.reason)}.`,
  'known-ok': (e) => `${esc(e.deviceId)} passed a spot check on ${esc(e.unitId)}.`,
  'known-fail': (e) => `${esc(e.deviceId)} <b>failed</b> a spot check on ${esc(e.unitId)}.`,
  'new-best': (e) => `New best fold for <b>${esc(e.benchmarkId)}</b>: ${e.contacts} contacts.`,
};

function feed(d) {
  $('feed').innerHTML =
    d.feed.map((e) => `<li><time>${ago(e.at, d.now)}</time><span>${(FEED_TEXT[e.type] || (() => esc(e.type)))(e)}</span></li>`).join('') ||
    '<li><span></span><span class="muted">No activity yet.</span></li>';
}

function benches(d) {
  const host = $('benches');
  if (!host.children.length) {
    host.innerHTML = d.benchmarks
      .map((b) => `<figure class="bench" id="b-${esc(b.id)}" style="margin:0"><canvas aria-label="Best fold for ${esc(b.name)}"></canvas><h3>${esc(b.name)}</h3><p class="stat"></p><div class="meter"><i></i></div></figure>`)
      .join('');
  }
  for (const b of d.benchmarks) {
    const el = document.getElementById(`b-${b.id}`);
    const best = b.best?.contacts ?? 0;
    const ref = b.bestKnown ? ` of ${b.bestKnown} best known` : ', no published optimum';
    el.querySelector('.stat').textContent = b.best
      ? `${best} contacts${ref}. ${b.validatedUnits} units, ${b.sequence.length} residues.`
      : `No validated fold yet. ${b.sequence.length} residues.`;
    el.querySelector('.meter').hidden = !b.bestKnown;
    el.querySelector('.meter i').style.width = b.bestKnown ? `${Math.min(100, (best / b.bestKnown) * 100)}%` : '0';
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
          <td><span class="dot${v.active ? ' on' : ''}" title="${v.active ? 'Active' : 'Idle'}"></span> ${esc(v.id)} <span class="muted">${esc(v.label)}</span></td>
          <td class="num${v.trust < 0 ? ' disagree' : ''}">${v.trust}</td>
          <td class="num">${v.agreed}</td><td class="num">${v.disagreed}</td><td class="num">${v.rejected}</td>
          <td class="num">${fmt.format(v.conformations)}</td>
        </tr>`,
      )
      .join('') || '<tr><td colspan="6" class="muted">No devices yet.</td></tr>';
}

function economics(d) {
  const s = d.stats;
  const avgMs = s.captchaPassed ? s.captchaMsTotal / s.captchaPassed : null;
  if (!avgMs) {
    $('economics').innerHTML = '<p class="muted">Pass a CAPTCHA on the overview page to measure a real solve.</p>';
    return;
  }
  const perMillionHours = (avgMs * 1e6) / 3.6e6;
  $('economics').innerHTML = `
    <table>
      <tr><td>Average solve, measured</td><td class="num">${(avgMs / 1000).toFixed(2)} s</td></tr>
      <tr><td>CPU time for a million solves</td><td class="num">${fmt.format(Math.round(perMillionHours))} hours</td></tr>
      <tr><td>Cloud cost for a million solves</td><td class="num">$${fmt.format(Math.round(perMillionHours * CPU_DOLLARS_PER_HOUR))}</td></tr>
    </table>
    <p class="small muted" style="margin-top:12px">At about $${CPU_DOLLARS_PER_HOUR} per vCPU-hour, proof-of-work alone won't stop a determined bot operator.
    It sets a cost floor to pair with rate limits, and bots that pay it still do checked research work.</p>`;
}

async function tick() {
  try {
    const d = await api('/api/stats');
    figures(d);
    units(d);
    feed(d);
    benches(d);
    devices(d);
    economics(d);
    $('live').innerHTML = '<span class="dot on"></span> Live';
  } catch {
    $('live').innerHTML = '<span class="dot"></span> Offline';
  }
  setTimeout(tick, 2000);
}
tick();
