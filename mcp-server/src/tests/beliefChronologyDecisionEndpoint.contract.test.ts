/**
 * THE CHRONOLOGY GATE MUST READ A DECISION'S CLOCK FROM `decision_date`.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────────────
 * `beliefChronologyGuard.contract.test.ts` proves the backwards-in-time refusal for a
 * context↔context pair. Every record type the belief layer can pair is covered by that
 * file EXCEPT the one whose clock lives in a DIFFERENT COLUMN: a decision is ordered by
 * `technical_decisions.decision_date`, not by a `created_at` (that column does not exist on
 * that table at all). The mapping lives in ONE place — `candidatePairing.EMBEDDED_TABLES`
 * — and it is read by BOTH clock paths: the candidate side (findCandidates' per-table
 * SELECT) and the source side (`readRecordCreatedAt`).
 *
 * WHY THAT MATTERS RATHER THAN BEING A DETAIL. Both clock reads are wrapped in
 * `try { … } catch { degrade }`. If the decision column ever drifts, the query throws, the
 * catch swallows it, and the clock arrives as `null` — which the derivation correctly maps
 * to `chronology_unknown` and refuses. The failure is therefore SILENT AND FAIL-CLOSED:
 * supersession simply stops existing for every decision pair, no error, no red test. That
 * is the third instrument state (C1) sitting behind a swallowed exception, and nothing in
 * the suite could tell it from "the model never proposed a decision supersession".
 *
 * MEASURED, which is why this file exists rather than being hypothetical: on prod
 * 2026-08-27, of 58 backwards `auto:belief-adjudicator` edges, 57 are context→context and
 * exactly ONE has `from_type = 'decision'` — so the decision endpoint is a live pairing
 * path that really did produce a backwards edge, and it had no test.
 *
 * ── WHAT IS ASSERTED, ALL OF IT EXECUTED ─────────────────────────────────────────────
 *  1. CLOCK PROVENANCE (the load-bearing one): the timestamp the shipped pipeline hands the
 *     adjudicator for the decision endpoint is BYTE-EQUAL to `decision_date` read straight
 *     out of the table. This is the assertion that goes RED if the column mapping drifts —
 *     it compares against the DB, never against a value this file chose.
 *  2. GUARD: an older-decision→newer-context verdict mints NOTHING and records
 *     `direction_backwards_in_time`.
 *  3. CONTROL: the legitimate direction (newer context supersedes older decision) STILL
 *     mints, so the guard is refusing the backwards case and not the decision endpoint.
 *  4. SOURCE-SIDE clock: `readRecordCreatedAt` resolves a decision to its `decision_date`.
 *     That is the path taken when a trigger passes no clock, and it is the one whose
 *     failure switches supersession off silently.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

// Same geometry as beliefChronologyGuard.contract.test.ts: the pair must land INSIDE the
// nomination window [pairMinCosine 0.60, pairMaxCosine 0.95]. The CONTEXT's vector is the
// decision's with ~7.5% of dimensions negated (cosine ≈ 1 - 2f ≈ 0.85). The achieved cosine
// is ASSERTED below rather than trusted.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => {
      const base = patternEmbedding();
      const embedding = text.includes('NEWER-CTX-MARK-')
        ? base.map((v, i) => (i < Math.round(base.length * 0.075) ? -v : v))
        : base;
      return { embedding, dimensions: embedDim(), model: 'stub' };
    }),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { adjudicateNeighbourhood } from '../services/belief/beliefAdjudicator.js';
import { expectPairingStageClean } from './helpers/beliefPairingWitness.js';
import { readRecordCreatedAt } from '../services/belief/candidatePairing.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import type {
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
} from '../services/belief/types.js';

const STAMP = Date.now();
const CONN = `belief-chrono-dec-conn-${STAMP}`;
const PROJ_NAME = `belief-chrono-dec-P-${STAMP}`;

const OLDER_DEC_MARK = `OLDER-DEC-MARK-${STAMP}`;
const NEWER_CTX_MARK = `NEWER-CTX-MARK-${STAMP}`;

let projectId: string;
/** The OLDER record: a DECISION, backdated an hour via `decision_date`. */
let decisionId: string;
/** The NEWER record: a context — the current truth a backwards edge would discredit. */
let contextId: string;
let decisionClock: Date;
let contextCreatedAt: Date;

