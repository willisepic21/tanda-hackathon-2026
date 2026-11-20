import { BENCHMARKS, BENCHMARK_BY_ID } from '../shared/benchmarks.js';
import { evaluateFold, mulberry32, canonicalFold, SOLVER_VERSION } from '../shared/hp.js';

/**
 * The coordinator hands out work units, collects results and decides which
 * results to trust. It is pure in-memory logic (no I/O) so it is easy to test.
 *
 * Lifecycle of a unit:
 *   open        -> waiting for `replicas` matching results from distinct devices
 *   disputed    -> results disagree; issued to extra devices as a tie-breaker
 *   validated   -> `replicas` devices produced bit-identical results
 *   inconclusive-> `maxReplicas` results and still no agreement (dropped)
 *
 * Validated units are later re-issued as "known-answer" spot checks: a device
 * that returns something different from the canonical result is caught.
 *
 * Every validated unit is emitted once via `onValidated(record)` (the server
 * appends it to the permanent results archive) and folded into per-sequence
 * aggregates in `state.science`.
 */

const TOP_FOLDS = 12;

const MAX_UNITS = 5000;
const FEED_LEN = 60;

export function emptyState() {
  return {
    version: 1,
    devices: {},
    units: {},
    seedCounters: {},
    best: {}, // benchmarkId -> { fold, contacts, unitId, devices, at }
    // benchmarkId -> { units, conformations, deadEnds, histogram[], topFolds[] }
    science: {},
    feed: [],
    stats: {
      conformations: 0, // total chain-growth attempts computed by all devices
      cpuMs: 0, // client-reported compute time
      resultsAccepted: 0,
      resultsRejected: 0,
      unitsCreated: 0,
      unitsValidated: 0,
      unitsInconclusive: 0,
      knownAnswerChecks: 0,
      knownAnswerFailures: 0,
      captchaIssued: 0,
      captchaPassed: 0,
      captchaFailed: 0,
      captchaMsTotal: 0,
    },
  };
}

export class Coordinator {
  constructor(state, config, { rand = Math.random, now = Date.now, onValidated } = {}) {
    this.s = state;
    this.onValidated = onValidated;
    this.cfg = config;
    this.rand = rand;
    this.now = now;
    this.benchCursor = 0;
  }

  // ---------------------------------------------------------------- devices

  registerDevice(id, { label, ip } = {}) {
    const t = this.now();
    this.s.devices[id] = {
      id,
      label: String(label || '').slice(0, 40),
      created: t,
      lastSeen: t,
      lastIp: ip,
      trust: 0,
      submitted: 0,
      agreed: 0,
      disagreed: 0,
      rejected: 0,
      conformations: 0,
      cpuMs: 0,
    };
    return this.s.devices[id];
  }

  device(id) {
    return this.s.devices[id] || this.registerDevice(id);
  }

  isTrusted(deviceId) {
    return this.device(deviceId).trust > this.cfg.trustFloor;
  }

  // ---------------------------------------------------------------- work assignment

  /**
   * Choose a unit for a device. Priority:
   *   1. units that still need a replica (so validation completes quickly),
   *   2. (captcha mode only) a known-answer spot check,
   *   3. a brand-new unit.
   */
  assign(deviceId, { ip, mobile = false, mode = 'volunteer' } = {}) {
    const t = this.now();
    const dev = this.device(deviceId);
    dev.lastSeen = t;
    dev.lastIp = ip;
    const tierOk = (u) => !mobile || BENCHMARK_BY_ID[u.benchmarkId].tier === 'light';

    // Units closest to validation (most results already in) go first.
    const pending = Object.values(this.s.units)
      .filter((u) => (u.status === 'open' || u.status === 'disputed') && tierOk(u) && this.canTake(u, deviceId, ip))
      .sort((a, b) => b.results.length - a.results.length || a.created - b.created);
    for (const unit of pending) {
      this.pruneLeases(unit, t);
      const counted = unit.results.filter((r) => r.trusted).length;
      if (counted + Object.keys(unit.leases).length < this.replicasWanted(unit)) {
        return this.lease(unit, deviceId, t, false);
      }
    }

    if (mode === 'captcha' && this.rand() < this.cfg.knownAnswerRate) {
      const known = Object.values(this.s.units).filter(
        (u) => u.status === 'validated' && tierOk(u) && this.canTake(u, deviceId, ip),
      );
      if (known.length) return this.lease(known[Math.floor(this.rand() * known.length)], deviceId, t, true);
    }

    return this.lease(this.createUnit(mobile), deviceId, t, false);
  }

