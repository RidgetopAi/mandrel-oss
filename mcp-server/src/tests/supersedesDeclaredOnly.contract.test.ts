/**
 * `supersedes` IS DECLARED BY CONSTRUCTION — the DB contract (migration 087).
 *
 * THE RULE: **an inferred edge must never be able to make a record invisible.**
 *
 * `supersedes` is an EXCLUSION predicate — projectBriefing.ts uses it in `NOT EXISTS` for the
 * handoff, the conventions section and the dead-ends section — so a false positive there does
 * not degrade an answer, it DELETES it. `possibly_supersedes` merely ANNOTATES (trust demotes
 * the record; it still renders). Belief adjudication is a confidence-scored LLM heuristic, so
 * it may only ever write the annotating channel.
 *
 * WHY THIS TEST IS AT THE DB LAYER AND NOT IN TYPESCRIPT. beliefDerivation.ts can no longer
 * construct a hard mint — the union member is gone, and beliefDerivation.unit.test.ts locks
 * that. But a type only governs code the compiler sees. `links_supersedes_declared_only` is
 * the layer that holds against raw SQL, a psql session, a migration, and a service nobody has
 * written yet — the same reasoning migration 085 used to make mint_via a NOT NULL column
 * instead of a metadata key.
 *
 * WHAT THE CONSTRAINT READS. `provenance_class` is the STORED GENERATED column from migration
 * 085 (declared / guessed / unclassified, derived from mint_via). The constraint references it
 * DIRECTLY rather than re-listing the guessed mint_via values, so there is exactly one home
 * for the classification and no second list to drift. That this is even possible was measured,
 * not assumed: PostgreSQL 16.14 accepts AND enforces a CHECK over a STORED generated column,
 * on INSERT and on UPDATE.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { BELIEF_EDGE_CREATED_BY } from '../config/beliefConfig.js';

const STAMP = Date.now();
const CONSTRAINT = 'links_supersedes_declared_only';
/** Postgres SQLSTATE for check_violation — the structured answer, not the message prose. */
const CHECK_VIOLATION = '23514';

let projectId: string;
let fromId: string;
let toId: string;

