// FoldPass browser SDK (ES module).
//
//   import FoldPass from 'https://foldpass-tanda.fly.dev/sdk/foldpass.esm.js';
//   FoldPass.render('#captcha', { siteKey: 'demo-site-key', onSuccess: (token) => … });
//   const token = await FoldPass.execute({ siteKey: 'demo-site-key' });   // invisible
//   const v = FoldPass.volunteer({ threads: 2 }); v.start();               // opt-in donation
//
// Classic <script> users: load /sdk/foldpass.js instead (exposes window.FoldPass).
// The API host is wherever this file was loaded from.

import { api, withDevice, isMobile, createWorker, runJob, API_BASE } from '../js/client.js';
import { FoldAnimator } from '../js/fold-render.js';

export const version = '1.0.0';
export const host = API_BASE;

export class FoldPassError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FoldPassError';
    this.code = code;
  }
}

const wrap = (err) => (err instanceof FoldPassError ? err : new FoldPassError(err.message, err.code || (err.status ? `HTTP_${err.status}` : 'NETWORK')));

// ------------------------------------------------------------------ core: one CAPTCHA solve

/**
 * Request a challenge, run the PoW + folding unit in a Web Worker, submit it.
 * Resolves to { token, expiresIn, unit } (fold) or { token, expiresIn, classify } (classify).
 *
 * task 'classify' asks the visitor a real citizen-science question; it needs
 * `onClassify(classify) => Promise<answers[]>` to show the images (the widget
 * provides this). If the server has no human tasks available it falls back to fold.
 */
export async function solve({ siteKey, task = 'fold', onProgress, onClassify, worker } = {}) {
  if (!siteKey) throw new FoldPassError('siteKey is required', 'BAD_SITE_KEY');
  if (task === 'classify' && !onClassify) throw new FoldPassError('task "classify" needs a visible widget (use render)', 'NEEDS_UI');
  const mobile = isMobile();
  let ch;
  try {
    ch = await withDevice({ label: 'captcha' }, (deviceToken) => api('/api/challenge', { siteKey, deviceToken, mobile, task }));
  } catch (err) {
    throw wrap(err);
  }
  const w = worker || createWorker();

  if (ch.task === 'classify') {
    try {
      const t0 = performance.now();
      // The PoW runs in the background while the visitor answers.
      const pow = runJob(w, { pow: ch.pow }).promise;
      const answers = await onClassify(ch.classify);
      const out = await pow;
      onProgress?.({ phase: 'submit', fraction: 1, overall: 1 });
      const res = await api('/api/solve', { challenge: ch.challenge, nonce: out.nonce, answers, totalMs: Math.round(performance.now() - t0) });
      return { token: res.passToken, expiresIn: res.expiresIn, classify: { ...res.classify, source: ch.classify.source } };
    } catch (err) {
      throw wrap(err);
    } finally {
      if (!worker) w.terminate();
    }
  }

  const { unit } = ch;
  try {
    const { promise } = runJob(w, { unit, pow: ch.pow }, (p) =>
      onProgress?.({ ...p, unit, overall: p.phase === 'pow' ? p.fraction * 0.3 : 0.3 + p.fraction * 0.7 }),
    );
    const out = await promise;
    onProgress?.({ phase: 'submit', fraction: 1, overall: 1, unit, bestFold: out.result.fold, bestContacts: out.result.contacts });
    const res = await api('/api/solve', { challenge: ch.challenge, nonce: out.nonce, result: out.result, totalMs: out.totalMs });
    return {
      token: res.passToken,
      expiresIn: res.expiresIn,
      unit: { ...res.unit, benchmarkId: unit.benchmarkId, sequence: unit.sequence, fold: out.result.fold, ms: out.totalMs },
    };
  } catch (err) {
    throw wrap(err);
  } finally {
    if (!worker) w.terminate();
  }
}

/** Invisible mode: no UI. `FoldPass.execute('site-key')` or `execute({ siteKey, onProgress })`. */
export async function execute(opts) {
  const o = typeof opts === 'string' ? { siteKey: opts } : opts || {};
  return (await solve(o)).token;
}

