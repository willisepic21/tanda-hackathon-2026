import zlib from 'node:zlib';
import crypto from 'node:crypto';

// HTTP response compression (Brotli, then gzip), negotiated with Accept-Encoding.
// Static files are compressed once at maximum quality and cached in memory,
// keyed by path + mtime + size. Dynamic JSON uses fast settings. Streams
// (dataset downloads) are compressed on the fly.

const MIN_BYTES = 1024; // below this, the headers cost more than they save
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|x-ndjson|xml)|image\/svg\+xml)/;

export function pickEncoding(acceptEncoding = '') {
  const offered = new Map();
  for (const part of String(acceptEncoding).toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    offered.set(name, q ? Number(q.slice(2)) : 1);
  }
  const ok = (name) => (offered.get(name) ?? offered.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

const isCompressible = (type) => COMPRESSIBLE.test(type || '');

function compressSync(buf, encoding, quality) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality === 'max' ? 11 : 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    });
  }
  return zlib.gzipSync(buf, { level: quality === 'max' ? 9 : 6 });
}

/** Send a complete body, compressed when the client accepts it and it's worth it. */
export function sendBody(req, res, status, body, type) {
  if (type) res.setHeader('content-type', type);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  const encoding = buf.length >= MIN_BYTES && isCompressible(type) ? pickEncoding(req.headers['accept-encoding']) : null;
  res.setHeader('vary', 'Accept-Encoding');
  const out = encoding ? compressSync(buf, encoding, 'fast') : buf;
  if (encoding) res.setHeader('content-encoding', encoding);
  res.setHeader('content-length', out.length);
  res.writeHead(status);
  res.end(req.method === 'HEAD' ? undefined : out);
}

/** Pipe a stream (e.g. a dataset file), compressing on the fly. */
export function sendStream(req, res, status, stream, type) {
  res.setHeader('content-type', type);
  res.setHeader('vary', 'Accept-Encoding');
  const encoding = isCompressible(type) ? pickEncoding(req.headers['accept-encoding']) : null;
  if (encoding) res.setHeader('content-encoding', encoding);
  res.writeHead(status);
  if (req.method === 'HEAD') {
    stream.destroy?.();
    return res.end();
  }
  const z = encoding === 'br' ? zlib.createBrotliCompress() : encoding === 'gzip' ? zlib.createGzip() : null;
  (z ? stream.pipe(z) : stream).pipe(res);
}

const staticCache = new Map(); // file -> { key, etag, raw, br?, gzip? }

/**
 * Serve a static file with a strong ETag (304 on match) and a cached
 * max-quality compressed copy per encoding.
 */
export function sendStatic(req, res, file, stat, data, type) {
  const key = `${stat.mtimeMs}:${stat.size}`;
  let entry = staticCache.get(file);
  if (!entry || entry.key !== key) {
    entry = { key, etag: `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20)}"`, raw: data };
    staticCache.set(file, entry);
  }
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-cache'); // always revalidate; the ETag makes that cheap
  res.setHeader('etag', entry.etag);
  res.setHeader('vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304);
    return res.end();
  }
  const encoding = entry.raw.length >= MIN_BYTES && isCompressible(type) ? pickEncoding(req.headers['accept-encoding']) : null;
  let out = entry.raw;
  if (encoding) {
    entry[encoding] ||= compressSync(entry.raw, encoding, 'max');
    out = entry[encoding];
    res.setHeader('content-encoding', encoding);
  }
  res.setHeader('content-length', out.length);
  res.writeHead(200);
  res.end(req.method === 'HEAD' ? undefined : out);
}
