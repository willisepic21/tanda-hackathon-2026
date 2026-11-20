import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * The permanent, public results archive: one JSON line per validated unit,
 * append-only. This is the scientific output of the network. The state file
 * is just working memory and gets trimmed; this file never does.
 *
 * Device IDs are replaced with a keyed hash before writing, so the dataset
 * can be published without exposing the IDs devices authenticate with.
 */
export function openArchive(dataDir, secret) {
  const dir = new URL('results/', dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = new URL('validated.jsonl', dir);
  const classificationsFile = new URL('classifications.jsonl', dir);
  const anonymize = (id) => crypto.createHmac('sha256', `${secret}:archive`).update(id).digest('hex').slice(0, 12);

  return {
    file,
    append(record) {
      const line = { ...record, replicas: record.replicas.map((r) => ({ ...r, device: anonymize(r.device) })) };
      fs.appendFileSync(file, JSON.stringify(line) + '\n');
    },
    classificationsFile,
    /** One line per citizen-science answer (device hashed). */
    appendClassification(rec) {
      fs.appendFileSync(classificationsFile, JSON.stringify({ ...rec, device: anonymize(rec.device) }) + '\n');
    },
    exists: () => fs.existsSync(file),
    readAll() {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    size: () => (fs.existsSync(file) ? fs.statSync(file).size : 0),
  };
}
