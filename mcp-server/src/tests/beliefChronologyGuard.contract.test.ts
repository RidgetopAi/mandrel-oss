/**
 * AN INFERRED SUPERSESSION MAY NOT POINT BACKWARDS THROUGH TIME.
 *
 * ── THE DEFECT THIS REPRODUCES ───────────────────────────────────────────────────────
 * Found live on prod (project eval3-m-r1): handoff `fe3a81fc` (created 12:16:41Z) carried
 * an inbound `possibly_supersedes` from `49858772` (created 12:10:13Z) via
 * `belief-adjudication`. The OLDER record was minted as superseding the NEWER one, so the
 * briefing rendered the CURRENT handoff as `superseded_by:<the stale record>`.
 *
 * The direction was an LLM judgment honoured verbatim: beliefDerivation mapped
 * `a_supersedes_b`/`b_supersedes_a` straight onto from/to, and nothing in the belief service
 * compared the two records' timestamps. "Normally the newer one supersedes" existed only as
 * PROMPT PROSE (ollamaAdjudicator), which is exactly the place a model can ignore it.
 *
 * ── WHY THIS TEST DRIVES THE DB PIPELINE AND NOT JUST THE PURE FUNCTION ──────────────
 * The pure derivation is unit-tested separately (beliefDerivation.unit.test.ts). What is
 * asserted HERE is the property a reader of the graph actually experiences: the `links` ROW
 * that the shipped path (findCandidates → provider.adjudicate → deriveBeliefOutcome →
 * reconcileBeliefEdge → mintEdge) writes. A backwards edge is a DB row, so the guard reads
 * the DB row and compares the two endpoints' real timestamps — the same arithmetic the prod
 * audit query used to count 55 of them.
 *
 * THE FAKE PROVIDER IS NOT "a provider that returns a fixed string": it reads `createdAt`
 * off the adjudication request and deliberately names the OLDER record as the superseder.
 * That makes the adversary honest about its intent regardless of which member of the pair
 * the pipeline happened to pass as `a`, and it doubles as a probe that both timestamps do
 * reach the provider at all.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

// Same geometry trick as beliefCannotHideTheHandoff.contract.test.ts: the pair must land
// INSIDE the nomination window [pairMinCosine 0.60, pairMaxCosine 0.95], so the note's vector
// is the handoff's with ~7.5% of dimensions negated (cosine ≈ 1 - 2f ≈ 0.85). The achieved
// cosine is ASSERTED below rather than trusted.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => {
      const base = patternEmbedding();
      const embedding = text.includes('NEWER-MARK-')
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
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { TRUNK_CONTEXT_TYPE } from '../services/handoffSupersession.js';
import type {
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
} from '../services/belief/types.js';

const STAMP = Date.now();
const CONN = `belief-chrono-conn-${STAMP}`;
const PROJ_NAME = `belief-chrono-P-${STAMP}`;

const OLDER_MARK = `OLDER-MARK-${STAMP}`;
const NEWER_MARK = `NEWER-MARK-${STAMP}`;

let projectId: string;
/** The OLDER record (a handoff, backdated one hour) — the one the adversary wants to win. */
let olderId: string;
/** The NEWER record — the current truth the backwards edge would discredit. */
let newerId: string;
let olderCreatedAt: Date;
let newerCreatedAt: Date;

/** ms of backdating applied to the older record so the two timestamps cannot be confused. */
const BACKDATE_MS = 60 * 60 * 1000;

function ts(r: AdjudicationRequest['a']): number {
  return new Date(r.createdAt as Date | string).getTime();
}

/**
 * THE ADVERSARY: always names the OLDER member of the pair as the superseder — the exact
 * judgment the real model returned on prod. Direction is computed from the request's own
 * timestamps, so it is backwards no matter which endpoint arrives as `a`.
 */
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
      subject: 'the project handoff',
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
      subject: 'the project handoff',
      verdict: 'supersedes',
      direction: ts(req.a) > ts(req.b) ? 'a_supersedes_b' : 'b_supersedes_a',
      mode: 'replaced',
      confidence: 1,
      rationale: 'the newer record supersedes the older one',
    };
  }
}

