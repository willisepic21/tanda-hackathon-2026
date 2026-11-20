// Citizen-science human tasks, reCAPTCHA-style.
//
// Each "classify" CAPTCHA shows the visitor two images from a live Zooniverse
// workflow and asks that workflow's real question:
//   - one image whose answer is already known (crowd consensus) -> the check
//   - one image that still needs answers                         -> the contribution
// The visitor can't tell which is which. Getting the known one wrong fails
// the CAPTCHA, and only answers from visitors who passed a known-answer check
// are counted toward consensus.
//
// Subjects and the question are read from the public Panoptes API (no login).
// Answers are stored here and exported for the research team. Sending them
// to Zooniverse is OFF unless the operator has permission from Zooniverse and
// the project team, and configures a token (see forwardClassification).

const ACCEPT = 'application/vnd.api+json; version=1';

export function emptyCitizenState() {
  return {
    workflow: null, // cached task definition
    subjects: {}, // id -> { id, image, votes[], counted, status, consensus, agreement, by[] }
    stats: { shown: 0, classifications: 0, counted: 0, goldChecks: 0, goldFailures: 0, forwarded: 0, forwardErrors: 0 },
  };
}

/** Strip Zooniverse markdown (images, emphasis) from answer labels. */
export function cleanLabel(label) {
  return String(label)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class CitizenScience {
  constructor(state, cfg, { fetch: fetchImpl = globalThis.fetch, now = Date.now, rand = Math.random, onClassification } = {}) {
    this.s = state;
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.now = now;
    this.rand = rand;
    this.onClassification = onClassification;
    this.lastRefill = 0;
    this.refilling = null;
  }

  get workflow() {
    return this.s.workflow;
  }

  async get(path) {
    const r = await this.fetch(`${this.cfg.api}${path}`, { headers: { accept: ACCEPT }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Zooniverse API ${r.status} on ${path}`);
    return r.json();
  }

  /** Load the workflow's question and a first batch of subjects. Safe to call repeatedly. */
  async init() {
    const { project, workflow, task } = this.cfg;
    const [wj, pj] = await Promise.all([this.get(`/workflows/${workflow}`), this.get(`/projects/${project}`)]);
    const w = wj.workflows[0];
    const p = pj.projects[0];
    const t = w.tasks[task];
    if (!t || t.type !== 'single') throw new Error(`workflow ${workflow} task ${task} is not a single-answer question`);
    this.s.workflow = {
      project: String(project),
      projectName: p.display_name,
      projectSlug: p.slug,
      projectUrl: `https://www.zooniverse.org/projects/${p.slug}`,
      workflow: String(workflow),
      workflowName: w.display_name,
      version: w.version,
      task,
      question: cleanLabel(t.question),
      answers: t.answers.map((a) => cleanLabel(a.label)),
      fetchedAt: this.now(),
    };
    await this.refill(true);
    return this.s.workflow;
  }

  openSubjects() {
    return Object.values(this.s.subjects).filter((s) => s.status === 'open');
  }

  goldSubjects() {
    return Object.values(this.s.subjects).filter((s) => s.status === 'consensus');
  }

  /** Top up the pool of subjects that still need answers (throttled). */
  async refill(force = false) {
    if (!this.workflow) return;
    if (this.openSubjects().length >= this.cfg.poolSize) return;
    if (!force && this.now() - this.lastRefill < 30_000) return;
    if (this.refilling) return this.refilling;
    this.lastRefill = this.now();
    this.refilling = (async () => {
      try {
        const j = await this.get(`/subjects/queued?workflow_id=${this.cfg.workflow}&page_size=20`);
        for (const sub of j.subjects || []) {
          if (this.s.subjects[sub.id] || sub.retired) continue;
          // Single-image subjects only: the question is about "this image".
          if (!Array.isArray(sub.locations) || sub.locations.length !== 1) continue;
          const image = Object.values(sub.locations[0])[0];
          if (typeof image !== 'string' || !/^https:\/\//.test(image)) continue;
          this.s.subjects[sub.id] = {
            id: String(sub.id),
            image,
            votes: this.workflow.answers.map(() => 0),
            counted: 0,
            unverified: 0,
            status: 'open',
            consensus: null,
            agreement: null,
            by: [],
            added: this.now(),
          };
        }
      } catch (err) {
        console.warn('[citizen] refill failed:', err.message);
      } finally {
        this.refilling = null;
      }
    })();
    return this.refilling;
  }

  available() {
    return !!this.workflow && this.openSubjects().length > 0;
  }

  /**
   * Pick the images for one CAPTCHA: one known-answer subject (if any exist)
   * and one subject that needs answers, in random order.
   */
  pick(deviceId) {
    this.refill().catch(() => {});
    const fresh = (s) => !s.by.includes(deviceId);
    const open = this.openSubjects().filter(fresh).sort((a, b) => a.counted - b.counted || a.added - b.added);
    if (!open.length) return null;
    // Spread work: choose among the least-answered few at random.
    const unknown = open[Math.floor(this.rand() * Math.min(open.length, 5))];
    const golds = this.goldSubjects().filter(fresh);
    const gold = golds.length ? golds[Math.floor(this.rand() * golds.length)] : null;
    const items = gold ? [gold, unknown] : [unknown];
    if (items.length === 2 && this.rand() < 0.5) items.reverse();
    this.s.stats.shown++;
    return { subjectIds: items.map((s) => s.id), bootstrap: !gold, items: items.map((s) => ({ image: s.image })) };
  }

  /**
   * Grade and record one visitor's answers. Returns { ok, reason?, verified, counted }.
   * `bootstrap` is true when no known-answer subject existed when the challenge was issued.
   */
  submit(deviceId, subjectIds, answers, { bootstrap, startedAt, finishedAt } = {}) {
    const n = this.workflow?.answers.length ?? 0;
    if (!Array.isArray(answers) || answers.length !== subjectIds.length) return { ok: false, reason: 'answer every image' };
    if (!answers.every((a) => Number.isInteger(a) && a >= 0 && a < n)) return { ok: false, reason: 'invalid answer' };
    const subs = subjectIds.map((id) => this.s.subjects[id]);
    if (subs.some((s) => !s)) return { ok: false, reason: 'image no longer available' };

    // Known-answer check.
    let goldSeen = 0;
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      if (s.status !== 'consensus') continue;
      goldSeen++;
      this.s.stats.goldChecks++;
      if (answers[i] !== s.consensus) {
        this.s.stats.goldFailures++;
        return { ok: false, reason: "that answer didn't match what other volunteers saw. Try again" };
      }
    }
    const verified = goldSeen > 0;
    const counts = verified || (bootstrap && this.cfg.bootstrap);

    let counted = 0;
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      if (s.by.includes(deviceId)) continue;
      s.by.push(deviceId);
      if (s.by.length > 50) s.by.shift();
      this.s.stats.classifications++;
      const isGold = s.status === 'consensus';
      if (!isGold) {
        if (counts) {
          s.votes[answers[i]]++;
          s.counted++;
          counted++;
          this.s.stats.counted++;
          this.updateConsensus(s);
        } else s.unverified++;
      }
      this.onClassification?.({
        schema: 'foldpass.classification.v1',
        provider: 'zooniverse',
        project_id: this.workflow.project,
        workflow_id: this.workflow.workflow,
        workflow_version: this.workflow.version,
        task: this.workflow.task,
        subject_id: s.id,
        answer: answers[i],
        answer_label: this.workflow.answers[answers[i]],
        device: deviceId,
        counted: !isGold && counts,
        role: isGold ? 'known-answer' : 'contribution',
        verified,
        started_at: new Date(startedAt ?? this.now()).toISOString(),
        finished_at: new Date(finishedAt ?? this.now()).toISOString(),
      });
    }
    return { ok: true, verified, counted };
  }

  updateConsensus(s) {
    const top = Math.max(...s.votes);
    s.agreement = s.counted ? top / s.counted : null;
    if (s.counted >= this.cfg.retireAfter && s.agreement >= this.cfg.consensus) {
      s.status = 'consensus';
      s.consensus = s.votes.indexOf(top);
      s.decidedAt = this.now();
    } else if (s.counted >= this.cfg.maxVotes) {
      s.status = 'ambiguous';
      s.decidedAt = this.now();
    }
  }

  summary() {
    const subs = Object.values(this.s.subjects);
    const by = (st) => subs.filter((s) => s.status === st).length;
    return {
      enabled: true,
      workflow: this.workflow,
      forwarding: !!(this.cfg.forward?.enabled && this.cfg.forward?.token),
      stats: { ...this.s.stats, subjects: subs.length, open: by('open'), consensus: by('consensus'), ambiguous: by('ambiguous') },
      recent: subs
        .filter((s) => s.counted > 0)
        .sort((a, b) => (b.decidedAt || b.added) - (a.decidedAt || a.added))
        .slice(0, 12)
        .map(({ id, image, votes, counted, status, consensus, agreement }) => ({ id, image, votes, counted, status, consensus, agreement })),
    };
  }

  consensusCsv() {
    const w = this.workflow;
    if (!w) return '';
    const head = ['subject_id', 'project_id', 'workflow_id', 'task', 'status', 'consensus_answer', 'consensus_label', 'agreement', 'counted_votes', ...w.answers.map((a, i) => `votes_${i}_${a.replace(/[^\w]+/g, '_')}`), 'image'];
    const rows = Object.values(this.s.subjects)
      .filter((s) => s.counted > 0)
      .map((s) => [s.id, w.project, w.workflow, w.task, s.status, s.consensus ?? '', s.consensus != null ? w.answers[s.consensus] : '', s.agreement?.toFixed(3) ?? '', s.counted, ...s.votes, s.image]);
    return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  }
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/**
 * Send one counted answer to Zooniverse as a Panoptes classification.
 * Only call this with explicit permission from Zooniverse and the project team.
 * `token` is an OAuth bearer token for an account/app they have approved.
 */
export async function forwardClassification(rec, { api, token, fetch: fetchImpl = globalThis.fetch }) {
  const body = {
    classifications: {
      completed: false, // we only answer the first task of the workflow
      annotations: [{ task: rec.task, value: rec.answer }],
      metadata: {
        workflow_version: rec.workflow_version,
        started_at: rec.started_at,
        finished_at: rec.finished_at,
        user_language: 'en',
        source: 'FoldPass',
        subject_dimensions: [],
      },
      links: { project: rec.project_id, workflow: rec.workflow_id, subjects: [rec.subject_id] },
    },
  };
  const r = await fetchImpl(`${api}/classifications`, {
    method: 'POST',
    headers: { accept: ACCEPT, 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Zooniverse rejected classification: HTTP ${r.status}`);
  return body;
}
