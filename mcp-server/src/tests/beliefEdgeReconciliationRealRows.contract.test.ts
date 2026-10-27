/**
 * BELIEF EDGE RECONCILIATION on REAL ROWS — the retract/re-mint round trip.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────
 * `ADJRUN_RECONCILE_TEST` in scripts/beliefBackfillDryRun.ts was deleted in 6ddff00: it
 * constructed a `mint_supersedes` outcome (unconstructible since an earlier change) and counted
 * `edge_type='supersedes'` rows the pipeline can no longer create, so it would have
 * reported FAIL forever. Deleting it was right. What it EXERCISED was not covered anywhere
 * else: reconcileBeliefEdge's retraction sweep against REAL `links` rows.
 * beliefEdgeReconciliation.unit.test.ts proves the same logic against an in-memory fake, and
 * beliefCannotHideTheHandoff.contract.test.ts proves the MINT half on a real DB — neither
 * retracts a real row.
 *
 * ── IT NEEDS NO PROVIDER CALL, AND THAT IS THE POINT ─────────────────────────────────
 * The deleted exercise was coupled to a paid adjudication run only because it read its
 * sample out of that run's minted edges. `reconcileBeliefEdge(input, pool)` takes an
 * OUTCOME, not a verdict — no adjudicator, no model, no key. Feeding a constructed soft
 * outcome to the real links service against real rows exercises the whole sweep for free.
 *
 * ── WHAT ONLY A REAL DB CAN PROVE (why the fake is not enough) ───────────────────────
 * The fake `links` table cannot enforce migration 087's
 * `links_supersedes_declared_only` CHECK, which reads the GENERATED provenance_class. The
 * last two tests below assert against the real constraint: a GUESSED `supersedes` row is
 * rejected outright (this is why the exercise had to move to the soft channel), and a
 * DECLARED one — a human's edge on the same endpoints — survives the sweep untouched.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { reconcileBeliefEdge } from '../services/belief/edgeReconciliation.js';
import type { BeliefOutcome } from '../services/belief/beliefDerivation.js';
import { mintEdge } from '../services/links.js';
import { BELIEF_EDGE_CREATED_BY } from '../config/beliefConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `belief-reconcile-realrows-${STAMP}`;

let projectId: string;
let aId: string;
let bId: string;

const endpoints = () => ({
  a: { id: aId, type: 'context' as const },
  b: { id: bId, type: 'context' as const },
});

const SOFT_AB: () => BeliefOutcome = () => ({
  action: 'soft_possibly_superseded',
  fromId: aId,
  toId: bId,
  mode: 'replaced',
  confidence: 0.9,
  direction: 'a_supersedes_b',
  rationale: 'real-rows reconcile exercise',
});

const NONE_OUTCOME: BeliefOutcome = { action: 'none', reason: 'restates' };

/** Count the belief-minted rows of one edge type on the a→b direction, in the real table. */
async function beliefRows(edgeType: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM links
      WHERE from_id = $1::uuid AND to_id = $2::uuid AND edge_type = $3 AND created_by = $4`,
    [aId, bId, edgeType, BELIEF_EDGE_CREATED_BY]
  );
  return r.rows[0].c;
}

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'belief reconcile real-rows fuse') RETURNING id`,
      [PROJ_NAME]
    )
  ).rows[0].id;
  // CHRONOLOGY: every outcome in this file is `a_supersedes_b`, so A must be
  // the LATER record or mintEdge now refuses the edge. created_at is set EXPLICITLY rather
  // than relying on insert order — two inserts a microsecond apart would leave the total
  // order `(created_at, id)` decided by a random uuid, i.e. a coin-flip flake.
  const seed = async (content: string, ageMinutes: number): Promise<string> =>
    (
      await db.query(
        `INSERT INTO contexts (project_id, content, context_type, created_at)
         VALUES ($1, $2, 'completion', now() - ($3 || ' minutes')::interval) RETURNING id`,
        [projectId, content, String(ageMinutes)]
      )
    ).rows[0].id;
  aId = await seed(`reconcile-realrows A ${STAMP}`, 1);
  bId = await seed(`reconcile-realrows B ${STAMP}`, 2);
});

