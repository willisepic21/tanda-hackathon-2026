# FoldPass JavaScript SDK

Two parts:

| Part | File | Runs on |
|---|---|---|
| Browser SDK | `/sdk/foldpass.js` (classic script) or `/sdk/foldpass.esm.js` (ES module), types in `/sdk/foldpass.d.ts` | the visitor's browser |
| Server SDK | `sdk/node/foldpass-server.js` | your backend (Node 18+) |

The browser SDK is served by the FoldPass server itself. It works out the API host from its own URL, so there's nothing to configure besides the site key. It works across origins: the API sends CORS headers, and the Web Worker is bootstrapped through a blob URL.

A working third-party integration lives in [`examples/third-party/`](examples/third-party/):

```bash
node examples/third-party/server.js http://localhost:8080 5173
```

## 1. Add the widget

**Markup only** (reCAPTCHA-style):

```html
<script src="https://foldpass-tanda.fly.dev/sdk/foldpass.js" async defer></script>

<form action="/signup" method="post">
  <input name="email" />
  <div class="foldpass" data-sitekey="YOUR_SITE_KEY" data-theme="light"
       data-callback="onFolded" data-expired-callback="onExpired"></div>
  <button>Sign up</button>
</form>
```

When solved, the widget adds `<input type="hidden" name="fold-captcha-token">` to the form and calls `onFolded(token, unit)`.

| `data-*` attribute | Meaning |
|---|---|
| `data-sitekey` | required |
| `data-theme` | `light` (default) or `dark` |
| `data-task` | `fold` (default) or `classify`: ask a real Zooniverse research question instead ([CITIZEN.md](CITIZEN.md)) |
| `data-callback`, `data-expired-callback`, `data-error-callback` | names of global functions |
| `data-input-name` | hidden input name (default `fold-captcha-token`) |

Script URL options: `foldpass.js?render=explicit` turns off auto-rendering, and `?onload=fnName` calls `fnName(FoldPass)` once the SDK is ready.

**JavaScript:**

```js
// classic script: every call returns a Promise
const widget = await FoldPass.render('#captcha', {
  siteKey: 'YOUR_SITE_KEY',
  theme: 'light',
  task: 'classify',          // optional: real citizen-science question
  onSuccess: (token, unit) => {},
  onError: (err) => console.warn(err.code, err.message),
  onExpired: () => {},
});
widget.token;      // current token or null
widget.reset();
await widget.execute();   // trigger it programmatically
```

```js
// ES module: render is synchronous
import FoldPass from 'https://foldpass-tanda.fly.dev/sdk/foldpass.esm.js';
const widget = FoldPass.render(document.querySelector('#captcha'), { siteKey: 'YOUR_SITE_KEY' });
```

`<fold-captcha site-key="…" theme="light">` also works as a plain custom element. It fires `solved`, `expired` and `error` DOM events.

## 2. Invisible mode

No widget. The check runs in the background (around 1 s on a laptop), for example when a button is pressed:

```js
const token = await FoldPass.execute({ siteKey: 'YOUR_SITE_KEY', onProgress: (p) => bar.value = p.overall });
await fetch('/subscribe', { method: 'POST', body: JSON.stringify({ email, token }) });
```

`execute()` always uses fold mode, because classify needs a person looking at the widget.

Errors are `FoldPassError` with a `code`: `BAD_SITE_KEY`, `BAD_ORIGIN`, `NETWORK`, `HTTP_429`, ….

## 3. Verify on your backend

Never trust the browser. Always redeem the token server-side. Tokens are single-use and expire after 2 minutes.

```js
import { createVerifier } from './foldpass-server.js';

const foldpass = createVerifier({
  host: 'https://foldpass-tanda.fly.dev',
  secret: process.env.FOLDPASS_SECRET,
  hostnames: ['mysite.com'],      // reject tokens solved on other sites
});

const r = await foldpass.verify(token);
// { success, siteKey, hostname, challengeTs, unitId, unitStatus } or { success: false, reason }

app.post('/signup', express.json(), foldpass.middleware(), handler);  // 403s on failure
```

The verifier fails closed: if FoldPass can't be reached, `success` is `false`. Any other language can call the HTTP endpoint directly:

```bash
curl -X POST https://foldpass-tanda.fly.dev/api/siteverify -H 'content-type: application/json' \
  -d '{"token":"<token>","secret":"<secret>"}'
```

`response` is accepted as an alias for `token`.

## 4. Opt-in compute donation

Lets visitors who choose to donate CPU while the page is open. Only call `start()` after a clear opt-in.

```js
const donor = await FoldPass.volunteer({
  threads: 1,
  pauseOnBattery: true,     // pause when unplugged and below 30% (Chromium Battery API)
  pauseWhenHidden: false,
  onStatus: (s) => label.textContent = `${s.units} units, ${s.validated} validated`,
  onResult: (r) => {},
});
checkbox.onchange = () => (checkbox.checked ? donor.start() : donor.stop());
```

Mobile devices get one thread and light units only.

## Site keys and origin locking

Site keys live in `server/config.js`:

```js
sites: {
  'YOUR_SITE_KEY': { secret: '…', name: 'My site', origins: ['mysite.com', 'www.mysite.com'] },
}
```

When `origins` is non-empty, challenges requested from any other page origin are refused (`BAD_ORIGIN`). Either way, `siteverify` returns the `hostname` the widget ran on.
The `Origin` header is enforced by the browser, but a script outside a browser can set any value it likes. So origin locking stops other websites from reusing your key; it doesn't stop bots. PoW, rate limits and known-answer checks do that.

## Privacy notes

- The device identity is an anonymous signed ID in `localStorage` on *your* origin, so a visitor gets a separate ID on each site that embeds FoldPass. No cross-site tracking.
- No cookies, no fingerprinting.
- In the public dataset, device IDs are replaced by a keyed hash.
