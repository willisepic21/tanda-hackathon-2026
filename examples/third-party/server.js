// A pretend third-party website on its OWN origin, showing a real integration:
// the page loads the SDK from the FoldPass host, and this backend verifies
// tokens with the Node server SDK and the site secret.
//
//   node examples/third-party/server.js [FOLDPASS_URL] [PORT]
//   e.g. node examples/third-party/server.js http://localhost:8080 5173

import http from 'node:http';
import fs from 'node:fs';
import { createVerifier } from '../../sdk/node/foldpass-server.js';

const FOLDPASS = (process.argv[2] || process.env.FOLDPASS_URL || 'http://localhost:8080').replace(/\/$/, '');
const PORT = Number(process.argv[3] || process.env.PORT || 5173);
const page = fs.readFileSync(new URL('index.html', import.meta.url), 'utf8').replaceAll('{{FOLDPASS}}', FOLDPASS);

const foldpass = createVerifier({
  host: FOLDPASS,
  secret: process.env.FOLDPASS_SITE_SECRET || 'demo-secret-change-me',
  hostnames: ['localhost', '127.0.0.1'], // only accept tokens solved on this site
});

http
  .createServer(async (req, res) => {
    if (req.method === 'POST' && (req.url === '/signup' || req.url === '/subscribe')) {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      const result = await foldpass.verify(body.token);
      res.writeHead(result.success ? 200 : 403, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify(
          result.success
            ? {
                ok: true,
                message:
                  result.task === 'classify'
                    ? `Verified by FoldPass: solved on ${result.hostname} by answering a citizen-science question.`
                    : `Verified by FoldPass: solved on ${result.hostname}, work unit ${result.unitId} (${result.unitStatus}).`,
              }
            : { ok: false, message: `Rejected: ${result.reason}` },
        ),
      );
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  })
  .listen(PORT, () => console.log(`Example site on http://localhost:${PORT} using FoldPass at ${FOLDPASS}`));