afterAll(async () => {
  await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

describe('reconcileBeliefEdge — real rows, no provider', () => {
  test('mint → retract → re-mint round trip lands and unlands REAL links rows', async () => {
    // 1. MINT. A soft outcome inserts exactly one real possibly_supersedes row.
    const minted = await reconcileBeliefEdge(
      { ...endpoints(), outcome: SOFT_AB(), projectId, edgeMetadata: { confidence: 0.9 } },
      db
    );
    expect(minted.edgeCreated).toBe(true);
    expect(minted.mintedEdgeType).toBe('possibly_supersedes');
    expect(await beliefRows('possibly_supersedes')).toBe(1);

    // 2. IDEMPOTENT. The same outcome again is a no-op — no churn, still one row.
    const again = await reconcileBeliefEdge(
      { ...endpoints(), outcome: SOFT_AB(), projectId, edgeMetadata: { confidence: 0.9 } },
      db
    );
    expect(again.edgeCreated).toBe(false);
    expect(again.retracted).toEqual([]);
    expect(await beliefRows('possibly_supersedes')).toBe(1);

    // 3. RETRACT — the sweep the deleted exercise covered. Re-adjudicated to a verdict
    //    that supports no edge, the real row must be DELETED, not merely unreferenced.
    const retracted = await reconcileBeliefEdge(
      { ...endpoints(), outcome: NONE_OUTCOME, projectId, edgeMetadata: {} },
      db
    );
    expect(retracted.mintedEdgeId).toBeNull();
    expect(retracted.retracted).toEqual([
      { fromId: aId, toId: bId, edgeType: 'possibly_supersedes' },
    ]);
    expect(await beliefRows('possibly_supersedes')).toBe(0);

    // 4. RE-MINT. The original verdict returning re-inserts a brand-new row.
    const remint = await reconcileBeliefEdge(
      { ...endpoints(), outcome: SOFT_AB(), projectId, edgeMetadata: { confidence: 0.9 } },
      db
    );
    expect(remint.edgeCreated).toBe(true);
    expect(await beliefRows('possibly_supersedes')).toBe(1);

    // Leave the table clean for the next test.
    await reconcileBeliefEdge(
      { ...endpoints(), outcome: NONE_OUTCOME, projectId, edgeMetadata: {} },
      db
    );
    expect(await beliefRows('possibly_supersedes')).toBe(0);
  });

  test('a GUESSED `supersedes` row is rejected by the DB — the reason this moved channels', async () => {
    // migration 087: CHECK (edge_type <> 'supersedes' OR provenance_class = 'declared'),
    // and provenance_class is GENERATED 'guessed' for mint_via 'belief-adjudication'.
    //
    // The assertion is on the OBSERVABLE FACT (it threw, and no row landed), not on the
    // message: the datastore layer sanitizes pg errors into an opaque [DATASTORE_ERROR]
    // with a ref, so the constraint name never reaches the caller. Measured here — the
    // first draft matched /links_supersedes_declared_only/ and went RED for that reason.
    const guessedHard = () =>
      mintEdge(
        {
          fromId: aId,
          fromType: 'context',
          toId: bId,
          toType: 'context',
          edgeType: 'supersedes',
          projectId,
          createdBy: BELIEF_EDGE_CREATED_BY,
          via: EDGE_MINT_VIA.beliefAdjudication,
          metadata: {},
        },
        db
      );
    await expect(guessedHard()).rejects.toThrow();
    expect(await beliefRows('supersedes')).toBe(0);

    // THE CONTROL that makes the rejection mean something: the SAME arguments differing
    // only in edge_type mint fine. So the throw is the supersedes constraint, not a
    // malformed call (bad via, self-link, missing row) that would throw either way.
    const softControl = await mintEdge(
      {
        fromId: aId,
        fromType: 'context',
        toId: bId,
        toType: 'context',
        edgeType: 'possibly_supersedes',
        projectId,
        createdBy: BELIEF_EDGE_CREATED_BY,
        via: EDGE_MINT_VIA.beliefAdjudication,
        metadata: {},
      },
      db
    );
    expect(softControl.created).toBe(true);
    expect(await beliefRows('possibly_supersedes')).toBe(1);

    // Clean up the control row so the next test starts from the same state.
    await reconcileBeliefEdge(
      { ...endpoints(), outcome: NONE_OUTCOME, projectId, edgeMetadata: {} },
      db
    );
    expect(await beliefRows('possibly_supersedes')).toBe(0);
  });

  test("the sweep never touches a human's DECLARED supersedes edge on the same pair", async () => {
    const human = await mintEdge(
      {
        fromId: aId,
        fromType: 'context',
        toId: bId,
        toType: 'context',
        edgeType: 'supersedes',
        projectId,
        createdBy: 'human:operator',
        via: EDGE_MINT_VIA.linkTool, // 'link-tool' → provenance_class 'declared'
        metadata: {},
      },
      db
    );
    expect(human.created).toBe(true);

    // A full reconcile in each direction: mint the soft edge, then drop to none. Both run
    // the retraction sweep across BOTH belief edge types — the human row must survive both.
    await reconcileBeliefEdge(
      { ...endpoints(), outcome: SOFT_AB(), projectId, edgeMetadata: { confidence: 0.9 } },
      db
    );
    await reconcileBeliefEdge(
      { ...endpoints(), outcome: NONE_OUTCOME, projectId, edgeMetadata: {} },
      db
    );

    const survivor = await db.query(
      `SELECT created_by, provenance_class FROM links
        WHERE from_id = $1::uuid AND to_id = $2::uuid AND edge_type = 'supersedes'`,
      [aId, bId]
    );
    expect(survivor.rowCount).toBe(1);
    expect(survivor.rows[0].created_by).toBe('human:operator');
    expect(survivor.rows[0].provenance_class).toBe('declared');
  });
});
