import crypto from 'node:crypto';

/**
 * Stateless HMAC-signed tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * Every payload carries a `typ` so a token minted for one purpose
 * (e.g. a device ID) can never be replayed as another (e.g. a pass token).
 */
export function createSigner(secret) {
  const mac = (body) => crypto.createHmac('sha256', secret).update(body).digest();

  return {
    sign(typ, payload) {
      const body = Buffer.from(JSON.stringify({ ...payload, typ })).toString('base64url');
      return `${body}.${mac(body).toString('base64url')}`;
    },

    /** Returns the payload, or null if the signature, type or expiry is wrong. */
    verify(typ, token, now = Date.now()) {
      if (typeof token !== 'string' || token.length > 4096) return null;
      const [body, sig] = token.split('.');
      if (!body || !sig) return null;
      const expected = mac(body);
      const got = Buffer.from(sig, 'base64url');
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (payload.typ !== typ) return null;
      if (payload.exp && payload.exp < now) return null;
      return payload;
    },
  };
}

/** Server-side PoW check using Node's native SHA-256. */
export function verifyPow(prefix, nonce, bits) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  const digest = crypto.createHash('sha256').update(`${prefix}:${nonce}`).digest();
  let zeros = 0;
  for (const byte of digest) {
    if (byte === 0) { zeros += 8; continue; }
    zeros += Math.clz32(byte) - 24;
    break;
  }
  return zeros >= bits;
}

export const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