// ------------------------------------------------------------------ visible widget
//
// A conventional checkbox CAPTCHA: a 300×76 frame with the checkbox, label and
// brand. In classify mode, a challenge panel opens below it with the research
// question, the photo, the answers and Verify.

const MARK = `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
  <path d="M6 22 V14 H14 V6 H22 V14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity=".45"/>
  <circle cx="6" cy="22" r="3.4" fill="var(--fp-h)"/><circle cx="6" cy="14" r="3.2" fill="var(--fp-frame)" stroke="var(--fp-p)" stroke-width="1.8"/>
  <circle cx="14" cy="14" r="3.4" fill="var(--fp-h)"/><circle cx="14" cy="6" r="3.2" fill="var(--fp-frame)" stroke="var(--fp-p)" stroke-width="1.8"/>
  <circle cx="22" cy="6" r="3.4" fill="var(--fp-h)"/><circle cx="22" cy="14" r="3.4" fill="var(--fp-h)"/>
</svg>`;

const ICON_REFRESH = `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M15.5 6.5A6.5 6.5 0 1 0 16.5 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16 2.8v4.2h-4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_INFO = `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6.3" r="1.1" fill="currentColor"/></svg>`;

const STYLES = `
:host {
  --fp-frame:#fafbfa; --fp-border:#d3d8d6; --fp-text:#1f2429; --fp-muted:#5f676f; --fp-box:#ffffff; --fp-box-border:#b9c0c4;
  --fp-accent:#0a6b52; --fp-accent-ink:#ffffff; --fp-ok:#0a7d4f; --fp-bad:#c42b2b; --fp-well:#eef1ef; --fp-h:#e4572e; --fp-p:#1f8a84;
  display:inline-block; position:relative; font:14px/1.3 "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif; color:var(--fp-text);
}
:host([theme="dark"]) {
  --fp-frame:#25292d; --fp-border:#41474d; --fp-text:#eceff1; --fp-muted:#a8b0b7; --fp-box:#1b1e21; --fp-box-border:#6b737a;
  --fp-accent:#3fb88f; --fp-accent-ink:#0d1f19; --fp-ok:#4cc995; --fp-bad:#ff7a7a; --fp-well:#1b1e21;
}
.frame { box-sizing:border-box; width:300px; height:76px; display:flex; align-items:center; gap:12px; padding:0 10px 0 13px;
  background:var(--fp-frame); border:1px solid var(--fp-border); border-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
.check { flex:none; width:28px; height:28px; padding:0; margin:0; border:2px solid var(--fp-box-border); border-radius:3px; background:var(--fp-box);
  cursor:pointer; display:grid; place-items:center; transition:border-color .12s; }
.check:hover:not([aria-disabled="true"]) { border-color:var(--fp-muted); }
.check:focus-visible { outline:2px solid var(--fp-accent); outline-offset:2px; }
.check[aria-disabled="true"] { cursor:default; }
:host([state="working"]) .check { border-color:transparent; background:transparent; }
:host([state="done"]) .check { border-color:transparent; background:transparent; }
:host([state="error"]) .check { border-color:var(--fp-bad); }
.spin { width:24px; height:24px; border-radius:50%; border:3px solid color-mix(in srgb, var(--fp-accent) 22%, transparent); border-top-color:var(--fp-accent); animation:spin .7s linear infinite; box-sizing:border-box; }
@keyframes spin { to { transform:rotate(360deg); } }
.tick path { stroke:var(--fp-ok); stroke-width:3.2; fill:none; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:30; stroke-dashoffset:30; animation:draw .32s ease-out forwards; }
@keyframes draw { to { stroke-dashoffset:0; } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration:2s; } .tick path { animation:none; stroke-dashoffset:0; } }
.label { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; }
.label .text { font-size:14.5px; }
.label .status { font-size:11px; color:var(--fp-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-height:14px; }
:host([state="error"]) .label .status { color:var(--fp-bad); }
.brand { flex:none; width:64px; display:flex; flex-direction:column; align-items:center; gap:1px; color:var(--fp-muted); text-decoration:none; }
.brand .name { font-size:10px; font-weight:600; letter-spacing:.01em; color:var(--fp-text); }
.brand .links { font-size:8px; display:flex; gap:5px; }
.brand .links a { color:var(--fp-muted); text-decoration:none; }
.brand .links a:hover { text-decoration:underline; }

.pop { position:absolute; left:0; top:calc(100% + 6px); z-index:2147483000; box-sizing:border-box; width:340px; max-width:calc(100vw - 16px);
  background:var(--fp-box); border:1px solid var(--fp-border); border-radius:4px; box-shadow:0 6px 24px rgba(0,0,0,.2); overflow:hidden; }
.pop[hidden], .about[hidden] { display:none; }
.stage { background:var(--fp-box); height:230px; border-bottom:1px solid var(--fp-border); }
.stage canvas { width:100%; height:100%; display:block; }
.fstat { display:flex; justify-content:space-between; gap:12px; padding:10px 12px 6px; font-size:13px; }
.fstat .fpct { color:var(--fp-muted); font-variant-numeric:tabular-nums; }
.fbar { height:4px; background:var(--fp-well); margin:0 12px 10px; border-radius:2px; overflow:hidden; }
.fbar i { display:block; height:100%; width:0; background:var(--fp-accent); }
.folding .fnote { font-size:11px; color:var(--fp-muted); padding:0 12px 12px; }
.folding .key { display:flex; gap:12px; padding:0 12px 8px; font-size:11px; color:var(--fp-muted); }
.folding .key span { display:inline-flex; align-items:center; gap:5px; }
.folding .key i { width:8px; height:8px; border-radius:50%; display:inline-block; }
.head { background:var(--fp-accent); color:var(--fp-accent-ink); padding:12px 14px 13px; }
.head .for { font-size:12px; opacity:.85; }
.head .q { font-size:18px; font-weight:600; line-height:1.25; margin-top:2px; }
.photo { position:relative; background:var(--fp-well); height:230px; }
.photo img { width:100%; height:100%; object-fit:contain; display:block; }
.photo .count:empty { display:none; }
.photo .count { position:absolute; right:8px; top:8px; font-size:11px; background:rgba(0,0,0,.55); color:#fff; padding:2px 7px; border-radius:10px; }
.answers { display:flex; gap:6px; padding:10px 12px 4px; }
.answers button { flex:1; min-height:38px; border:1px solid var(--fp-border); background:var(--fp-frame); color:var(--fp-text); border-radius:3px; font:inherit; cursor:pointer; }
.answers button:hover { border-color:var(--fp-muted); }
.answers button[aria-pressed="true"] { background:var(--fp-accent); border-color:var(--fp-accent); color:var(--fp-accent-ink); font-weight:600; }
.answers button:focus-visible, .foot button:focus-visible { outline:2px solid var(--fp-accent); outline-offset:1px; }
.src { font-size:11px; color:var(--fp-muted); padding:2px 12px 8px; }
.src a { color:inherit; }
.foot { display:flex; align-items:center; gap:2px; border-top:1px solid var(--fp-border); padding:8px 10px 8px 6px; }
.foot .icon { width:34px; height:34px; display:grid; place-items:center; border:0; background:none; color:var(--fp-muted); cursor:pointer; border-radius:3px; }
.foot .icon:hover { color:var(--fp-text); background:var(--fp-well); }
.foot .verify { margin-left:auto; min-width:92px; height:36px; border:0; border-radius:3px; background:var(--fp-accent); color:var(--fp-accent-ink); font:inherit; font-weight:600; cursor:pointer; }
.foot .verify:disabled { opacity:.45; cursor:not-allowed; }
.about { font-size:12px; line-height:1.45; color:var(--fp-muted); padding:10px 14px; border-top:1px solid var(--fp-border); }
.about p { margin:0 0 6px; }
.about p:last-child { margin:0; }
`;

