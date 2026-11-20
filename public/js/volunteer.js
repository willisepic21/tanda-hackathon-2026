import { api, withDevice, getDeviceToken, isMobile, createWorker, runJob, fmt, esc } from './client.js';
import { drawFold } from './fold-render.js';

const $ = (id) => document.getElementById(id);
const mobile = isMobile();
const cores = navigator.hardwareConcurrency || 4;

const threadsInput = $('threads');
threadsInput.max = Math.max(1, Math.min(16, cores));
threadsInput.value = mobile ? 1 : Math.min(2, cores);
$('threadsVal').textContent = threadsInput.value;
threadsInput.oninput = () => ($('threadsVal').textContent = threadsInput.value);
$('mobileNote').hidden = !mobile;
$('simulate').checked = new URLSearchParams(location.search).has('simulate');

let running = false;
let session = 0;
const totals = { units: 0, conformations: 0, validated: 0 };
const active = []; // { worker, cancel }

getDeviceToken({ label: 'volunteer' }).then((t) => {
  const id = JSON.parse(atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).d;
  $('whoami').textContent = `This browser is device ${id.slice(0, 6)}.`;
});

$('toggle').onclick = () => (running ? stop() : start());

function start() {
  running = true;
  const mySession = ++session;
  $('toggle').textContent = 'Stop';
  $('toggle').classList.add('stop');
  threadsInput.disabled = $('simulate').disabled = true;
  $('log').innerHTML = '';
  const n = Number(threadsInput.value);
  $('threadCards').innerHTML = Array.from(
    { length: n },
    (_, i) => `<div class="thread" id="t${i}">
      <h3>Thread ${i + 1} <span class="muted who" style="font-weight:400"></span></h3>
      <canvas aria-label="Current fold on thread ${i + 1}"></canvas>
      <div class="bar"><i></i></div>
      <div class="state status">Starting</div>
    </div>`,
  ).join('');
  for (let i = 0; i < n; i++) loop(i, mySession);
}

function stop() {
  running = false;
  session++;
  for (const a of active.splice(0)) {
    a.cancel?.();
    a.worker.terminate();
  }
  $('toggle').textContent = 'Start contributing';
  $('toggle').classList.remove('stop');
  threadsInput.disabled = $('simulate').disabled = false;
  document.querySelectorAll('.thread .status').forEach((el) => (el.textContent = 'Stopped'));
}

async function loop(i, mySession) {
  const card = $(`t${i}`);
  const canvas = card.querySelector('canvas');
  const status = card.querySelector('.status');
  const bar = card.querySelector('.bar i');
  const simulate = $('simulate').checked;
  // Simulated devices live in sessionStorage so each tab/thread is a fresh identity.
  const identity = simulate
    ? { key: `foldpass-sim-${i}`, storage: sessionStorage, label: `sim-${i + 1}` }
    : { key: 'foldpass-device', storage: localStorage, label: 'volunteer' };
  const slot = { worker: createWorker() };
  active.push(slot);

  while (running && session === mySession) {
    try {
      const work = await withDevice(identity, async (deviceToken) => {
        const payload = JSON.parse(atob(deviceToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
        card.querySelector('.who').textContent = `device ${payload.d.slice(0, 6)}`;
        return api('/api/work', { deviceToken, mobile });
      });
      if (!running || session !== mySession) break;
      const { unit } = work;
      status.textContent = `Folding ${unit.id}, ${fmt.format(unit.attempts)} attempts`;

      const job = runJob(slot.worker, { unit }, (p) => {
        bar.style.width = `${Math.round(p.fraction * 100)}%`;
        if (p.bestFold) drawFold(canvas, unit.sequence, p.bestFold, { maxCell: 14 });
      });
      slot.cancel = job.cancel;
      const out = await job.promise;
      drawFold(canvas, unit.sequence, out.result.fold, { maxCell: 14 });

      const res = await api('/api/result', { lease: work.lease, result: out.result });
      totals.units++;
      totals.conformations += unit.attempts;
      if (res.status === 'validated') totals.validated++;
      $('totals').textContent = `${fmt.format(totals.units)} units, ${fmt.format(totals.conformations)} conformations, ${totals.validated} validated`;

      const what =
        res.status === 'validated'
          ? '<span class="agree">Validated</span>: matched another device.'
          : res.status === 'disputed'
            ? '<span class="disagree">Disputed</span>: sent to a third device.'
            : 'Waiting for a second device.';
      status.textContent = `${unit.id}: ${res.contacts} contacts in ${(out.result.ms / 1000).toFixed(2)} s`;
      log(`Thread ${i + 1} folded <b>${esc(unit.id)}</b> to ${res.contacts} contacts. ${what}`);
    } catch (err) {
      if (err.cancelled || !running) break;
      status.textContent = `Error: ${err.message}. Retrying.`;
      log(`Thread ${i + 1}: <span class="disagree">${esc(err.message)}</span>. Retrying in 2 seconds.`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function log(html) {
  const li = document.createElement('li');
  li.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour12: false })}</time><span>${html}</span>`;
  $('log').prepend(li);
  while ($('log').children.length > 80) $('log').lastChild.remove();
}