async function store(content: string, type: string): Promise<string> {
  const resp: any = await routeExecutor(
    'context_store',
    { content, type, projectId },
    { connectionId: CONN }
  );
  return resp.structuredContent.context.id;
}

/** Every belief-minted supersession edge in this project, with BOTH endpoints' real timestamps. */
async function beliefEdges(): Promise<
  Array<{ from: string; to: string; edge: string; fromTs: string; toTs: string }>
> {
  const r = await db.query(
    `SELECT l.from_id::text AS from, l.to_id::text AS to, l.edge_type AS edge,
            f.created_at AS "fromTs", t.created_at AS "toTs"
       FROM links l
       JOIN contexts f ON f.id = l.from_id
       JOIN contexts t ON t.id = l.to_id
      WHERE l.project_id = $1
        AND l.mint_via = 'belief-adjudication'
        AND l.edge_type IN ('supersedes', 'possibly_supersedes')`,
    [projectId]
  );
  return r.rows;
}

/** Re-adjudicate the pair with `provider`, driving the SHIPPED neighbourhood path. */
async function adjudicate(provider: AdjudicationProvider) {
  return adjudicateNeighbourhood(
    {
      id: newerId,
      type: 'context',
      projectId,
      content: `${NEWER_MARK} the current handoff state`,
      createdAt: newerCreatedAt,
    },
    { provider },
    db
  );
}

