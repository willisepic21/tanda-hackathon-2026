import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';
import { openArchive } from './archive.js';

const store = openStore(CONFIG.dataDir);
const archive = openArchive(CONFIG.dataDir, store.secret);
const handler = createApp({ config: CONFIG, state: store.state, secret: store.secret, archive, save: store.save });
const server = http.createServer(handler);

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`FoldPass running:`);
  console.log(`  Demo sign-up   http://localhost:${CONFIG.port}/`);
  console.log(`  Dashboard      http://localhost:${CONFIG.port}/dashboard`);
  console.log(`  Volunteer      http://localhost:${CONFIG.port}/volunteer`);
  console.log(`  Open data      http://localhost:${CONFIG.port}/data`);
  console.log(`  Results file   ${fileURLToPath(archive.file)}`);
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  for (const i of lan) console.log(`  Other devices  http://${i.address}:${CONFIG.port}/volunteer`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