/** Insert a links row naming an explicit mint_via. Returns the pg error on rejection. */
async function tryInsert(edgeType: string, mintVia: string, createdBy: string) {
  try {
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
       VALUES ($1, 'context', $2, 'context', $3, $4, $5, $6)`,
      [fromId, toId, edgeType, projectId, createdBy, mintVia]
    );
    return null;
  } catch (e: any) {
    return e;
  }
}

async function clearEdges() {
  await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
}

describe('links_supersedes_declared_only — the DB contract', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'supersedes declared-only contract') RETURNING id`,
        [`supersedes-declared-P-${STAMP}`]
      )
    ).rows[0].id;
    const mk = async (content: string) =>
      (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'discussion', $2) RETURNING id`,
          [projectId, content]
        )
      ).rows[0].id;
    fromId = await mk(`declared-only from ${STAMP}`);
    toId = await mk(`declared-only to ${STAMP}`);
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  // ── THE CONSTRAINT IS ACTUALLY INSTALLED ────────────────────────────────────────────
  // Asserted first and separately: every rejection below would also "pass" against a table
  // with no constraint if the insert failed for some other reason, so the suite needs to know
  // the guard is present before it can read a rejection as the guard working.
  test('the constraint exists on `links` and its predicate references provenance_class', async () => {
    const row = (
      await db.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conname = $1 AND conrelid = 'links'::regclass`,
        [CONSTRAINT]
      )
    ).rows[0];
    expect(row, `${CONSTRAINT} must be installed by migration 087`).toBeTruthy();
    expect(row.def).toContain('provenance_class');
    expect(row.def).toContain('declared');
    // NOT VALID would mean the constraint does not govern the rows already in the table.
    expect(row.def).not.toContain('NOT VALID');
  });

  // ── REJECTED: the guessed hard edge, which is the whole defect ──────────────────────
  test('REJECTS a `supersedes` edge minted by belief-adjudication (guessed)', async () => {
    await clearEdges();
    const err = await tryInsert('supersedes', EDGE_MINT_VIA.beliefAdjudication, BELIEF_EDGE_CREATED_BY);
    expect(err, 'a guessed `supersedes` row must not be insertable').toBeTruthy();
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint).toBe(CONSTRAINT);
    // and nothing landed
    const n = (
      await db.query(`SELECT count(*)::int AS n FROM links WHERE project_id = $1`, [projectId])
    ).rows[0].n;
    expect(n).toBe(0);
  });

  test('REJECTS a `supersedes` edge minted by cosine inference (the other guessed via)', async () => {
    await clearEdges();
    const err = await tryInsert('supersedes', EDGE_MINT_VIA.inference, 'auto:inference');
    expect(err).toBeTruthy();
    expect(err.code).toBe(CHECK_VIOLATION);
  });

  // ── THE FAIL-CLOSED POPULATION: a via nobody classified ─────────────────────────────
  // C3's "probe the absent population". An unknown mint_via classifies 'unclassified' (085's
  // ELSE arm), which is neither declared nor guessed. The constraint is an ALLOW-list on
  // 'declared', not a deny-list on 'guessed', precisely so a via added in TypeScript without
  // being classified cannot mint an exclusion edge on the strength of being unrecognised.
  test('REJECTS a `supersedes` edge whose mint_via is UNCLASSIFIED (fail-closed)', async () => {
    await clearEdges();
    const err = await tryInsert('supersedes', `never-classified-${STAMP}`, 'someone:new');
    expect(err).toBeTruthy();
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint).toBe(CONSTRAINT);
  });

  test('REJECTS a `supersedes` edge whose mint_via is the closed legacy class', async () => {
    await clearEdges();
    const err = await tryInsert('supersedes', 'legacy-unlabeled', 'unknown');
    expect(err).toBeTruthy();
    expect(err.code).toBe(CHECK_VIOLATION);
  });

  // ── THE CONTROLS: what must STILL work, or the constraint is just breakage ───────────
  // Without these, a constraint of `edge_type <> 'supersedes'` would pass every test above.
  test.each([
    ['links-param', EDGE_MINT_VIA.linksParam],
    ['handoff-timeline', EDGE_MINT_VIA.handoffTimeline],
    ['decision-superseded-by', EDGE_MINT_VIA.decisionSupersededBy],
    ['link-tool', EDGE_MINT_VIA.linkTool],
  ])('ACCEPTS a DECLARED `supersedes` edge minted via %s', async (_label, via) => {
    await clearEdges();
    const err = await tryInsert('supersedes', via, 'link');
    expect(err, `a declared supersedes via ${via} must remain insertable`).toBeNull();
    const row = (
      await db.query(
        `SELECT edge_type, provenance_class FROM links WHERE project_id = $1`,
        [projectId]
      )
    ).rows[0];
    expect(row.edge_type).toBe('supersedes');
    expect(row.provenance_class).toBe('declared');
  });

  test('ACCEPTS a GUESSED `possibly_supersedes` edge — the channel inference belongs in', async () => {
    await clearEdges();
    const err = await tryInsert(
      'possibly_supersedes',
      EDGE_MINT_VIA.beliefAdjudication,
      BELIEF_EDGE_CREATED_BY
    );
    expect(err, 'the annotating channel must stay open to inference').toBeNull();
    const row = (
      await db.query(`SELECT edge_type, provenance_class FROM links WHERE project_id = $1`, [
        projectId,
      ])
    ).rows[0];
    expect(row.edge_type).toBe('possibly_supersedes');
    expect(row.provenance_class).toBe('guessed');
  });

  // ── THE UPDATE PATH, which an INSERT-only guard would miss ──────────────────────────
  test('REJECTS promoting an existing guessed `possibly_supersedes` to `supersedes` by UPDATE', async () => {
    await clearEdges();
    expect(
      await tryInsert('possibly_supersedes', EDGE_MINT_VIA.beliefAdjudication, BELIEF_EDGE_CREATED_BY)
    ).toBeNull();
    let err: any = null;
    try {
      await db.query(
        `UPDATE links SET edge_type = 'supersedes' WHERE project_id = $1`,
        [projectId]
      );
    } catch (e) {
      err = e;
    }
    expect(err, 'an UPDATE must not be able to smuggle a guess into the hard channel').toBeTruthy();
    expect(err.code).toBe(CHECK_VIOLATION);
    // The row is unchanged.
    const row = (
      await db.query(`SELECT edge_type FROM links WHERE project_id = $1`, [projectId])
    ).rows[0];
    expect(row.edge_type).toBe('possibly_supersedes');
  });

  test('REJECTS re-labelling a DECLARED `supersedes` to a guessed mint_via by UPDATE', async () => {
    await clearEdges();
    expect(await tryInsert('supersedes', EDGE_MINT_VIA.linksParam, 'link')).toBeNull();
    let err: any = null;
    try {
      await db.query(`UPDATE links SET mint_via = $2 WHERE project_id = $1`, [
        projectId,
        EDGE_MINT_VIA.beliefAdjudication,
      ]);
    } catch (e) {
      err = e;
    }
    expect(err, 'provenance_class is generated, so this UPDATE must re-check').toBeTruthy();
    expect(err.code).toBe(CHECK_VIOLATION);
  });

  // ── THE WHOLE-TABLE INVARIANT ───────────────────────────────────────────────────────
  test('NO `supersedes` row anywhere in the table is non-declared', async () => {
    const n = (
      await db.query(
        `SELECT count(*)::int AS n FROM links
          WHERE edge_type = 'supersedes' AND provenance_class IS DISTINCT FROM 'declared'`
      )
    ).rows[0].n;
    expect(n).toBe(0);
  });
});