describe('belief adjudication cannot mint a BACKWARDS-IN-TIME supersession', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'belief chronology guard') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    olderId = await store(
      `${OLDER_MARK}\nMODE: build\nPATH: roots -> trunk -> branch:belief\nRESULT: 20/20 scenarios passed. The stale run.`,
      TRUNK_CONTEXT_TYPE
    );
    newerId = await store(
      `${NEWER_MARK}\nMODE: build\nPATH: roots -> trunk -> branch:belief\nRESULT: 18/20 scenarios passed. The corrected, current run.`,
      TRUNK_CONTEXT_TYPE
    );

    // Backdate the older record so the ordering is UNAMBIGUOUS (an hour, not the few ms two
    // consecutive inserts differ by) — then read both timestamps back from the DB, because
    // the DB is what the guard's arithmetic will read.
    await db.query(
      `UPDATE contexts SET created_at = created_at - ($2 || ' milliseconds')::interval WHERE id = $1`,
      [olderId, BACKDATE_MS]
    );
    const rows = (
      await db.query(`SELECT id::text AS id, created_at FROM contexts WHERE id = ANY($1::uuid[])`, [
        [olderId, newerId],
      ])
    ).rows;
    olderCreatedAt = rows.find((r: any) => r.id === olderId).created_at;
    newerCreatedAt = rows.find((r: any) => r.id === newerId).created_at;
    expect(
      newerCreatedAt.getTime() - olderCreatedAt.getTime(),
      'fixture: the two records must be an hour apart, older first'
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
    } catch { /* ignore */ }
    await db.end();
  });

  test('THE FIXTURE LANDS WHERE THE BUG LIVED (non-vacuity: the pair is nominatable)', async () => {
    const cos = Number(
      (
        await db.query(
          `SELECT 1 - (a.${activeEmbeddingColumn()} <=> b.${activeEmbeddingColumn()}) AS cos
             FROM contexts a, contexts b WHERE a.id = $1 AND b.id = $2`,
          [newerId, olderId]
        )
      ).rows[0].cos
    );
    expect(cos, 'inside the nomination window (pairMinCosine 0.60)').toBeGreaterThan(0.6);
    expect(cos, 'inside the nomination window (pairMaxCosine 0.95)').toBeLessThanOrEqual(0.95);
  });

  test('GUARD: an older→newer verdict mints NO edge and is recorded as direction_backwards_in_time', async () => {
    const provider = new OlderSupersedesNewer();
    const results = await adjudicate(provider);

    // CAUSE BEFORE SYMPTOM: a failed Stage-1 pairing query reaches zero pairs,
    // so the count assertion below is the first thing to break and says only "expected 0 to be
    // greater than 0". Read the pairing stage's own verdict FIRST so a RED names its cause.
    await expectPairingStageClean(db, newerId, 'the newer context');

    // NON-VACUITY: the pipeline really ran and really consulted the adversary on this pair.
    expect(provider.calls, 'the adjudicator must have been consulted').toBeGreaterThan(0);
    expect(
      provider.sawBothTimestamps,
      'both endpoints must carry a createdAt into the provider — the guard has nothing to read otherwise'
    ).toBe(true);
    const pair = results.find((r) => r.b.id === olderId);
    expect(pair, 'the older record must have been nominated as a candidate').toBeDefined();

    // THE PROPERTY. Read the graph the way a reader does: the actual links rows.
    // The assertion below is the reproduction evidence: pre-fix it prints the offending
    // links row — both endpoints' real timestamps — straight into the failure diff. (A
    // console.log here would print nothing: vitest.setup.ts silences console for the suite.)
    const edges = await beliefEdges();
    const backwards = edges.filter(
      (e) => new Date(e.fromTs).getTime() < new Date(e.toTs).getTime()
    );
    expect(
      backwards,
      'a belief-minted supersession whose SOURCE is older than its TARGET points backwards through time'
    ).toEqual([]);

    // …and the refusal is RECORDED rather than silent, so the disagreement leaves a signal.
    expect(pair!.outcome).toEqual({ action: 'none', reason: 'direction_backwards_in_time' });
    expect(pair!.mintedEdgeId).toBeNull();
  });

  test('CONTROL: a legitimate newer→older verdict STILL mints, in the correct direction', async () => {
    const provider = new NewerSupersedesOlder();
    const results = await adjudicate(provider);
    await expectPairingStageClean(db, newerId, 'the newer context');
    expect(provider.calls).toBeGreaterThan(0);

    const pair = results.find((r) => r.b.id === olderId);
    expect(pair, 'the older record must have been nominated as a candidate').toBeDefined();
    expect(pair!.outcome.action, 'the fix must not block legitimate supersession').toBe(
      'soft_possibly_superseded'
    );
    expect(pair!.mintedEdgeId).not.toBeNull();

    const edges = await beliefEdges();
    expect(edges.length, 'exactly one belief edge on the pair').toBe(1);
    expect(edges[0].edge).toBe('possibly_supersedes');
    expect(edges[0].from, 'the NEWER record supersedes').toBe(newerId);
    expect(edges[0].to, 'the OLDER record is superseded').toBe(olderId);
  });

  test('TIE: identical timestamps establish no order, so no edge is minted (and the prior edge is retracted)', async () => {
    // Force the tie. This is not a hypothetical: two records written inside ONE transaction
    // both take the transaction's now(), so equal created_at is reachable in production.
    await db.query(`UPDATE contexts SET created_at = $2 WHERE id = $1`, [olderId, newerCreatedAt]);
    const tied = (
      await db.query(`SELECT created_at FROM contexts WHERE id = $1`, [olderId])
    ).rows[0].created_at;
    expect(tied.getTime(), 'fixture: the two records are now exactly tied').toBe(
      newerCreatedAt.getTime()
    );

    const provider = new NewerSupersedesOlder();
    const results = await adjudicate(provider);
    await expectPairingStageClean(db, newerId, 'the newer context');
    const pair = results.find((r) => r.b.id === olderId);
    expect(pair, 'the older record must have been nominated as a candidate').toBeDefined();
    expect(pair!.outcome).toEqual({ action: 'none', reason: 'chronology_tie' });
    expect(pair!.mintedEdgeId).toBeNull();

    // REVERSIBILITY: the edge minted by the CONTROL test above is withdrawn, because a `none`
    // outcome retracts the pair's belief edges. So the guard also cleans up behind itself when
    // a pair is re-adjudicated — which is the mechanism that will drain existing bad edges.
    expect(await beliefEdges()).toEqual([]);

    // restore the fixture for any later test
    await db.query(`UPDATE contexts SET created_at = $2 WHERE id = $1`, [olderId, olderCreatedAt]);
  });
});
