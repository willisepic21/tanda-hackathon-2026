import fs from 'node:fs';
import crypto from 'node:crypto';
import { emptyState } from './coordinator.js';

/** Tiny JSON-file persistence: load once, save debounced. Good enough for a demo. */
export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = new URL('state.json', dataDir);
  const secretFile = new URL('secret.key', dataDir);

  let secret = process.env.FOLDPASS_SECRET;
  if (!secret) {
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  }

  let state = emptyState();
  if (fs.existsSync(stateFile)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state = { ...state, ...loaded, stats: { ...state.stats, ...loaded.stats } };
    } catch (err) {
      console.warn(`Could not read ${stateFile.pathname}, starting fresh:`, err.message);
    }
  }

  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = new URL('state.json.tmp', dataDir);
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  };

  return {
    secret,
    state,
    save() {
      if (!timer) timer = setTimeout(flush, 1000);
    },
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}
