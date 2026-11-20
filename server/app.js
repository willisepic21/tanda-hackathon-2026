import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordinator } from './coordinator.js';
import { createSigner, verifyPow, randomId } from './tokens.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIRS = { '/shared/': path.join(ROOT, 'shared'), '/': path.join(ROOT, 'public') };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Builds the request handler. Kept separate from index.js so tests can run
 * the whole API in-process.
 */
export function createApp({ config, state, secret, save = () => {}, now = Date.now, rand = Math.random }) {
  const coord = new Coordinator(state, config, { now, rand });
  const tokens = createSigner(secret);
  const usedChallenges = new Map(); // challenge id -> expiry (one-time use)
  const usedPasses = new Map(); // pass id -> expiry (one-time use)
  const buckets = new Map(); // `${route}:${ip}` -> { tokens, at }

  setInterval(() => {
    const t = now();
    for (const m of [usedChallenges, usedPasses]) for (const [k, exp] of m) if (exp < t) m.delete(k);
    for (const [k, b] of buckets) if (t - b.at > 120_000) buckets.delete(k);
  }, 30_000).unref();

  function rateLimited(route, ip) {
    const perMin = config.rateLimits[route];
    if (!perMin) return false;
    const key = `${route}:${ip}`;
    const t = now();
    const b = buckets.get(key) || { tokens: perMin, at: t };
    b.tokens = Math.min(perMin, b.tokens + ((t - b.at) / 60_000) * perMin);
    b.at = t;
    buckets.set(key, b);
    if (b.tokens < 1) return true;
    b.tokens -= 1;
    return false;
  }

  const deviceFrom = (body) => tokens.verify('device', body?.deviceToken);

  // ------------------------------------------------------------------ API handlers

  const api = {
    /** Register an anonymous device. The signed token is the device's identity. */
    'POST /api/device': (body, ctx) => {
      const id = randomId();
      coord.registerDevice(id, { label: body?.label, ip: ctx.ip });
      save();
      return { deviceId: id, deviceToken: tokens.sign('device', { d: id, iat: now() }) };
    },

    /** CAPTCHA step 1: issue a signed challenge = PoW puzzle + a folding work unit. */
    'POST /api/challenge': (body, ctx) => {
      const site = config.sites[body?.siteKey];
      if (!site) return [400, { error: 'unknown site key' }];
      const dev = deviceFrom(body);
      if (!dev) return [401, { error: 'invalid device token', code: 'BAD_DEVICE' }];
      const mobile = !!body.mobile;
      const { unit, known } = coord.assign(dev.d, { ip: ctx.ip, mobile, mode: 'captcha' });
      const id = randomId();
      const bits = mobile ? config.powBits.mobile : config.powBits.desktop;
      const exp = now() + config.challengeTtlMs;
      coord.s.stats.captchaIssued++;
      save();
      return {
        challenge: tokens.sign('challenge', { id, d: dev.d, site: body.siteKey, u: unit.id, k: known, bits, exp }),
        pow: { prefix: id, bits },
        unit: coord.publicUnit(unit),
        expiresAt: exp,
      };
    },

    /** CAPTCHA step 2: client returns the PoW nonce and the folding result. */
    'POST /api/solve': (body, ctx) => {
      const ch = tokens.verify('challenge', body?.challenge, now());
      if (!ch) return fail('challenge invalid or expired');
      if (usedChallenges.has(ch.id)) return fail('challenge already used');
      usedChallenges.set(ch.id, ch.exp);

      if (!verifyPow(ch.id, body.nonce, ch.bits)) return fail('proof of work invalid');

      const res = coord.submit(ch.d, ch.u, body.result, { ip: ctx.ip });
      if (!res.ok) return fail(res.reason);
      if (res.known && !res.matched) return fail('result did not match the verified answer for this unit');

      const ms = Math.max(0, Math.min(Number(body.totalMs) || 0, 120_000));
      coord.s.stats.captchaPassed++;
      coord.s.stats.captchaMsTotal += ms;
      save();
      const passId = randomId();
      return {
        success: true,
        passToken: tokens.sign('pass', { id: passId, site: ch.site, u: ch.u, exp: now() + config.passTtlMs }),
        expiresIn: config.passTtlMs,
        unit: { id: ch.u, status: res.status, contacts: res.contacts, replicas: res.replicas, needed: res.needed },
      };

      function fail(reason) {
        coord.s.stats.captchaFailed++;
        save();
        return [400, { success: false, reason }];
      }
    },

    /** CAPTCHA step 3: the host site's BACKEND validates a pass token (one-time use). */
    'POST /api/siteverify': (body) => {
      const pass = tokens.verify('pass', body?.token, now());
      if (!pass) return { success: false, reason: 'invalid or expired token' };
      const site = config.sites[pass.site];
      if (!site || site.secret !== body.secret) return { success: false, reason: 'secret does not match site key' };
      if (usedPasses.has(pass.id)) return { success: false, reason: 'token already redeemed' };
      usedPasses.set(pass.id, pass.exp);
      return { success: true, siteKey: pass.site, unitId: pass.u };
    },

    /** Volunteer mode: pull a work unit (no CAPTCHA, no PoW). */
    'POST /api/work': (body, ctx) => {
      const dev = deviceFrom(body);
      if (!dev) return [401, { error: 'invalid device token', code: 'BAD_DEVICE' }];
      const { unit } = coord.assign(dev.d, { ip: ctx.ip, mobile: !!body.mobile, mode: 'volunteer' });
      save();
      return { lease: tokens.sign('lease', { d: dev.d, u: unit.id, exp: now() + config.leaseTtlMs }), unit: coord.publicUnit(unit) };
    },

    /** Volunteer mode: return a result. */
    'POST /api/result': (body, ctx) => {
      const lease = tokens.verify('lease', body?.lease, now());
      if (!lease) return [400, { ok: false, reason: 'lease invalid or expired' }];
      const res = coord.submit(lease.d, lease.u, body.result, { ip: ctx.ip });
      save();
      return res.ok ? res : [400, res];
    },

    'GET /api/stats': () => coord.snapshot(),

    'GET /api/units': (_b, ctx) => {
      const unit = state.units[ctx.query.get('id')];
      if (!unit) return [404, { error: 'not found' }];
      const { leases, ...rest } = unit;
      return { ...rest, results: rest.results.map(({ ip, ...r }) => r), audits: rest.audits.map(({ ip, ...r }) => r) };
    },

    /**
     * Stand-in for the HOST SITE's backend. A real site would run this on its
     * own server: receive the form + pass token, then call /api/siteverify
     * with its secret over the network, exactly like this.
     */
    'POST /demo/signup': async (body) => {
      const r = await fetch(`http://127.0.0.1:${config.port}/api/siteverify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: body?.token, secret: config.sites['demo-site-key'].secret }),
      });
      const v = await r.json();
      if (!v.success) return [403, { ok: false, message: `Verification failed: ${v.reason}` }];
      const email = String(body?.email || 'friend').slice(0, 80);
      return { ok: true, message: `Welcome, ${email}! Your sign-up passed FoldPass (work unit ${v.unitId}).` };
    },
  };

  // ------------------------------------------------------------------ HTTP plumbing

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';

    // The widget may be embedded on other origins.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return send(res, 204, '');

    const route = api[`${req.method} ${url.pathname}`];
    if (route) {
      const name = url.pathname.split('/').pop();
      if (rateLimited(name, ip)) return json(res, 429, { error: 'rate limited' });
      try {
        const body = req.method === 'POST' ? await readJson(req) : null;
        let out = await route(body, { ip, query: url.searchParams });
        let status = 200;
        if (Array.isArray(out)) [status, out] = out;
        return json(res, status, out);
      } catch (err) {
        if (err.status) return json(res, err.status, { error: err.message });
        console.error(err);
        return json(res, 500, { error: 'internal error' });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);
    return json(res, 404, { error: 'not found' });
  };
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json');
}

function send(res, status, body, type) {
  if (type) res.setHeader('content-type', type);
  res.writeHead(status);
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { error: 'bad path' });
  }
  const prefix = decoded.startsWith('/shared/') ? '/shared/' : '/';
  const base = STATIC_DIRS[prefix];
  let file = path.resolve(base, '.' + decoded.slice(prefix.length - 1));
  if (!file.startsWith(base)) return json(res, 403, { error: 'forbidden' });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && !path.extname(file)) file += '.html';
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.setHeader('cache-control', 'no-cache');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}
