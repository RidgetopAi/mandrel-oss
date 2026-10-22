/**
 * EDGE PROVENANCE METER — DB-backed contract test.
 *
 * Proves, against a real migrated Postgres (the disposable ci_* DB):
 *   1. THE CLASSIFICATION TABLE IS EXECUTABLE: every provenance stamp the codebase can mint
 *      classifies in the `link_provenance` view exactly as the migration documents — and an
 *      unknown or NULL stamp lands in 'unclassified' (fail-closed), never in a trusted
 *      bucket. This is the load-bearing table Coordinator reviews, as assertions rather than prose.
 *   2. BUCKET ISOLATION (acceptance 2): a DECLARED edge minted through the PRODUCTION tag
 *      path (autoMintFromTags — the exact call context.routes.ts:224 makes) increments ONLY
 *      the declared bucket; a GUESSED edge minted through the PRODUCTION inference path
 *      (inferAndMintRelatedTo with createdBy 'auto:inference' — context.routes.ts:395)
 *      increments ONLY the guessed bucket.
 *   3. The meter read surface (readProvenanceMeter) reports the same buckets the view holds.
 *
 * WHY STAMPS ARE ENUMERATED IN A TEST: the classification's single source is SQL
 * (migration 079). This suite is the executable contract between that SQL and the
 * TypeScript minting sites — when a new stamp is added in code without classifying it in
 * the view, the fail-closed assertion here is what catches it at the unclassified surface.
 *
 * ISOLATION: everything runs in fresh per-suite projects; edges carry project_id so the
 * project drop cascades them away.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { autoMintFromTags } from '../services/links.js';
import { inferAndMintRelatedTo } from '../services/threadInference.js';
import { readProvenanceMeter } from '../services/provenanceMeter.js';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';
import {
  EDGE_MINT_VIA,
  EDGE_MINT_VIA_VALUES,
  LEGACY_ONLY_MINT_VIA,
} from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function freshProject(label: string): Promise<string> {
  const id = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'provenance meter fixture') RETURNING id`,
      [`prov-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(id);
  return id;
}

async function insertContext(projectId: string, content: string, embedding: string | null): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
       VALUES ($1, 'discussion', $2, $3::vector) RETURNING id::text AS id`,
      [projectId, content, embedding]
    )
  ).rows[0].id;
}

async function insertTask(projectId: string, title: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, $2, 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId, title]
    )
  ).rows[0].id;
}

/** A unit vector on axis 0 — identical vectors have cosine 1.0, clearing any inference floor. */
function unitVec(): string {
  const v = new Array(embedDim()).fill(0);
  v[0] = 1;
  return `[${v.join(',')}]`;
}

/** The view's class for one edge id. */
async function classOf(edgeId: string): Promise<string> {
  return (
    await db.query(`SELECT provenance_class FROM link_provenance WHERE id = $1`, [edgeId])
  ).rows[0].provenance_class;
}

/** The class-rollup buckets for one project, summed across weeks. */
async function buckets(projectId: string): Promise<{ declared: number; guessed: number; unclassified: number }> {
  const r = await db.query(
    `SELECT COALESCE(sum(declared),0)::int AS declared,
            COALESCE(sum(guessed),0)::int AS guessed,
            COALESCE(sum(unclassified),0)::int AS unclassified
       FROM link_provenance_weekly_class WHERE project_id = $1`,
    [projectId]
  );
  return r.rows[0];
}

afterAll(async () => {
  for (const id of projectIds) {
    await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
  }
});

