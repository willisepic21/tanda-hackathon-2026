// FoldPass server-side SDK for Node 18+ (uses global fetch, no dependencies).
//
//   import { createVerifier } from './foldpass-server.js';
//   const foldpass = createVerifier({ secret: process.env.FOLDPASS_SECRET, host: 'https://foldpass-tanda.fly.dev', hostnames: ['mysite.com'] });
//   const r = await foldpass.verify(req.body['fold-captcha-token']);
//   if (!r.success) return res.status(403).send(r.reason);
//
// Or as Express/Connect middleware:
//   app.post('/signup', foldpass.middleware(), (req, res) => …);   // req.foldpass holds the result

/**
 * @param {object} o
 * @param {string} o.secret     Your site secret (never ship it to the browser).
 * @param {string} o.host       Base URL of the FoldPass server.
 * @param {string[]} [o.hostnames]  If set, reject tokens solved on any other page hostname.
 * @param {number} [o.timeoutMs=5000]
 */
export function createVerifier({ secret, host, hostnames, timeoutMs = 5000 }) {
  if (!secret) throw new Error('FoldPass: secret is required');
  if (!host) throw new Error('FoldPass: host is required');
  const endpoint = new URL('/api/siteverify', host).href;

  async function verify(token) {
    if (!token || typeof token !== 'string') return { success: false, reason: 'missing token' };
    let data;
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, secret }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await r.json();
    } catch (err) {
      // Fail closed: if FoldPass is unreachable the token is not accepted.
      return { success: false, reason: `verification unavailable: ${err.message}` };
    }
    if (data.success && hostnames?.length && !hostnames.includes(data.hostname)) {
      return { ...data, success: false, reason: `token was solved on ${data.hostname ?? 'an unknown host'}` };
    }
    return data;
  }

  /** Express/Connect middleware. Reads the token from body (form or JSON) or the x-foldpass-token header. */
  function middleware({ field = 'fold-captcha-token', onFail } = {}) {
    return async (req, res, next) => {
      const token = req.body?.[field] ?? req.body?.token ?? req.headers['x-foldpass-token'];
      const result = await verify(token);
      req.foldpass = result;
      if (result.success) return next();
      if (onFail) return onFail(req, res, result);
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'captcha failed', reason: result.reason }));
    };
  }

  return { verify, middleware };
}