/** ms of backdating applied to the decision so the two clocks cannot be confused. */
const BACKDATE_MS = 60 * 60 * 1000;

function ts(r: AdjudicationRequest['a']): number {
  return new Date(r.createdAt as Date | string).getTime();
}

/**
 * A PROBE that never mints: it records, per endpoint id, the exact `createdAt` the shipped
 * pipeline handed it, and always returns `unrelated` so the graph is left untouched. This is
 * how assertion (1) reads the clock the PRODUCT resolved rather than one the test supplied.
 */
class ClockProbe implements AdjudicationProvider {
  readonly name = 'fake';
  readonly model = 'clock-probe';
  calls = 0;
  readonly seen = new Map<string, unknown>();
  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    this.seen.set(req.a.id, req.a.createdAt);
    this.seen.set(req.b.id, req.b.createdAt);
    return {
      sameSubject: false,
      subject: 'the storage engine choice',
      verdict: 'unrelated',
      direction: 'none',
      mode: 'none',
      confidence: 0,
      rationale: 'probe — records the clocks and mints nothing',
    };
  }
}

/** THE ADVERSARY: always names the OLDER member of the pair as the superseder. */
class OlderSupersedesNewer implements AdjudicationProvider {
  readonly name = 'fake';
  readonly model = 'older-supersedes-newer';
  calls = 0;
  /** Both endpoints carried a usable timestamp on every call (probe, asserted below). */
  sawBothTimestamps = true;
  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    if (!Number.isFinite(ts(req.a)) || !Number.isFinite(ts(req.b))) this.sawBothTimestamps = false;
    return {
      sameSubject: true,
      subject: 'the storage engine choice',
      verdict: 'supersedes',
      direction: ts(req.a) < ts(req.b) ? 'a_supersedes_b' : 'b_supersedes_a',
      mode: 'replaced',
      confidence: 1,
      rationale: 'the older record is (wrongly) judged to supersede the newer one',
    };
  }
}

/** THE CONTROL: names the NEWER member as the superseder — a legitimate supersession. */
class NewerSupersedesOlder implements AdjudicationProvider {
  readonly name = 'fake';
  readonly model = 'newer-supersedes-older';
  calls = 0;
  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    return {
      sameSubject: true,
      subject: 'the storage engine choice',
      verdict: 'supersedes',
      direction: ts(req.a) > ts(req.b) ? 'a_supersedes_b' : 'b_supersedes_a',
      mode: 'replaced',
      confidence: 1,
      rationale: 'the newer record supersedes the older one',
    };
  }
}

/**
 * Every belief-minted supersession edge in this project, with BOTH endpoints' real clocks
 * resolved from the SAME columns the prod audit query uses (contexts.created_at /
 * technical_decisions.decision_date).
 */
async function beliefEdges(): Promise<
  Array<{ from: string; to: string; edge: string; fromTs: string; toTs: string }>
> {
  const r = await db.query(
    `WITH clocks AS (
        SELECT id, created_at AS ca FROM contexts
        UNION ALL
        SELECT id, decision_date FROM technical_decisions)
      SELECT l.from_id::text AS from, l.to_id::text AS to, l.edge_type AS edge,
             f.ca AS "fromTs", t.ca AS "toTs"
        FROM links l
        JOIN clocks f ON f.id = l.from_id
        JOIN clocks t ON t.id = l.to_id
       WHERE l.project_id = $1
         AND l.mint_via = 'belief-adjudication'
         AND l.edge_type IN ('supersedes', 'possibly_supersedes')`,
    [projectId]
  );
  return r.rows;
}