describe('link_provenance — the classification table, executed (keyed on mint_via, SK4)', () => {
  /**
   * EVERY mintable via, with its expected class. The population is not hand-listed: it is
   * EDGE_MINT_VIA_VALUES itself, and the coverage assertion below fails if this table and
   * that vocabulary disagree in either direction. That is the anti-drift property this
   * suite exists for — a via added in TypeScript without a class arm in migration 085
   * fail-closes to 'unclassified' AND goes RED here, instead of being silently trusted.
   *
   * WHY THIS MOVED OFF created_by (SK4): migration 085 makes
   * links.provenance_class a GENERATED column over links.mint_via, replacing the created_by
   * CASE of 079/081. created_by is the MECHANISM STAMP; mint_via is the DERIVATION PATH. The
   * proxy was measurably wrong for `created_by='backfill'` (backfillTypedEdges mints from
   * threading tags and decision evidence — declared signals — and 079 called all of it
   * guessed). created_by keeps its own job: the dead-source alarm's liveness grain.
   */
  const EXPECTED: Record<string, 'declared' | 'guessed' | 'unclassified'> = {
    // DECLARED — a human/agent explicitly NAMED the target.
    [EDGE_MINT_VIA.tag]: 'declared',
    [EDGE_MINT_VIA.linksParam]: 'declared',
    [EDGE_MINT_VIA.taskDependencies]: 'declared',
    [EDGE_MINT_VIA.decisionEvidence]: 'declared',
    [EDGE_MINT_VIA.decisionSupersededBy]: 'declared',
    [EDGE_MINT_VIA.parentTaskParam]: 'declared',
    [EDGE_MINT_VIA.position]: 'declared',
    [EDGE_MINT_VIA.trunkRef]: 'declared',
    [EDGE_MINT_VIA.namedRef]: 'declared',
    [EDGE_MINT_VIA.handoffTimeline]: 'declared',
    // The `link` tool: both endpoints named by hand. Before SK4 this path could mint with
    // metadata '{}' and still count declared on its created_by alone; it now carries a via.
    [EDGE_MINT_VIA.linkTool]: 'declared',
    // GUESSED — the system inferred which record to point at.
    [EDGE_MINT_VIA.inference]: 'guessed',
    [EDGE_MINT_VIA.beliefAdjudication]: 'guessed',
    // LEGACY-ONLY, not mintable by any code path (LEGACY_ONLY_MINT_VIA).
    [LEGACY_ONLY_MINT_VIA.anchor]: 'guessed',            // retired session anchor, 079's call
    [LEGACY_ONLY_MINT_VIA.legacyUnlabeled]: 'unclassified', // the closed pre-085 class
  };

  test('the expected table and the mintable vocabulary are the same set (no drift, either way)', () => {
    const classified = Object.keys(EXPECTED).sort();
    const vocabulary = [
      ...EDGE_MINT_VIA_VALUES,
      ...Object.values(LEGACY_ONLY_MINT_VIA),
    ].sort();
    expect(classified).toEqual(vocabulary);
  });

  test.each(Object.entries(EXPECTED))("via '%s' classifies as %s", async (via, expected) => {
    const projectId = await freshProject(`via-${via.replace(/[^a-z]/gi, '')}`);
    const ctx = await insertContext(projectId, `via fixture ${via}`, null);
    const task = await insertTask(projectId, `via target ${via}`);
    const edgeId = (
      await db.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
         VALUES ($1, 'context', $2, 'task', 'informs', $3, 'test:via-fixture', $4) RETURNING id`,
        [ctx, task, projectId, via]
      )
    ).rows[0].id;
    expect(await classOf(edgeId)).toBe(expected);
  });

  test('an UNKNOWN via is fail-closed: unclassified, in neither trusted bucket', async () => {
    const projectId = await freshProject('unknownvia');
    const ctx = await insertContext(projectId, 'unknown-via fixture', null);
    const task = await insertTask(projectId, 'unknown-via target');
    const unknownId = (
      await db.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
         VALUES ($1, 'context', $2, 'task', 'informs', $3, 'auto:some_future_mechanism', 'some-future-path')
         RETURNING id`,
        [ctx, task, projectId]
      )
    ).rows[0].id;
    expect(await classOf(unknownId)).toBe('unclassified');
    expect(await buckets(projectId)).toEqual({ declared: 0, guessed: 0, unclassified: 1 });
  });

  /**
   * THE FAIL-CLOSED FLOOR (SK4 scope a + c), asserted at the layer that holds against every
   * client: an edge naming no mint path cannot be INSERTed at all. This is deliberately raw
   * SQL rather than mintEdge() — mintEdge's required `via` parameter is the compile-time
   * layer and its isEdgeMintVia() check is the runtime layer, and neither of those can say
   * anything about a psql session, a future service, or a migration. Only the column can.
   *
   * The empty-string case is the one that would otherwise slip through: '' satisfies NOT
   * NULL and means nothing, which is why 085 carries links_mint_via_nonempty as well.
   *
   * NO MESSAGE MATCHING: `db` is wrapped by the datastore error boundary (config/database.ts),
   * which replaces every driver error with a caller-safe DatastoreError — so the pg error
   * text is deliberately unavailable here and asserting on it would be asserting on the
   * boundary, not on the constraint. The DISCRIMINATOR is the control at the end: an INSERT
   * differing from the two rejected ones ONLY in its mint_via succeeds, so the rejections
   * are about the via and not about the fixture being unwritable for some other reason.
   */
  test('an edge with NO mint_via, and one with an empty mint_via, are both rejected by the DB', async () => {
    const projectId = await freshProject('failclosed');
    const ctx = await insertContext(projectId, 'fail-closed fixture', null);
    const task = await insertTask(projectId, 'fail-closed target');

    await expect(
      db.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by)
         VALUES ($1, 'context', $2, 'task', 'informs', $3, 'link')`,
        [ctx, task, projectId]
      )
    ).rejects.toThrow(); // NOT NULL: no mint_via named at all

    await expect(
      db.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
         VALUES ($1, 'context', $2, 'task', 'informs', $3, 'link', '   ')`,
        [ctx, task, projectId]
      )
    ).rejects.toThrow(); // links_mint_via_nonempty: present but blank

    // CONTROL — the same INSERT, differing only in mint_via, succeeds.
    const ok = await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
       VALUES ($1, 'context', $2, 'task', 'informs', $3, 'link', $4) RETURNING id`,
      [ctx, task, projectId, EDGE_MINT_VIA.linkTool]
    );
    expect(ok.rows.length).toBe(1);
  });
});

describe('bucket isolation through the PRODUCTION mint paths (acceptance 2)', () => {
  test('tag-path declared edge and inference-path guessed edge each increment ONLY their own bucket', async () => {
    const projectId = await freshProject('buckets');

    // Baseline: a fresh project has empty buckets.
    expect(await buckets(projectId)).toEqual({ declared: 0, guessed: 0, unclassified: 0 });

    // ── DECLARED, via the production TAG path: the exact call context.routes.ts makes
    // after a store whose tags name a task (task:<id8> → typed edge, createdBy
    // 'auto:context_store').
    const targetTask = await insertTask(projectId, 'declared-edge target');
    const declaredSrc = await insertContext(projectId, 'declared-edge source', unitVec());
    const tagMint = await autoMintFromTags({
      fromId: declaredSrc,
      fromType: 'context',
      tags: [`task:${targetTask.slice(0, 8)}`],
      projectId,
      createdBy: 'auto:context_store',
    });
    expect(tagMint.minted).toBe(1);
    expect(await buckets(projectId)).toEqual({ declared: 1, guessed: 0, unclassified: 0 });

    // ── GUESSED, via the production INFERENCE path: inferAndMintRelatedTo with the same
    // createdBy the production caller passes (context.routes.ts: 'auto:inference'). The
    // candidate must be a non-orphan with an embedding — declaredSrc qualifies (it has the
    // tag edge above and a unit vector); an identical-vector source scores cosine 1.0.
    const guessedSrc = await insertContext(projectId, 'guessed-edge source', unitVec());
    const inf = await inferAndMintRelatedTo(
      { fromId: guessedSrc, projectId, createdBy: 'auto:inference' },
      db
    );
    expect(inf.reason).toBe('minted');
    expect(await buckets(projectId)).toEqual({ declared: 1, guessed: 1, unclassified: 0 });

    // ── The meter read surface reports the same buckets the view holds.
    const meter = await readProvenanceMeter({ projectId, weeks: 2 });
    const totals = meter.byClass.reduce(
      (acc, r) => ({
        declared: acc.declared + r.declared,
        guessed: acc.guessed + r.guessed,
        unclassified: acc.unclassified + r.unclassified,
      }),
      { declared: 0, guessed: 0, unclassified: 0 }
    );
    expect(totals).toEqual({ declared: 1, guessed: 1, unclassified: 0 });
    // Source grain carries the stamps themselves — the granularity the 2026-07-28
    // collapse is only visible at.
    const stamps = meter.bySource.map((r) => r.createdBy).sort();
    expect(stamps).toEqual(['auto:context_store', 'auto:inference']);
  });
});
