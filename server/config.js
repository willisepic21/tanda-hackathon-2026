import path from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;

export const CONFIG = {
  port: Number(env.PORT || 8080),
  // 0.0.0.0 so phones/laptops on the same network can join as devices.
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR ? pathToFileURL(path.resolve(env.DATA_DIR) + path.sep) : new URL('../data/', import.meta.url),
  trustProxy: env.TRUST_PROXY === '1',

  // --- Replication / validation ---
  replicas: 2, // matching results from distinct devices needed to validate a unit
  maxReplicas: 4, // after this many results without agreement a unit is "inconclusive"
  // Require the replicas to come from different IPs, not just different device IDs.
  // Off by default so you can demo with several tabs on one machine.
  distinctIp: env.QUORUM_DISTINCT_IP === '1',
  trustFloor: -3, // devices at or below this trust score don't count toward quorum
  knownAnswerRate: 0.2, // fraction of CAPTCHAs that re-issue an already-validated unit

  // --- Work sizing (calibrated so a desktop solves a unit in ~0.5-1.5s) ---
  attempts: { light: 120_000, standard: 250_000 },

  // --- CAPTCHA ---
  powBits: { desktop: 18, mobile: 15 }, // hashcash difficulty: this is the real bot gate
  challengeTtlMs: 3 * 60_000,
  leaseTtlMs: 3 * 60_000,
  passTtlMs: 2 * 60_000,

  // site key -> secret. The host site's backend calls /api/siteverify with the secret.
  // `origins`: hostnames allowed to request challenges with this key (empty = any).
  sites: {
    'demo-site-key': { secret: env.DEMO_SITE_SECRET || 'demo-secret-change-me', name: 'FoldPass demo', origins: [] },
    'locked-site-key': { secret: 'locked-secret', name: 'Origin-locked example', origins: ['example.com'] },
  },

  // --- Citizen-science human tasks (Zooniverse) ---
  // Default: SquirrelMapper, "How many squirrels are in this image?" (0 / 1 / 2 or more).
  citizen: {
    enabled: env.CITIZEN !== '0',
    api: 'https://www.zooniverse.org/api',
    project: Number(env.ZOONIVERSE_PROJECT || 8149),
    workflow: Number(env.ZOONIVERSE_WORKFLOW || 30253),
    task: env.ZOONIVERSE_TASK || 'T0',
    poolSize: 30, // keep this many subjects that still need answers
    retireAfter: 5, // counted answers before a subject can reach consensus
    consensus: 0.8, // agreement needed to become a known-answer subject
    maxVotes: 10, // give up ("ambiguous") after this many without consensus
    bootstrap: true, // count answers while no known-answer subjects exist yet
    minHumanMs: 1500, // faster than this from challenge to answer = not a human
    // Sending answers to Zooniverse. Needs written permission from Zooniverse
    // and the project team, plus a bearer token for an account they approved.
    forward: { enabled: env.ZOONIVERSE_FORWARD === '1', token: env.ZOONIVERSE_TOKEN || '' },
  },

  // Requests per minute per IP.
  rateLimits: { device: 20, challenge: 40, solve: 40, work: 240, result: 240 },
};
