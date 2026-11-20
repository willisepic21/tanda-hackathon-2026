import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordinator } from './coordinator.js';
import { createSigner, verifyPow, randomId } from './tokens.js';
import { BENCHMARKS } from '../shared/benchmarks.js';
import { SOLVER_VERSION } from '../shared/hp.js';
import { CitizenScience, emptyCitizenState, forwardClassification } from './citizen.js';
import { sendBody, sendStream, sendStatic } from './compress.js';

/** Return one of these from a route to send a non-JSON body (downloads). */
class Raw {
  constructor(body, type, filename) {
    Object.assign(this, { body, type, filename });
  }
}

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
export function createApp({ config, state, secret, archive = null, save = () => {}, now = Date.now, rand = Math.random, citizenFetch = globalThis.fetch }) {
  const coord = new Coordinator(state, config, { now, rand, onValidated: (record) => archive?.append(record) });
  if (archive) coord.rebuildScience(archive.readAll());
  const backfilled = coord.backfillArchive();
  if (backfilled) {
    console.log(`Archived ${backfilled} previously validated units.`);
    save();
  }
  const tokens = createSigner(secret);

  // ---------------------------------------------------------------- citizen science
  state.citizen ||= emptyCitizenState();
  const ccfg = config.citizen;
  const citizen = ccfg?.enabled
    ? new CitizenScience(state.citizen, ccfg, {
        fetch: citizenFetch,
        now,
        rand,
        onClassification: (rec) => {
          archive?.appendClassification(rec);
          if (ccfg.forward?.enabled && ccfg.forward.token && rec.counted) {
            forwardClassification(rec, { api: ccfg.api, token: ccfg.forward.token, fetch: citizenFetch })
              .then(() => state.citizen.stats.forwarded++)
              .catch((err) => {
                state.citizen.stats.forwardErrors++;
                console.warn('[citizen] forward failed:', err.message);
              });
          }
        },
      })
    : null;
  const citizenReady = citizen
    ? citizen.init().then(
        (w) => console.log(`Citizen science: "${w.question}" from ${w.projectName} (workflow ${w.workflow})`),
        (err) => console.warn('[citizen] disabled, could not reach Zooniverse:', err.message),
      )
    : Promise.resolve();
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
      if (!site) return [400, { error: 'unknown site key', code: 'BAD_SITE_KEY' }];
      const hostname = hostnameOf(ctx.origin);
      if (site.origins?.length && !site.origins.includes(hostname)) {
        return [403, { error: `site key not allowed on ${hostname || 'this origin'}`, code: 'BAD_ORIGIN' }];
      }
      const dev = deviceFrom(body);
      if (!dev) return [401, { error: 'invalid device token', code: 'BAD_DEVICE' }];
      const mobile = !!body.mobile;
      const id = randomId();
      const bits = mobile ? config.powBits.mobile : config.powBits.desktop;
      const exp = now() + config.challengeTtlMs;
      coord.s.stats.captchaIssued++;

      // Human task: real images from a live citizen-science workflow.
      const pick = body.task === 'classify' && citizen?.available() ? citizen.pick(dev.d) : null;
      if (pick) {
        save();
        const w = citizen.workflow;
        return {
          task: 'classify',
          challenge: tokens.sign('challenge', { id, d: dev.d, site: body.siteKey, h: hostname, t: 'classify', s: pick.subjectIds, b: pick.bootstrap, bits, iat: now(), exp }),
          pow: { prefix: id, bits },
          classify: {
            question: w.question,
            answers: w.answers,
            items: pick.items,
            source: { name: w.projectName, url: w.projectUrl, platform: 'Zooniverse' },
          },
          expiresAt: exp,
        };
      }

      const { unit, known } = coord.assign(dev.d, { ip: ctx.ip, mobile, mode: 'captcha' });
      save();
      return {
        task: 'fold',
        challenge: tokens.sign('challenge', { id, d: dev.d, site: body.siteKey, h: hostname, u: unit.id, k: known, bits, iat: now(), exp }),
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

      if (ch.t === 'classify') {
        if (!citizen) return fail('citizen science is disabled');
        if (now() - ch.iat < ccfg.minHumanMs) return fail('answered too quickly');
        const r = citizen.submit(ch.d, ch.s, body.answers, { bootstrap: ch.b, startedAt: ch.iat, finishedAt: now() });
        if (!r.ok) return fail(r.reason);
        coord.s.stats.captchaPassed++;
        coord.s.stats.captchaMsTotal += Math.max(0, Math.min(Number(body.totalMs) || 0, 120_000));
        save();
        return {
          success: true,
          passToken: tokens.sign('pass', { id: randomId(), site: ch.site, h: ch.h, ts: ch.iat, task: 'classify', exp: now() + config.passTtlMs }),
          expiresIn: config.passTtlMs,
          classify: { counted: r.counted, verified: r.verified, source: citizen.workflow.projectName },
        };
      }

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
        passToken: tokens.sign('pass', { id: passId, site: ch.site, h: ch.h, u: ch.u, ts: ch.iat, st: res.status, exp: now() + config.passTtlMs }),
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
      if (body && body.token === undefined && body.response !== undefined) body.token = body.response; // reCAPTCHA-style alias
      const pass = tokens.verify('pass', body?.token, now());
      if (!pass) return { success: false, reason: 'invalid or expired token' };
      const site = config.sites[pass.site];
      if (!site || site.secret !== body.secret) return { success: false, reason: 'secret does not match site key' };
      if (usedPasses.has(pass.id)) return { success: false, reason: 'token already redeemed' };
      usedPasses.set(pass.id, pass.exp);
      return {
        success: true,
        siteKey: pass.site,
        hostname: pass.h ?? null, // page the widget ran on (from the Origin header); check it matches your site
        challengeTs: pass.ts ? new Date(pass.ts).toISOString() : null,
        task: pass.task ?? 'fold',
        unitId: pass.u ?? null,
        unitStatus: pass.st ?? null,
      };
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

    'GET /api/stats': () => ({ ...coord.snapshot(), citizen: citizen ? citizen.summary() : { enabled: false } }),

    'GET /api/citizen': async () => {
      await citizenReady;
      return citizen ? citizen.summary() : { enabled: false };
    },

    'GET /api/data/citizen-consensus.csv': () =>
      new Raw(citizen ? citizen.consensusCsv() : '', 'text/csv; charset=utf-8', 'foldpass-citizen-consensus.csv'),

    'GET /api/data/classifications.jsonl': () =>
      archive && fs.existsSync(archive.classificationsFile)
        ? new Raw(fs.createReadStream(archive.classificationsFile), 'application/x-ndjson', 'foldpass-classifications.jsonl')
        : new Raw('', 'application/x-ndjson', 'foldpass-classifications.jsonl'),

    // ---------------------------------------------------------------- open data

    /** Dataset card + per-sequence aggregates (energy histograms, top distinct folds). */
    'GET /api/data/summary.json': () => ({
      dataset: 'FoldPass validated HP folding results',
      schema: 'foldpass.validated.v1',
      license: 'CC0-1.0',
      model: { lattice: '2D square', energy: 'HP: E = -1 per non-bonded H-H contact' },
      solver: SOLVER_VERSION,
      validation: `each unit computed independently by ${config.replicas} devices; kept only on bit-identical fingerprints`,
      caveat: 'Histograms are raw counts from a biased chain-growth sampler, not Boltzmann-weighted density-of-states estimates.',
      archiveBytes: archive?.size() ?? 0,
      totals: {
        validatedUnits: Object.values(state.science).reduce((a, s) => a + s.units, 0),
        conformations: Object.values(state.science).reduce((a, s) => a + s.conformations, 0),
      },
      benchmarks: BENCHMARKS.map((b) => {
        const sci = state.science[b.id] || { units: 0, conformations: 0, deadEnds: 0, histogram: [], topFolds: [] };
        return { id: b.id, name: b.name, sequence: b.sequence, amino: b.amino ?? null, bestKnown: b.bestKnown, ...sci };
      }),
    }),

    /** Every validated unit, one JSON object per line. ?benchmark=S1-20 filters. */
    'GET /api/data/validated.jsonl': (_b, ctx) => {
      const filter = ctx.query.get('benchmark');
      if (!archive?.exists()) return new Raw('', 'application/x-ndjson', 'foldpass-validated.jsonl');
      if (!filter) return new Raw(fs.createReadStream(archive.file), 'application/x-ndjson', 'foldpass-validated.jsonl');
      const lines = fs.readFileSync(archive.file, 'utf8').split('\n').filter((l) => l && JSON.parse(l).benchmark === filter);
      return new Raw(lines.join('\n') + (lines.length ? '\n' : ''), 'application/x-ndjson', `foldpass-${filter}.jsonl`);
    },

    /** Best validated distinct folds per sequence, as a spreadsheet-friendly CSV. */
    'GET /api/data/best-folds.csv': () => {
      const rows = [['benchmark', 'sequence', 'best_known_contacts', 'contacts', 'energy', 'found_by_units', 'first_unit', 'fold_canonical']];
      for (const b of BENCHMARKS) {
        for (const f of state.science[b.id]?.topFolds ?? []) {
          rows.push([b.id, b.sequence, b.bestKnown ?? '', f.contacts, -f.contacts, f.foundBy, f.unitId, f.fold]);
        }
      }
      return new Raw(rows.map((r) => r.join(',')).join('\n') + '\n', 'text/csv; charset=utf-8', 'foldpass-best-folds.csv');
    },

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
      return { ok: true, message: `Welcome, ${email}! Your sign-up passed FoldPass (${v.task === 'classify' ? 'citizen-science task' : `work unit ${v.unitId}`}).` };
    },
  };

  // ------------------------------------------------------------------ HTTP plumbing

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';

    // The widget may be embedded on other origins.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    // Every JSON helper below reads the request's Accept-Encoding through this.
    const json = (r, status, obj) => sendBody(req, r, status, JSON.stringify(obj), 'application/json');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const route = api[`${req.method} ${url.pathname}`];
    if (route) {
      const name = url.pathname.split('/').pop();
      if (rateLimited(name, ip)) return json(res, 429, { error: 'rate limited' });
      try {
        const body = req.method === 'POST' ? await readJson(req) : null;
        let out = await route(body, { ip, origin: req.headers.origin, query: url.searchParams });
        if (out instanceof Raw) {
          if (url.searchParams.has('download')) res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
          if (typeof out.body?.pipe === 'function') return sendStream(req, res, 200, out.body, out.type);
          return sendBody(req, res, 200, out.body, out.type);
        }
        let status = 200;
        if (Array.isArray(out)) [status, out] = out;
        return json(res, status, out);
      } catch (err) {
        if (err.status) return json(res, err.status, { error: err.message });
        console.error(err);
        return json(res, 500, { error: 'internal error' });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, req, res, json);
    return json(res, 404, { error: 'not found' });
  };
}

function hostnameOf(origin) {
  try {
    return origin ? new URL(origin).hostname : null;
  } catch {
    return null;
  }
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

function serveStatic(pathname, req, res, json) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { error: 'bad path' });
  }
  const prefix = decoded.startsWith('/shared/') ? '/shared/' : '/';
  const base = STATIC_DIRS[prefix];
  let file = path.resolve(base, '.' + decoded.slice(prefix.length - 1));
  if (file !== base && !file.startsWith(base + path.sep)) return json(res, 403, { error: 'forbidden' });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && !path.extname(file)) file += '.html';
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'not found' });
    fs.readFile(file, (err2, data) => {
      if (err2) return json(res, 404, { error: 'not found' });
      sendStatic(req, res, file, stat, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  });
}