/**
 * Re-adjudicate the pair with `provider`, driving the SHIPPED neighbourhood path from the
 * CONTEXT side (the decision is the candidate, so its clock comes from findCandidates).
 */
async function adjudicateFromContext(provider: AdjudicationProvider) {
  return adjudicateNeighbourhood(
    {
      id: contextId,
      type: 'context',
      projectId,
      content: `${NEWER_CTX_MARK} the current position on the storage engine`,
      createdAt: contextCreatedAt,
    },
    { provider },
    db
  );
}

describe('belief chronology gate — the DECISION endpoint is clocked by decision_date', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'belief chronology — decision endpoint') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    await routeExecutor(
      'decision_record',
      {
        decisionType: 'database',
        title: `${OLDER_DEC_MARK} storage engine`,
        description: 'The earlier position on the storage engine',
        rationale: `${OLDER_DEC_MARK} we will keep everything in Postgres and revisit later`,
        impactLevel: 'medium',
        projectId,
      },
      { connectionId: CONN }
    );
    decisionId = (
      await db.query(`SELECT id::text AS id FROM technical_decisions WHERE project_id = $1`, [
        projectId,
      ])
    ).rows[0].id;

    const ctxResp: any = await routeExecutor(
      'context_store',
      {
        content: `${NEWER_CTX_MARK} the current position on the storage engine`,
        type: 'decision',
        projectId,
      },
      { connectionId: CONN }
    );
    contextId = ctxResp.structuredContent.context.id;

    // Backdate the DECISION's clock so the ordering is UNAMBIGUOUS, then read BOTH clocks
    // back from the DB — the DB is what the guard's arithmetic reads.
    await db.query(
      `UPDATE technical_decisions SET decision_date = decision_date - ($2 || ' milliseconds')::interval WHERE id = $1`,
      [decisionId, BACKDATE_MS]
    );
    decisionClock = (
      await db.query(`SELECT decision_date FROM technical_decisions WHERE id = $1`, [decisionId])
    ).rows[0].decision_date;
    contextCreatedAt = (
      await db.query(`SELECT created_at FROM contexts WHERE id = $1`, [contextId])
    ).rows[0].created_at;

    expect(
      contextCreatedAt.getTime() - decisionClock.getTime(),
      'fixture: the decision must be an hour older than the context'
    ).toBeGreaterThan(BACKDATE_MS / 2);
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM belief_adjudications WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  test('THE FIXTURE LANDS WHERE THE BUG LIVES (non-vacuity: the decision is nominatable)', async () => {
    const cos = Number(
      (
        await db.query(
          `SELECT 1 - (c.${activeEmbeddingColumn()} <=> d.${activeEmbeddingColumn()}) AS cos
             FROM contexts c, technical_decisions d WHERE c.id = $1 AND d.id = $2`,
          [contextId, decisionId]
        )
      ).rows[0].cos
    );
    expect(cos, 'inside the nomination window (pairMinCosine 0.60)').toBeGreaterThan(0.6);
    expect(cos, 'inside the nomination window (pairMaxCosine 0.95)').toBeLessThanOrEqual(0.95);
  });

  test('CLOCK PROVENANCE: the decision endpoint reaches the adjudicator carrying its decision_date', async () => {
    const probe = new ClockProbe();
    const results = await adjudicateFromContext(probe);

    // CAUSE BEFORE SYMPTOM: a failed Stage-1 pairing query reaches zero pairs,
    // so the count assertion below is the first thing to break and says only "expected 0 to be
    // greater than 0". Read the pairing stage's own verdict FIRST so a RED names its cause.
    await expectPairingStageClean(db, contextId, 'the newer context');

    // NON-VACUITY: the pipeline really ran and really nominated the decision.
    expect(probe.calls, 'the adjudicator must have been consulted').toBeGreaterThan(0);
    const pair = results.find((r) => r.b.id === decisionId);
    expect(pair, 'the decision must have been nominated as a candidate').toBeDefined();
    expect(pair!.b.type).toBe('decision');

    const seen = probe.seen.get(decisionId);
    expect(seen, 'the decision endpoint must carry a clock at all').toBeTruthy();
    // Compared against the DB column, not against any value this test chose: this is what
    // goes RED if EMBEDDED_TABLES' decision clock column ever drifts.
    expect(new Date(seen as string | Date).getTime()).toBe(decisionClock.getTime());

    // The probe mints nothing, so the graph is still empty at this point.
    expect(await beliefEdges()).toEqual([]);
  });

  test('GUARD: an older-DECISION→newer-context verdict mints NO edge and records direction_backwards_in_time', async () => {
    const provider = new OlderSupersedesNewer();
    const results = await adjudicateFromContext(provider);

    await expectPairingStageClean(db, contextId, 'the newer context');
    expect(provider.calls, 'the adjudicator must have been consulted').toBeGreaterThan(0);
    expect(
      provider.sawBothTimestamps,
      'both endpoints must carry a createdAt into the provider — the guard has nothing to read otherwise'
    ).toBe(true);
    const pair = results.find((r) => r.b.id === decisionId);
    expect(pair, 'the decision must have been nominated as a candidate').toBeDefined();

    // THE PROPERTY, read the way a reader of the graph reads it: the actual links rows.
    const edges = await beliefEdges();
    const backwards = edges.filter(
      (e) => new Date(e.fromTs).getTime() < new Date(e.toTs).getTime()
    );
    expect(
      backwards,
      'a belief-minted supersession whose SOURCE is older than its TARGET points backwards through time'
    ).toEqual([]);

    // …and the refusal is RECORDED rather than silent.
    expect(pair!.outcome).toEqual({ action: 'none', reason: 'direction_backwards_in_time' });
    expect(pair!.mintedEdgeId).toBeNull();
  });

  test('CONTROL: the legitimate direction (newer context supersedes older decision) STILL mints', async () => {
    const provider = new NewerSupersedesOlder();
    const results = await adjudicateFromContext(provider);
    await expectPairingStageClean(db, contextId, 'the newer context');
    expect(provider.calls).toBeGreaterThan(0);

    const pair = results.find((r) => r.b.id === decisionId);
    expect(pair, 'the decision must have been nominated as a candidate').toBeDefined();
    expect(pair!.outcome.action, 'the guard must not block legitimate supersession').toBe(
      'soft_possibly_superseded'
    );
    expect(pair!.mintedEdgeId).not.toBeNull();

    const edges = await beliefEdges();
    expect(edges.length, 'exactly one belief edge on the pair').toBe(1);
    expect(edges[0].edge).toBe('possibly_supersedes');
    expect(edges[0].from, 'the NEWER context supersedes').toBe(contextId);
    expect(edges[0].to, 'the OLDER decision is superseded').toBe(decisionId);
  });

  test('SOURCE-SIDE clock: readRecordCreatedAt resolves a decision to its decision_date', async () => {
    const resolved = await readRecordCreatedAt(
      { id: decisionId, type: 'decision', projectId },
      db
    );
    // `ok` is the MEASURED/COULD-NOT-MEASURE discriminator; a null clock is a
    // measured answer, a failed read is not, and only the first may reach the chronology gate.
    expect(resolved.ok, 'the clock read must have RUN, not blown up').toBe(true);
    if (!resolved.ok) throw new Error('unreachable — narrowing only');
    expect(resolved.createdAt, 'a decision must resolve to a clock, not to null').not.toBeNull();
    expect(new Date(resolved.createdAt as Date).getTime()).toBe(decisionClock.getTime());

    // And the context side still resolves, so a failure above is about the DECISION column
    // specifically rather than about readRecordCreatedAt being broken outright.
    const ctxResolved = await readRecordCreatedAt(
      { id: contextId, type: 'context', projectId },
      db
    );
    expect(ctxResolved.ok).toBe(true);
    if (!ctxResolved.ok) throw new Error('unreachable — narrowing only');
    expect(new Date(ctxResolved.createdAt as Date).getTime()).toBe(contextCreatedAt.getTime());
  });
});
