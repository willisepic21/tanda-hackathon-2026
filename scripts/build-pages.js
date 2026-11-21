#!/usr/bin/env node
// Build the static site for GitHub Pages.
//
//   node scripts/build-pages.js --api https://foldpass-tanda.fly.dev [--out dist-pages]
//   (or set FOLDPASS_API; add --allow-http only for local testing)
//
// GitHub Pages can only host static files, so the pages are published there
// and talk to a FoldPass server hosted elsewhere (Render, Fly.io, Railway, a
// VPS...). The API URL is written to config.js, which you can also edit
// directly on the gh-pages branch later without rebuilding.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const api = (arg('--api') ?? process.env.FOLDPASS_API ?? '').trim().replace(/\/$/, '');
const out = path.resolve(ROOT, arg('--out') ?? 'dist-pages');

if (api && !/^https:\/\/[^/]+/.test(api) && !args.includes('--allow-http')) {
  console.error(`--api must be an https:// URL (GitHub Pages is served over https, so an http API would be blocked). Got: ${api}`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), out, { recursive: true });
fs.cpSync(path.join(ROOT, 'shared'), path.join(out, 'shared'), { recursive: true });

const notConnected = `
// No API URL was set at build time: tell visitors instead of failing silently.
document.addEventListener('DOMContentLoaded', function () {
  var main = document.querySelector('main');
  if (!main) return;
  var p = document.createElement('p');
  p.className = 'notice err';
  p.textContent = 'This copy of FoldPass is not connected to a FoldPass server yet, so the CAPTCHA and live data will not load. Set the server URL in config.js.';
  main.prepend(p);
});`;

fs.writeFileSync(
  path.join(out, 'config.js'),
  `// Where the FoldPass API lives. Edit this line to point the site at your server.
window.FOLDPASS_API = ${JSON.stringify(api)};
${api ? '' : notConnected}
`,
);

// Serve files as-is (no Jekyll processing), and send unknown paths home.
fs.writeFileSync(path.join(out, '.nojekyll'), '');
fs.copyFileSync(path.join(out, 'index.html'), path.join(out, '404.html'));

fs.writeFileSync(
  path.join(out, 'README.md'),
  `# FoldPass: GitHub Pages build

This branch is generated. Don't edit it by hand except \`config.js\`.

- Source: the \`main\` branch (\`public/\` and \`shared/\`).
- Rebuild: \`node scripts/build-pages.js --api https://foldpass-tanda.fly.dev\`
- API server: run \`npm start\` from \`main\` on any Node host. Its URL goes in \`config.js\`.
`,
);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p) : files.push(p);
  }
})(out);
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`Built ${files.length} files (${(bytes / 1024).toFixed(0)} KB) into ${path.relative(ROOT, out)}`);
console.log(api ? `API: ${api}` : 'API: not set. The site will show a "not connected" notice until config.js is edited.');
