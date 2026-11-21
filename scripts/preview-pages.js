#!/usr/bin/env node
// Serve dist-pages/ the way GitHub Pages will: under /<repo-name>/ on its own
// origin, so relative paths and the cross-origin API are tested for real.
//
//   node scripts/preview-pages.js [port] [base-path]
//   e.g. node scripts/preview-pages.js 4173 /tanda-hackathon-2026/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-pages');
const PORT = Number(process.argv[2] || 4173);
const BASE = process.argv[3] || '/tanda-hackathon-2026/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === BASE.slice(0, -1)) {
      res.writeHead(302, { location: BASE });
      return res.end();
    }
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404);
      return res.end('Not under ' + BASE);
    }
    let file = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname.slice(BASE.length - 1)));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html'; // Pages serves /page as /page.html
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      return fs.createReadStream(path.join(ROOT, '404.html')).pipe(res);
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`GitHub Pages preview: http://localhost:${PORT}${BASE}`));