  canTake(unit, deviceId, ip) {
    if (unit.leases[deviceId]) return false;
    if (unit.results.some((r) => r.deviceId === deviceId)) return false;
    if (this.cfg.distinctIp && ip && unit.results.some((r) => r.ip === ip)) return false;
    return true;
  }

  replicasWanted(unit) {
    if (unit.status === 'disputed') return Math.min(unit.results.filter((r) => r.trusted).length + 1, this.cfg.maxReplicas);
    return this.cfg.replicas;
  }

  pruneLeases(unit, t) {
    for (const [d, exp] of Object.entries(unit.leases)) if (exp < t) delete unit.leases[d];
  }

  lease(unit, deviceId, t, known) {
    unit.leases[deviceId] = t + this.cfg.leaseTtlMs;
    return { unit, known };
  }

  createUnit(mobile) {
    const pool = BENCHMARKS.filter((b) => !mobile || b.tier === 'light');
    const bench = pool[this.benchCursor++ % pool.length];
    const k = (this.s.seedCounters[bench.id] = (this.s.seedCounters[bench.id] || 0) + 1);
    // Derive a well-mixed uint32 seed from (benchmark, counter).
    let h = 0x811c9dc5;
    for (const ch of `${bench.id}#${k}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const seed = mulberry32(h)();
    const unit = {
      id: `${bench.id}.${k}`,
      benchmarkId: bench.id,
      sequence: bench.sequence,
      seed,
      attempts: this.cfg.attempts[bench.tier],
      solver: SOLVER_VERSION,
      status: 'open',
      created: this.now(),
      leases: {},
      results: [],
      audits: [],
      canonical: null,
    };
    this.s.units[unit.id] = unit;
    this.s.stats.unitsCreated++;
    this.trimUnits();
    return unit;
  }

  trimUnits() {
    const ids = Object.keys(this.s.units);
    if (ids.length <= MAX_UNITS) return;
    // Drop the oldest finished units first.
    const done = ids
      .map((id) => this.s.units[id])
      .filter((u) => u.status === 'validated' || u.status === 'inconclusive')
      .sort((a, b) => a.created - b.created);
    for (const u of done.slice(0, ids.length - MAX_UNITS)) delete this.s.units[u.id];
  }

  publicUnit(unit) {
    const b = BENCHMARK_BY_ID[unit.benchmarkId];
    return { id: unit.id, benchmarkId: unit.benchmarkId, name: b?.name ?? unit.benchmarkId, amino: b?.amino ?? null, sequence: unit.sequence, seed: unit.seed, attempts: unit.attempts, solver: unit.solver };
  }

  // ---------------------------------------------------------------- result submission

  /**
   * Check and record a result. Returns
   *   { ok: false, reason }                       — rejected (cheating or malformed)
   *   { ok: true, status, known, matched, ... }   — accepted
   * For known-answer units `matched` says whether it equalled the canonical result.
   */
  submit(deviceId, unitId, result, { ip } = {}) {
    const t = this.now();
    const dev = this.device(deviceId);
    dev.lastSeen = t;
    const unit = this.s.units[unitId];
    if (!unit) return { ok: false, reason: 'unknown unit' };
    if (unit.results.some((r) => r.deviceId === deviceId) || unit.audits.some((r) => r.deviceId === deviceId)) {
      return { ok: false, reason: 'this device already submitted this unit' };
    }

    const problem = this.checkResult(unit, result);
    if (problem) {
      dev.rejected++;
      dev.trust -= 1;
      this.s.stats.resultsRejected++;
      this.pushFeed({ type: 'rejected', unitId, deviceId, reason: problem });
      return { ok: false, reason: problem };
    }

    delete unit.leases[deviceId];
    const key = resultKey(result);
    const ms = Math.max(0, Math.min(Number(result.ms) || 0, 120_000));
    dev.submitted++;
    dev.conformations += unit.attempts;
    dev.cpuMs += ms;
    this.s.stats.resultsAccepted++;
    this.s.stats.conformations += unit.attempts;
    this.s.stats.cpuMs += ms;
    const record = {
      deviceId, ip, key, ms, at: t,
      fold: result.fold, contacts: result.contacts, checksum: result.checksum, dead: result.dead, histogram: result.histogram,
    };

    // Known-answer spot check: the canonical result is already established.
    if (unit.status === 'validated') {
      const matched = key === unit.canonical.key;
      unit.audits.push({ ...record, matched });
      this.s.stats.knownAnswerChecks++;
      if (matched) {
        dev.trust += 1;
        dev.agreed++;
      } else {
        dev.trust -= 2;
        dev.disagreed++;
        this.s.stats.knownAnswerFailures++;
      }
      this.pushFeed({ type: matched ? 'known-ok' : 'known-fail', unitId, deviceId, contacts: result.contacts });
      return { ok: true, status: unit.status, known: true, matched, contacts: result.contacts };
    }

    record.trusted = this.isTrusted(deviceId);
    unit.results.push(record);
    this.evaluateQuorum(unit);
    if (unit.status !== 'validated') {
      this.pushFeed({ type: 'replica', unitId, deviceId, contacts: result.contacts, n: unit.results.length });
    }
    return {
      ok: true,
      status: unit.status,
      known: false,
      replicas: unit.results.filter((r) => r.trusted).length,
      needed: this.cfg.replicas,
      contacts: result.contacts,
    };
  }

  /** Cheap structural checks. Anything failing here is provably wrong, no replica needed. */
  checkResult(unit, r) {
    if (!r || typeof r !== 'object') return 'missing result';
    if (r.solver !== unit.solver) return `solver version ${r.solver} does not match unit (${unit.solver}); reload the page`;
    if (typeof r.fold !== 'string') return 'missing fold';
    if (!Number.isInteger(r.contacts) || r.contacts < 0) return 'bad contact count';
    if (typeof r.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(r.checksum)) return 'bad checksum';
    if (!Number.isInteger(r.dead) || r.dead < 0) return 'bad dead-end count';
    if (!Array.isArray(r.histogram) || r.histogram.length > unit.sequence.length) return 'bad histogram';
    if (!r.histogram.every((v) => Number.isInteger(v) && v >= 0)) return 'bad histogram';

    const ev = evaluateFold(unit.sequence, r.fold);
    if (!ev.valid) return `invalid fold: ${ev.error}`;
    if (ev.contacts !== r.contacts) return `fold has ${ev.contacts} contacts, claimed ${r.contacts}`;
    // Histogram must be internally consistent with the claimed best and attempt count.
    if (r.histogram.length !== r.contacts + 1 || r.histogram[r.contacts] === 0) return 'histogram does not match best fold';
    const sum = r.histogram.reduce((a, b) => a + b, 0) + r.dead;
    if (sum !== unit.attempts) return `histogram covers ${sum} attempts, unit has ${unit.attempts}`;
    return null;
  }

  evaluateQuorum(unit) {
    const trusted = unit.results.filter((r) => r.trusted);
    const groups = new Map();
    for (const r of trusted) groups.set(r.key, (groups.get(r.key) || 0) + 1);
    const winner = [...groups.entries()].find(([, count]) => count >= this.cfg.replicas);

    if (winner) {
      const [key] = winner;
      unit.status = 'validated';
      unit.validatedAt = this.now();
      unit.leases = {};
      unit.canonical = parseKey(key);
      this.s.stats.unitsValidated++;
      for (const r of unit.results) {
        const dev = this.device(r.deviceId);
        if (r.key === key) { dev.trust += 1; dev.agreed++; }
        else { dev.trust -= 2; dev.disagreed++; }
      }
      const agreeing = unit.results.filter((r) => r.key === key).map((r) => r.deviceId);
      this.updateBest(unit, agreeing);
      this.recordScience(unit);
      this.pushFeed({ type: 'validated', unitId: unit.id, contacts: unit.canonical.contacts, devices: agreeing });
    } else if (trusted.length >= this.cfg.maxReplicas) {
      unit.status = 'inconclusive';
      unit.leases = {};
      this.s.stats.unitsInconclusive++;
      this.pushFeed({ type: 'inconclusive', unitId: unit.id });
    } else if (trusted.length >= this.cfg.replicas) {
      if (unit.status !== 'disputed') this.pushFeed({ type: 'disputed', unitId: unit.id });
      unit.status = 'disputed';
    }
  }

  updateBest(unit, devices) {
    const cur = this.s.best[unit.benchmarkId];
    const { fold, contacts } = unit.canonical;
    if (!cur || contacts > cur.contacts) {
      this.s.best[unit.benchmarkId] = { fold, contacts, unitId: unit.id, devices, at: this.now() };
      this.pushFeed({ type: 'new-best', unitId: unit.id, benchmarkId: unit.benchmarkId, contacts });
    }
  }

  /** Emit a validated unit's archive record, then fold it into the per-sequence aggregates. */
  recordScience(unit) {
    const rec = this.archiveRecord(unit);
    this.onValidated?.(rec);
    unit.archived = true;
    this.addToScience(rec);
  }

  addToScience(rec) {
    const sci = (this.s.science[rec.benchmark] ||= { units: 0, conformations: 0, deadEnds: 0, histogram: [], topFolds: [] });
    sci.units++;
    sci.conformations += rec.attempts;
    sci.deadEnds += rec.dead_ends;
    rec.histogram.forEach((v, i) => (sci.histogram[i] = (sci.histogram[i] || 0) + v));

    const hit = sci.topFolds.find((f) => f.fold === rec.best_fold_canonical);
    if (hit) hit.foundBy++;
    else sci.topFolds.push({ fold: rec.best_fold_canonical, contacts: rec.contacts, unitId: rec.unit, foundBy: 1, at: Date.parse(rec.validated_at) });
    sci.topFolds.sort((a, b) => b.contacts - a.contacts || b.foundBy - a.foundBy || a.at - b.at);
    sci.topFolds.length = Math.min(sci.topFolds.length, TOP_FOLDS);
  }

  /** The archive is the source of truth: aggregates are recomputed from it on startup. */
  rebuildScience(records) {
    this.s.science = {};
    const seen = new Set();
    for (const rec of records) {
      if (seen.has(rec.unit)) continue;
      seen.add(rec.unit);
      this.addToScience(rec);
      if (this.s.units[rec.unit]) this.s.units[rec.unit].archived = true;
    }
  }

  /** One self-contained, reproducible line of the public dataset. */
  archiveRecord(unit) {
    const c = unit.canonical;
    return {
      schema: 'foldpass.validated.v1',
      unit: unit.id,
      benchmark: unit.benchmarkId,
      sequence: unit.sequence,
      lattice: '2D-square',
      energy_model: 'HP (E = -1 per non-bonded H-H contact)',
      solver: unit.solver,
      seed: unit.seed,
      attempts: unit.attempts,
      best_fold: c.fold,
      best_fold_canonical: canonicalFold(c.fold),
      contacts: c.contacts,
      energy: -c.contacts,
      histogram: c.histogram,
      dead_ends: c.dead,
      checksum: c.checksum,
      replicas: unit.results
        .filter((r) => r.key === c.key)
        .map((r) => ({ device: r.deviceId, compute_ms: r.ms, submitted_at: new Date(r.at).toISOString() })),
      disagreeing_replicas: unit.results.filter((r) => r.key !== c.key).length,
      validated_at: new Date(unit.validatedAt).toISOString(),
    };
  }

  /**
   * Units validated before the archive existed: rebuild their fingerprint from
   * the result key and archive them, so no validated work is lost.
   */
  backfillArchive() {
    let n = 0;
    for (const unit of Object.values(this.s.units)) {
      unit.solver ||= SOLVER_VERSION;
      if (unit.status !== 'validated' || unit.archived) continue;
      unit.validatedAt ||= unit.created;
      unit.canonical = parseKey(unit.canonical.key);
      this.recordScience(unit);
      n++;
    }
    return n;
  }

  pushFeed(ev) {
    this.s.feed.unshift({ ...ev, at: this.now() });
    this.s.feed.length = Math.min(this.s.feed.length, FEED_LEN);
  }

  // ---------------------------------------------------------------- stats

  snapshot() {
    const units = Object.values(this.s.units);
    const count = (st) => units.filter((u) => u.status === st).length;
    const awaiting = units.filter((u) => u.status === 'open' && u.results.length > 0).length;
    const devices = Object.values(this.s.devices);
    const recentUnits = units
      .filter((u) => u.results.length > 0)
      .sort((a, b) => lastActivity(b) - lastActivity(a))
      .slice(0, 15)
      .map((u) => ({
        id: u.id,
        benchmarkId: u.benchmarkId,
        status: u.status,
        replicas: u.results.map((r) => ({ device: short(r.deviceId), contacts: r.contacts, checksum: r.checksum, trusted: r.trusted, agrees: u.canonical ? r.key === u.canonical.key : null })),
        audits: u.audits.length,
      }));

    return {
      now: this.now(),
      config: { replicas: this.cfg.replicas, maxReplicas: this.cfg.maxReplicas, knownAnswerRate: this.cfg.knownAnswerRate, powBits: this.cfg.powBits },
      stats: { ...this.s.stats, devices: devices.length, activeDevices: devices.filter((d) => this.now() - d.lastSeen < 60_000).length },
      units: { open: count('open'), awaitingReplica: awaiting, disputed: count('disputed'), validated: count('validated'), inconclusive: count('inconclusive') },
      benchmarks: BENCHMARKS.map((b) => ({
        id: b.id,
        name: b.name,
        sequence: b.sequence,
        bestKnown: b.bestKnown,
        tier: b.tier,
        best: this.s.best[b.id] ? { ...this.s.best[b.id], devices: this.s.best[b.id].devices.map(short) } : null,
        validatedUnits: this.s.science[b.id]?.units ?? 0,
      })),
      recentUnits,
      feed: this.s.feed.slice(0, 25).map((e) => ({ ...e, deviceId: e.deviceId && short(e.deviceId), devices: e.devices?.map(short) })),
      devices: devices
        .sort((a, b) => b.conformations - a.conformations)
        .slice(0, 12)
        .map((d) => ({ id: short(d.id), label: d.label, trust: d.trust, submitted: d.submitted, agreed: d.agreed, disagreed: d.disagreed, rejected: d.rejected, conformations: d.conformations, active: this.now() - d.lastSeen < 60_000 })),
    };
  }
}

/** Two results "agree" only if every field of the deterministic fingerprint matches. */
export function resultKey(r) {
  return `${r.fold}|${r.contacts}|${r.checksum}|${r.dead}|${r.histogram.join(',')}`;
}

/** The key encodes the whole fingerprint, so the canonical result can always be rebuilt from it. */
export function parseKey(key) {
  const [fold, contacts, checksum, dead, hist] = key.split('|');
  return { key, fold, contacts: Number(contacts), checksum, dead: Number(dead), histogram: hist.split(',').map(Number) };
}

const short = (id) => String(id).slice(0, 6);
const lastActivity = (u) => Math.max(u.created, ...u.results.map((r) => r.at), ...u.audits.map((r) => r.at));
