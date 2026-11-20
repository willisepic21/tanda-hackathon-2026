// <fold-captcha site-key="..."> — embeddable FoldPass widget.
//
// Usage on any page:
//   <script type="module" src="https://YOUR-FOLDPASS-HOST/widget/fold-captcha.js"></script>
//   <form> ... <fold-captcha site-key="demo-site-key"></fold-captcha> ... </form>
//
// On success it inserts <input type="hidden" name="fold-captcha-token"> into the
// enclosing form and fires a `solved` event ({ detail: { token } }).
// Your backend then POSTs { token, secret } to /api/siteverify.

import { api, withDevice, isMobile, createWorker, runJob } from '../js/client.js';
import { drawFold } from '../js/fold-render.js';

const CSS = `
:host { display: block; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e7ecfb; max-width: 380px; }
.box { background: #111a31; border: 1px solid #263256; border-radius: 12px; padding: 12px; display: grid; grid-template-columns: 34px 1fr 92px; gap: 12px; align-items: center; }
.check { width: 30px; height: 30px; border-radius: 7px; border: 2px solid #4a5a8a; background: #0b1124; cursor: pointer; display: grid; place-items: center; padding: 0; transition: border-color .15s, background .15s; }
.check:hover:not(:disabled) { border-color: #9b8cff; }
.check:focus-visible { outline: 2px solid #9b8cff; outline-offset: 2px; }
.check:disabled { cursor: default; }
.spinner { width: 18px; height: 18px; border-radius: 50%; border: 3px solid #2b3961; border-top-color: #9b8cff; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.tick { color: #3ddc97; font-size: 20px; font-weight: 700; }
.cross { color: #ff6b6b; font-size: 18px; font-weight: 700; }
.title { font-weight: 600; }
.sub { color: #93a0c4; font-size: 12px; margin-top: 2px; min-height: 2.7em; }
canvas { width: 92px; height: 70px; background: #0b1124; border-radius: 8px; display: block; }
.bar { height: 3px; background: #1b2545; border-radius: 3px; margin: 8px 2px 0; overflow: hidden; }
.bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #9b8cff, #ff7a59); transition: width .15s; }
.foot { display: flex; justify-content: space-between; align-items: baseline; margin: 6px 2px 0; font-size: 11px; color: #6f7ba0; }
details { font-size: 12px; color: #a5b0d0; }
summary { cursor: pointer; color: #9b8cff; list-style: none; }
summary::-webkit-details-marker { display: none; }
details p { margin: 6px 0 0; background: #0f1730; border: 1px solid #263256; border-radius: 8px; padding: 8px 10px; }
:host([state="done"]) .box { border-color: #2f7d5c; }
:host([state="error"]) .box { border-color: #8a3a46; }
`;

class FoldCaptcha extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="box">
        <button class="check" part="checkbox" aria-label="Verify that I am human by folding a protein"></button>
        <div>
          <div class="title">I'm human — fold a protein</div>
          <div class="sub" aria-live="polite">Your device runs ~1–2 s of protein-folding search.</div>
        </div>
        <canvas aria-hidden="true"></canvas>
      </div>
      <div class="bar"><i></i></div>
      <div class="foot">
        <details>
          <summary>What will my device compute?</summary>
          <p>A short Monte-Carlo search for low-energy folds of a lattice protein model
          (benchmark sequences and fragments of cancer-linked proteins such as KRAS and TP53),
          plus a small proof-of-work. Every unit is computed by two independent devices and
          only kept when both results match exactly. Nothing about you is computed or stored
          beyond an anonymous device ID. Phones get smaller units.</p>
        </details>
        <span>FoldPass</span>
      </div>`;
    this.$ = (s) => root.querySelector(s);
    this.$('.check').addEventListener('click', () => this.start());
    this.setState('idle');
  }

  disconnectedCallback() {
    this.worker?.terminate();
    this.worker = null;
    clearTimeout(this.expiryTimer);
  }

  get token() {
    return this._token || null;
  }

  setState(state, sub) {
    this.setAttribute('state', state);
    const btn = this.$('.check');
    btn.disabled = state === 'working' || state === 'done';
    btn.innerHTML = { idle: '', working: '<span class="spinner"></span>', done: '<span class="tick">✓</span>', error: '<span class="cross">↻</span>' }[state];
    if (sub !== undefined) this.$('.sub').textContent = sub;
    if (state !== 'working') this.progress(state === 'done' ? 1 : 0);
  }

  progress(f) {
    this.$('.bar i').style.width = `${Math.round(f * 100)}%`;
  }

  async start() {
    const siteKey = this.getAttribute('site-key');
    if (!siteKey) return this.setState('error', 'Missing site-key attribute.');
    this.setState('working', 'Requesting a work unit…');
    this.setToken(null);
    const mobile = isMobile();

    try {
      const ch = await withDevice({ label: 'captcha' }, (deviceToken) => api('/api/challenge', { siteKey, deviceToken, mobile }));
      const { unit } = ch;
      this.worker ||= createWorker();
      const canvas = this.$('canvas');

      const { promise } = runJob(this.worker, { unit, pow: ch.pow }, (p) => {
        if (p.phase === 'pow') {
          this.progress(p.fraction * 0.3);
          this.$('.sub').textContent = 'Anti-bot proof of work…';
        } else {
          this.progress(0.3 + p.fraction * 0.7);
          this.$('.sub').textContent = `Folding ${unit.benchmarkId} · best so far ${p.bestContacts} H–H contacts`;
          if (p.bestFold) drawFold(canvas, unit.sequence, p.bestFold, { maxCell: 12, pad: 6 });
        }
      });
      const out = await promise;
      drawFold(canvas, unit.sequence, out.result.fold, { maxCell: 12, pad: 6 });
      this.$('.sub').textContent = 'Submitting…';

      const res = await api('/api/solve', { challenge: ch.challenge, nonce: out.nonce, result: out.result, totalMs: out.totalMs });
      this.setToken(res.passToken);
      const u = res.unit;
      const status =
        u.status === 'validated' ? 'validated by 2 devices ✓' : u.replicas ? `awaiting replica (${u.replicas}/${u.needed} devices)` : 'spot-check passed';
      this.setState('done', `Folded ${unit.benchmarkId}: ${u.contacts} contacts · ${status}`);
      this.dispatchEvent(new CustomEvent('solved', { detail: { token: res.passToken, unit: u }, bubbles: true, composed: true }));

      clearTimeout(this.expiryTimer);
      this.expiryTimer = setTimeout(() => {
        this.setToken(null);
        this.setState('idle', 'Verification expired — click to fold again.');
        this.dispatchEvent(new CustomEvent('expired', { bubbles: true, composed: true }));
      }, res.expiresIn - 5000);
    } catch (err) {
      this.setState('error', `Couldn't verify: ${err.message}. Click to retry.`);
      this.dispatchEvent(new CustomEvent('error', { detail: { message: err.message }, bubbles: true, composed: true }));
    }
  }

  setToken(token) {
    this._token = token;
    const form = this.closest('form');
    if (!form) return;
    let input = form.querySelector('input[name="fold-captcha-token"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'fold-captcha-token';
      form.appendChild(input);
    }
    input.value = token || '';
  }
}

if (!customElements.get('fold-captcha')) customElements.define('fold-captcha', FoldCaptcha);
