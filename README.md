# FoldPass: a CAPTCHA that folds proteins

FoldPass is a proof-of-work CAPTCHA. Instead of hashing for nothing, each solve runs a short search over **HP lattice protein folding**. The work is spread across many devices, and every work unit is **computed by two independent devices**. A result is kept only when both match bit-for-bit.

No dependencies. Needs Node ≥ 20.

```bash
npm start      # http://localhost:8080
npm test
```

| Page | What it shows |
|---|---|
| `/` | Demo sign-up form with the `<fold-captcha>` widget, verified by a "host backend" |
| `/volunteer` | Continuous donation mode. Open it on every phone and laptop you have |
| `/dashboard` | Live stats, 2-device replication table, best validated folds, device trust, bot economics |

To demo 2-device validation on **one machine**, open `/volunteer?simulate`, which gives each thread its own device identity. To use **real devices**, open the LAN URL that the server prints on startup on other phones and laptops on the same Wi-Fi.

## How it works

```
 browser (widget / volunteer)                    FoldPass server
 ───────────────────────────                     ───────────────
 POST /api/device ─────────────────────────────▶ signed anonymous device ID
 POST /api/challenge ──────────────────────────▶ coordinator.assign(): pending replica first,
   ◀── signed challenge + PoW prefix + unit         else known-answer check, else new unit
 Web Worker: hashcash PoW + solve(seq, seed, N)
 POST /api/solve ──────────────────────────────▶ verify HMAC, expiry, one-time use, PoW,
                                                 fold validity, contact count, histogram;
                                                 record replica → quorum check
   ◀── one-time signed pass token
 host backend: POST /api/siteverify {token, secret} ▶ { success }
```

### Why two devices can agree exactly

A work unit is `(sequence, seed, attempts)`. The solver (`shared/hp.js`) is a biased Monte-Carlo chain-growth search that uses **only integer math and a seeded PRNG** (mulberry32 with `Math.imul`). Every JS engine therefore produces the same output for the same unit. Each result carries a full fingerprint:

- the best fold (`RULD…` moves) and its H–H contact count
- the energy histogram over **every** attempt, plus the count of dead-end attempts
- a rolling checksum over every attempt

Validation happens in two layers:

1. **Instant (server, microseconds):** the fold must be self-avoiding, the contact count must be right, the histogram's maximum must equal the claimed best, and the histogram plus dead ends must sum to `attempts`. Anything that fails is rejected and costs the device trust.
2. **Replication (2 devices):** a unit is `validated` only when 2 trusted devices return identical fingerprints. If they disagree it becomes `disputed` and goes to a third device as a tie-breaker (up to 4). Devices that agree with the majority gain trust; devices that disagree lose it, and below `trustFloor` their results stop counting toward quorum.

Replication catches the cheat that layer 1 can't. A device could run 1% of the attempts, pad the histogram, and submit a perfectly valid fold. Only the checksum comparison exposes it (see `test/coordinator.test.js`).

**Known-answer checks:** 20% of CAPTCHAs re-issue an already-validated unit. A wrong answer fails the CAPTCHA immediately and costs the device trust.

### Scheduling

`server/coordinator.js` hands each device the unit closest to validation first: units that already have a result and need a second device. It never gives a device a unit it has already done or currently holds a lease on. Leases expire after 3 minutes, so a device that drops out doesn't block a unit. Phones only receive `light` units and an easier PoW.

### Work sources (`shared/benchmarks.js`)

- Standard 2D HP benchmarks S1–S8 (20–64 residues) with published best-known energies, so the dashboard can show how close the network gets.
- Fragments of **KRAS** (1–40, covering the G12/G13 hotspots) and **TP53** (94–155), mapped to HP by hydrophobicity. These are illustrative: the HP model is a coarse abstraction, not a drug-discovery pipeline.

## Embedding on another site

```html
<script type="module" src="https://YOUR-FOLDPASS-HOST/widget/fold-captcha.js"></script>
<form method="post" action="/signup">
  …
  <fold-captcha site-key="demo-site-key"></fold-captcha>   <!-- adds hidden input fold-captcha-token -->
</form>
```

Your backend then makes this call:

```bash
curl -X POST https://YOUR-FOLDPASS-HOST/api/siteverify \
  -H 'content-type: application/json' \
  -d '{"token":"<fold-captcha-token>","secret":"<your site secret>"}'
# → {"success":true,"siteKey":"demo-site-key","unitId":"S3-25.4"}
```

Pass tokens expire after 2 minutes and can only be redeemed once. Site keys and secrets live in `server/config.js`. Set `DEMO_SITE_SECRET` in production.

## API

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /api/device` | `{label?}` | Register an anonymous device and return `deviceToken` |
| `POST /api/challenge` | `{siteKey, deviceToken, mobile?}` | CAPTCHA challenge: PoW + work unit |
| `POST /api/solve` | `{challenge, nonce, result, totalMs}` | Submit; returns `passToken` |
| `POST /api/siteverify` | `{token, secret}` | Host backend redeems a pass token |
| `POST /api/work` | `{deviceToken, mobile?}` | Volunteer: lease a unit |
| `POST /api/result` | `{lease, result}` | Volunteer: submit a result |
| `GET /api/stats` | | Dashboard data |
| `GET /api/units?id=S1-20.3` | | Every replica of one unit |

## Config (env)

`PORT`, `HOST`, `DATA_DIR`, `FOLDPASS_SECRET` (HMAC key; otherwise one is generated into `data/secret.key`), `DEMO_SITE_SECRET`, `TRUST_PROXY=1` (honour `X-Forwarded-For`), `QUORUM_DISTINCT_IP=1` (replicas must come from different IPs as well as different device IDs). State persists to `data/state.json`.

## Honest caveats

- **Research value per CAPTCHA is small.** One solve is about 120k–250k sampled conformations. It only adds up at scale; the pitch is a proof of concept, or a partnership with a project like World Community Grid.
- **The PoW and rate limits are the bot gate, not the science.** The dashboard shows what a million solves costs a bot farm, and it's cheap. In production, pair this with risk signals.
- **Sybil devices.** Device IDs are free to mint, so one attacker could pose as both replicas. Mitigations: `QUORUM_DISTINCT_IP=1`, known-answer checks, trust scores, and (in production) issuing replicas only to devices with a long agreement history.
- **Consent and battery.** The widget explains what runs. Phones get smaller units and a lower PoW difficulty.

## Layout

```
shared/   hp.js (model, verifier, deterministic solver) · pow.js (pure-JS SHA-256) · benchmarks.js
server/   index.js · app.js (HTTP + API) · coordinator.js (scheduling, quorum, trust) · tokens.js · store.js · config.js
public/   widget/ (fold-captcha.js, worker.js) · js/ (client, fold-render, dashboard, volunteer) · *.html
test/     node:test suites for the model, the coordinator and the HTTP flow
```