const STATUS_IDLE = '';

export class FoldCaptchaElement extends HTMLElement {
  static get observedAttributes() {
    return ['theme'];
  }

  /** Callbacks set by render(); attribute users listen for DOM events instead. */
  options = {};

  get task() {
    return this.getAttribute('task') || this.options.task || 'fold';
  }

  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="frame" part="frame">
        <div class="check" part="checkbox" role="checkbox" tabindex="0" aria-checked="false" aria-labelledby="lbl"></div>
        <div class="label">
          <span class="text" id="lbl">I'm human</span>
          <span class="status" aria-live="polite"></span>
        </div>
        <div class="brand">
          <a href="${API_BASE}/" target="_blank" rel="noopener" style="color:inherit;display:flex;flex-direction:column;align-items:center;text-decoration:none" aria-label="About FoldPass">
            ${MARK}<span class="name">FoldPass</span>
          </a>
          <span class="links"><a href="${API_BASE}/#privacy" target="_blank" rel="noopener">Privacy</a><a href="${API_BASE}/data" target="_blank" rel="noopener">Data</a></span>
        </div>
      </div>
      <div class="pop folding" part="folding" role="status" hidden>
        <div class="head"><div class="for">Your device is folding a protein</div><div class="q fname"></div></div>
        <div class="stage"><canvas aria-label="The protein chain as it folds"></canvas></div>
        <div class="fstat"><span class="fbest">Preparing</span><span class="fpct"></span></div>
        <div class="fbar"><i></i></div>
        <div class="key"><span><i style="background:var(--fp-h)"></i>Hydrophobic</span><span><i style="border:2px solid var(--fp-p);width:5px;height:5px"></i>Polar</span></div>
        <div class="fnote">A second device repeats this search. The result is kept only if both match.</div>
      </div>
      <div class="pop challenge" part="challenge" role="dialog" aria-modal="false" aria-labelledby="q" hidden>
        <div class="head"><div class="for"></div><div class="q" id="q"></div></div>
        <div class="photo"><img alt="" /><span class="count"></span></div>
        <div class="answers" role="group" aria-label="Answers"></div>
        <div class="src"></div>
        <div class="about" hidden>
          <p>This photo comes from a live research project on Zooniverse, the citizen-science platform. One photo in each check already has a known answer, and that is what verifies you. The other still needs answers from people, and yours is added to the project's results.</p>
          <p>Your device also does a short proof-of-work. FoldPass stores an anonymous device ID and nothing else about you.</p>
        </div>
        <div class="foot">
          <button type="button" class="icon refresh" title="Get a different photo" aria-label="Get a different photo">${ICON_REFRESH}</button>
          <button type="button" class="icon info" title="About this check" aria-label="About this check" aria-expanded="false">${ICON_INFO}</button>
          <button type="button" class="verify" disabled>Verify</button>
        </div>
      </div>`;
    this.$ = (s) => root.querySelector(s);
    const box = this.$('.check');
    const start = () => {
      if (box.getAttribute('aria-disabled') === 'true') return;
      this.execute().catch(() => {});
    };
    box.addEventListener('click', start);
    box.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        start();
      }
    });
    this.$('.info').addEventListener('click', () => {
      const about = this.$('.about');
      about.hidden = !about.hidden;
      this.$('.info').setAttribute('aria-expanded', String(!about.hidden));
    });
    this.setState('idle', STATUS_IDLE);
  }

  disconnectedCallback() {
    this.worker?.terminate();
    this.worker = null;
    clearTimeout(this.expiryTimer);
  }

  attributeChangedCallback() {}

  get token() {
    return this._token || null;
  }

  /** Clear the token and return to the unchecked state. */
  reset() {
    clearTimeout(this.expiryTimer);
    this.setToken(null);
    this.closePanel();
    this.setState('idle', STATUS_IDLE);
  }

  setState(state, status) {
    this.setAttribute('state', state);
    const box = this.$('.check');
    box.setAttribute('aria-disabled', String(state === 'working' || state === 'done'));
    box.setAttribute('aria-checked', String(state === 'done'));
    box.innerHTML =
      state === 'working'
        ? '<span class="spin"></span>'
        : state === 'done'
          ? '<svg class="tick" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><path d="M5 14.5l6 6L23 8"/></svg>'
          : '';
    if (status !== undefined) this.$('.status').textContent = status;
  }

  /** Run the CAPTCHA programmatically. Resolves to the pass token. */
  async execute() {
    if (this.inFlight) return this.inFlight;
    const siteKey = this.getAttribute('site-key') || this.options.siteKey;
    this.inFlight = this.run(siteKey).finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  async run(siteKey) {
    this.setState('working', 'Checking…');
    try {
      this.setToken(null);
      this.worker ||= createWorker();
      const res = await solve({
        siteKey,
        task: this.task,
        onClassify: (c) => this.askHuman(c),
        worker: this.worker,
        onProgress: (p) => {
          if (p.phase === 'fold' || p.phase === 'pow') this.$('.status').textContent = `Checking… ${Math.round(p.overall * 100)}%`;
          if (p.unit) this.showFolding(p);
        },
      });
      this.setToken(res.token);
      if (res.unit && this.anim) {
        // Let the visitor see the finished fold, then tuck the panel away.
        this.$('.fbest').textContent = `Folded: ${res.unit.contacts} hydrophobic contacts`;
        this.$('.fpct').textContent = 'Done';
        this.$('.fbar i').style.width = '100%';
        const anim = this.anim;
        anim.setFold(res.unit.fold).then(() => {
          clearTimeout(this.foldCloseTimer);
          this.foldCloseTimer = setTimeout(() => this.anim === anim && this.closePanel(), 1400);
        });
      } else this.closePanel();
      this.setState('done', 'Verified');
      this.$('.check').title = res.classify ? `Your answer was added to ${res.classify.source.name}` : 'Your device folded a protein work unit';
      const detail = res.classify || res.unit;
      this.emit('solved', { token: res.token, unit: res.unit, classify: res.classify });
      this.options.onSuccess?.(res.token, detail);

      clearTimeout(this.expiryTimer);
      this.expiryTimer = setTimeout(() => {
        this.setToken(null);
        this.setState('idle', 'Expired. Check the box again.');
        this.emit('expired', {});
        this.options.onExpired?.();
      }, Math.max(1000, res.expiresIn - 5000));
      return res.token;
    } catch (err) {
      const e = wrap(err);
      if (e.code === 'REFRESH') return this.run(siteKey);
      this.closePanel();
      if (e.code === 'CANCELLED') {
        this.setState('idle', STATUS_IDLE);
        throw e;
      }
      this.setState('error', friendly(e));
      this.emit('error', { message: e.message, code: e.code });
      this.options.onError?.(e);
      throw e;
    }
  }

  closePanel() {
    clearTimeout(this.foldCloseTimer);
    this.anim?.stop();
    this.anim = null;
    this.$('.folding').hidden = true;
    const pop = this.$('.challenge');
    if (pop.hidden) return;
    pop.hidden = true;
    this.$('.about').hidden = true;
    document.removeEventListener('keydown', this.onEsc, true);
  }

  /** Open a panel under the box, nudged left if it would run off a narrow screen. */
  openPanel(pop) {
    pop.style.left = '0px';
    pop.hidden = false;
    const overflow = pop.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
    if (overflow > 0) pop.style.left = `${-overflow}px`;
  }

  /** Fold mode: show the chain folding live as the search finds better folds. */
  showFolding(p) {
    if (this.getAttribute('show-fold') === 'false' || this.options.showFold === false) return;
    const u = p.unit;
    if (!this.anim || this.anim.sequence !== u.sequence) {
      this.$('.fname').textContent = u.name || u.benchmarkId;
      this.$('.fbest').textContent = 'Preparing';
      this.$('.fpct').textContent = `${u.sequence.length} residues`;
      this.$('.fbar i').style.width = '0%';
      this.openPanel(this.$('.folding'));
      const dark = this.getAttribute('theme') === 'dark';
      this.anim?.stop();
      this.anim = new FoldAnimator(this.$('.stage canvas'), u.sequence, dark ? { maxCell: 18, bg: '#1b1e21', bond: 'rgba(220,226,230,.45)' } : { maxCell: 18 });
    }
    if (p.phase === 'fold' || p.phase === 'submit') {
      if (p.bestFold) this.anim.setFold(p.bestFold);
      if (p.bestContacts >= 0) this.$('.fbest').textContent = `Best so far: ${p.bestContacts} hydrophobic contacts`;
      if (p.phase === 'fold') this.$('.fpct').textContent = `${Math.round(p.fraction * 100)}%`;
      this.$('.fbar i').style.width = `${Math.round(p.fraction * 100)}%`;
    }
  }

  /** Show the challenge panel; resolve with one answer index per photo. */
  askHuman(c) {
    const pop = this.$('.challenge');
    const img = this.$('.photo img');
    const group = this.$('.answers');
    const verify = this.$('.verify');
    this.$('.status').textContent = 'Answer the question below';
    this.$('.challenge .for').textContent = `For ${c.source.name}, a research project on ${c.source.platform}`;
    this.$('.challenge .q').textContent = c.question;
    const src = this.$('.challenge .src');
    const link = document.createElement('a');
    link.href = c.source.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `${c.source.name} on ${c.source.platform}`;
    src.replaceChildren('Photo from ', link);
    this.openPanel(pop);

    return new Promise((resolve, reject) => {
      const answers = [];
      let i = 0;
      let choice = null;

      this.onEsc = (e) => {
        if (e.key === 'Escape') reject(new FoldPassError('cancelled', 'CANCELLED'));
      };
      document.addEventListener('keydown', this.onEsc, true);
      this.$('.refresh').onclick = () => reject(new FoldPassError('refresh', 'REFRESH'));

      const show = () => {
        choice = null;
        verify.disabled = true;
        verify.textContent = i < c.items.length - 1 ? 'Next' : 'Verify';
        this.$('.count').textContent = c.items.length > 1 ? `${i + 1} of ${c.items.length}` : '';
        img.alt = `Photo ${i + 1} of ${c.items.length}`;
        img.onerror = () => reject(new FoldPassError('The photo failed to load', 'IMAGE'));
        img.src = c.items[i].image.replace("large", "small");
        group.replaceChildren(
          ...c.answers.map((label, k) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.setAttribute('aria-pressed', 'false');
            b.onclick = () => {
              choice = k;
              group.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === k)));
              verify.disabled = false;
            };
            return b;
          }),
        );
        group.firstElementChild?.focus({ preventScroll: true });
      };
      verify.onclick = () => {
        if (choice === null) return;
        answers[i] = choice;
        i++;
        if (i === c.items.length) {
          verify.disabled = true;
          this.$('.status').textContent = 'Checking…';
          return resolve(answers);
        }
        show();
      };
      show();
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  setToken(token) {
    this._token = token;
    const form = this.closest('form');
    if (!form) return;
    const name = this.getAttribute('input-name') || this.options.inputName || 'fold-captcha-token';
    let input = form.querySelector(`input[name="${cssEscape(name)}"]`);
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      form.appendChild(input);
    }
    input.value = token || '';
  }
}

/** Short status-line wording for each failure. */
function friendly(e) {
  if (e.code === 'BAD_ORIGIN' || e.code === 'BAD_SITE_KEY') return 'This site is not set up correctly';
  if (e.code === 'HTTP_429') return 'Too many attempts. Try again soon.';
  if (e.code === 'NETWORK') return 'Connection failed. Try again.';
  if (e.code === 'IMAGE') return 'Photo failed to load. Try again.';
  if (/match|known/.test(e.message)) return "That answer didn't match. Try again.";
  if (/quickly/.test(e.message)) return 'Answered too fast. Try again.';
  return 'Check failed. Try again.';
}

const cssEscape = (s) => (globalThis.CSS?.escape ? globalThis.CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

if (!customElements.get('fold-captcha')) customElements.define('fold-captcha', FoldCaptchaElement);

/**
 * Render a widget into a container (element or selector). Returns the widget,
 * which has .token, .execute() and .reset().
 * Options: siteKey (required), theme 'dark'|'light', inputName, onSuccess(token, unit), onError(err), onExpired().
 */
export function render(container, options = {}) {
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) throw new FoldPassError(`container not found: ${container}`, 'BAD_CONTAINER');
  if (!options.siteKey) throw new FoldPassError('siteKey is required', 'BAD_SITE_KEY');
  const el = document.createElement('fold-captcha');
  el.options = options;
  el.setAttribute('site-key', options.siteKey);
  if (options.theme) el.setAttribute('theme', options.theme);
  if (options.task) el.setAttribute('task', options.task);
  if (options.inputName) el.setAttribute('input-name', options.inputName);
  host.replaceChildren(el);
  return el;
}

/**
 * reCAPTCHA-style declarative markup:
 *   <div class="foldpass" data-sitekey="…" data-theme="light" data-callback="onFolded"
 *        data-expired-callback="…" data-error-callback="…"></div>
 * Callback attributes name global functions.
 */
export function autoRender(root = document) {
  const fn = (name) => (name && typeof window[name] === 'function' ? window[name] : undefined);
  return [...root.querySelectorAll('.foldpass[data-sitekey]:not([data-foldpass-rendered])')].map((el) => {
    el.setAttribute('data-foldpass-rendered', '');
    const d = el.dataset;
    return render(el, {
      siteKey: d.sitekey,
      theme: d.theme,
      task: d.task,
      inputName: d.inputName,
      onSuccess: (...a) => fn(d.callback)?.(...a),
      onExpired: () => fn(d.expiredCallback)?.(),
      onError: (e) => fn(d.errorCallback)?.(e),
    });
  });
}

// ------------------------------------------------------------------ opt-in volunteer compute

/**
 * Donate idle compute from this page. Nothing runs until .start(), and you
 * should only call it after the visitor has clearly opted in.
 *
 *   const v = FoldPass.volunteer({ threads: 2, onResult: (r) => … });
 *   button.onclick = () => v.start();
 *
 * Options: threads (default 1), pauseOnBattery (default true: pauses when
 * unplugged below 30%), pauseWhenHidden (default false), onResult(r), onStatus(s).
 */
export function volunteer({ threads = 1, pauseOnBattery = true, pauseWhenHidden = false, onResult, onStatus } = {}) {
  const mobile = isMobile();
  const slots = [];
  const stats = { units: 0, conformations: 0, validated: 0, errors: 0 };
  let running = false;
  let paused = false;
  let generation = 0;
  let battery = null;

  const status = () => onStatus?.({ running, paused, threads: slots.length, ...stats });

  const shouldPause = () =>
    (pauseOnBattery && battery && !battery.charging && battery.level < 0.3) || (pauseWhenHidden && document.hidden);

  const recheck = () => {
    const p = shouldPause();
    if (p !== paused) {
      paused = p;
      status();
    }
  };

  if (pauseOnBattery && navigator.getBattery) {
    navigator.getBattery().then((b) => {
      battery = b;
      b.addEventListener('chargingchange', recheck);
      b.addEventListener('levelchange', recheck);
      recheck();
    });
  }
  if (pauseWhenHidden) document.addEventListener('visibilitychange', recheck);

  async function loop(slot, gen) {
    while (running && gen === generation) {
      if (paused) {
        await sleep(2000);
        continue;
      }
      try {
        const work = await withDevice({ label: 'sdk-volunteer' }, (deviceToken) => api('/api/work', { deviceToken, mobile }));
        if (!running || gen !== generation) break;
        const job = runJob(slot.worker, { unit: work.unit });
        slot.cancel = job.cancel;
        const out = await job.promise;
        const res = await api('/api/result', { lease: work.lease, result: out.result });
        stats.units++;
        stats.conformations += work.unit.attempts;
        if (res.status === 'validated') stats.validated++;
        onResult?.({ unitId: work.unit.id, benchmarkId: work.unit.benchmarkId, contacts: res.contacts, status: res.status, ms: out.result.ms });
        status();
      } catch (err) {
        if (err.cancelled || !running) break;
        stats.errors++;
        status();
        await sleep(3000);
      }
    }
  }

  return {
    get running() {
      return running;
    },
    get paused() {
      return paused;
    },
    stats,
    start() {
      if (running) return;
      running = true;
      const gen = ++generation;
      const n = Math.max(1, Math.min(threads, mobile ? 1 : navigator.hardwareConcurrency || 2));
      for (let i = 0; i < n; i++) {
        const slot = { worker: createWorker() };
        slots.push(slot);
        loop(slot, gen);
      }
      status();
    },
    stop() {
      running = false;
      generation++;
      for (const s of slots.splice(0)) {
        s.cancel?.();
        s.worker.terminate();
      }
      status();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FoldPass = { version, host, render, execute, solve, autoRender, volunteer, FoldPassError };
export default FoldPass;
