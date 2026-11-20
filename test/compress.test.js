import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createApp } from '../server/app.js';
import { emptyState } from '../server/coordinator.js';
import { CONFIG } from '../server/config.js';
import { pickEncoding } from '../server/compress.js';

test('pickEncoding prefers br, honours q=0', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip;q=1, br;q=0'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(''), null);
});

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('static files and JSON are compressed and revalidated with ETags', async (t) => {
  const config = { ...CONFIG, citizen: { ...CONFIG.citizen, enabled: false } };
  const server = http.createServer(createApp({ config, state: emptyState(), secret: 's' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => server.close());

  const plain = await get(port, '/shared/hp.js');
  const br = await get(port, '/shared/hp.js', { 'accept-encoding': 'br, gzip' });
  const gz = await get(port, '/shared/hp.js', { 'accept-encoding': 'gzip' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(br.body.length < plain.body.length / 2, `br ${br.body.length} vs ${plain.body.length}`);
  assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);
  assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);
  assert.match(br.headers.vary, /Accept-Encoding/);

  const again = await get(port, '/shared/hp.js', { 'if-none-match': plain.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  const stats = await get(port, '/api/stats', { 'accept-encoding': 'gzip' });
  assert.equal(stats.headers['content-encoding'], 'gzip');
  assert.ok(JSON.parse(zlib.gunzipSync(stats.body)).stats);

  const small = await get(port, '/api/nope', { 'accept-encoding': 'br' });
  assert.equal(small.headers['content-encoding'], undefined, 'tiny bodies are sent as-is');
});
