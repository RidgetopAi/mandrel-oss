/**
 * D1 — ANCHOR DEMOTION (migration 080 §3) — the PHASE 1 acceptance-5 contract
 * (scope WIDENED to decided_by by Coordinator's 2026-08-13
 * ruling: "the anchor mints nothing strong" covers both edge types — prod held
 * informs 157 + decided_by 111 at measurement).
 *
 * The migration demotes every `auto:active_thread` strong edge (`informs` AND
 * `decided_by`) to the weak tier (`related_to`) with provenance preserved, absorbs dedup
 * collisions (an existing related_to twin), and is IDEMPOTENT. The CI DB has already run
 * 080 once (the migration runner); this test SEEDS fresh anchor-minted rows and
 * RE-APPLIES the migration file — which is itself the idempotency claim exercised for
 * real: the file must be safely re-runnable on a DB that already ran it.
 *
 * What is asserted, per the task's acceptance 5 + the widening ruling:
 *   - post-migration count of strong auto:active_thread edges (BOTH types) = 0;
 *   - reclassified edges retain original provenance (created_by unchanged; the original
 *     edge_type — informs OR decided_by — + demotion timestamp recorded in metadata);
 *   - a dedup collision (related_to twin exists) DELETES the strong row and stamps the
 *     surviving twin — reachability preserved via the twin, nothing silently lost;
 *   - re-running the migration mints/updates/deletes NOTHING (byte-stable rows);
 *   - an `informs` by any OTHER minter is NOT touched (created_by scope).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { db } from '../config/database.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, '..', '..', 'database', 'migrations', '080_positional_membership.sql');

const STAMP = Date.now();
let projectId: string;
const ids: Record<string, string> = {};

async function newContext(label: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'discussion', $2) RETURNING id::text AS id`,
      [projectId, `d1-fixture ${label} ${STAMP}`]
    )
  ).rows[0].id;
}
async function newTask(label: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, $2, 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId, `d1-fixture ${label} ${STAMP}`]
    )
  ).rows[0].id;
}
async function newDecision(label: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, impact_level, status)
       VALUES ($1, 'architecture', $2, 'd', 'r', 'low', 'active') RETURNING id::text AS id`,
      [projectId, `d1-fixture ${label} ${STAMP}`]
    )
  ).rows[0].id;
}
/**
 * The mint path each seeded stamp stands in for. links.mint_via is NOT NULL since migration
 * 085 (SK4), and this suite's subject is the ANCHOR's demotion — so the anchor
 * stamp must carry the anchor via, or the fixture would not be the row the demotion targets.
 */
const SEED_VIA: Record<string, string> = {
  'auto:active_thread': 'anchor',
  'auto:inference': 'inference',
  'auto:context_store': 'tag',
  link: 'link-tool',
};

async function seedEdge(fromId: string, toId: string, edgeType: string, createdBy: string, metadata: any = { seeded: true }) {
  const mintVia = SEED_VIA[createdBy];
  if (!mintVia) throw new Error(`seedEdge: no mint_via mapped for stamp "${createdBy}"`);
  await db.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, metadata)
     VALUES ($1, 'context', $2, 'task', $3, $4, $5, $6, $7::jsonb)`,
    [fromId, toId, edgeType, projectId, createdBy, mintVia, JSON.stringify(metadata)]
  );
}

/** The acceptance query, verbatim shape: strong anchor edges remaining, per type. */
async function strongAnchorCounts(): Promise<{ informs: number; decided_by: number }> {
  const r = await db.query(
    `SELECT
       count(*) FILTER (WHERE edge_type = 'informs')::int    AS informs,
       count(*) FILTER (WHERE edge_type = 'decided_by')::int AS decided_by
     FROM links WHERE created_by = 'auto:active_thread'`
  );
  return r.rows[0];
}
/** Full row snapshot of every link in this test's project (for idempotency byte-compare). */
async function projectLinkRows(): Promise<any[]> {
  return (
    await db.query(
      `SELECT from_id, to_id, edge_type, created_by, metadata FROM links WHERE project_id = $1
        ORDER BY from_id, to_id, edge_type`,
      [projectId]
    )
  ).rows;
}

async function applyMigration(): Promise<void> {
  await db.query(readFileSync(MIGRATION, 'utf8'));
}

describe('D1 — demote auto:active_thread strong informs (migration 080, acceptance 5)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'D1 demotion fixture') RETURNING id`,
        [`d1-demotion-${STAMP}`]
      )
    ).rows[0].id;

    // Fixture graph, one context per scenario:
    //  plain   — anchor informs, no twin → must CONVERT in place.
    //  twin    — anchor informs + an existing related_to twin → informs DELETED, twin stamped.
    //  control — anchor decided_by (→ decision) → must ALSO be demoted (the widened scope).
    //  human   — human-minted informs → must be UNTOUCHED (created_by scope).
    //  autoStore — auto:context_store informs → must be UNTOUCHED. The created_by scope
    //    control needs a DECLARED-class auto:* minter, not just 'link' (Reviewer probe:
    //    widening the predicates to LIKE 'auto:%' left the old suite GREEN — on prod that
    //    mutation would demote 1,457 auto:context_store declared edges).
    ids.taskTarget = await newTask('target task');
    ids.decisionTarget = await newDecision('target decision');
    ids.plain = await newContext('plain');
    ids.twin = await newContext('twin');
    ids.control = await newContext('control');
    ids.human = await newContext('human');
    ids.autoStore = await newContext('autoStore');

    await seedEdge(ids.plain, ids.taskTarget, 'informs', 'auto:active_thread');
    await seedEdge(ids.twin, ids.taskTarget, 'informs', 'auto:active_thread');
    await seedEdge(ids.twin, ids.taskTarget, 'related_to', 'auto:inference', { pre: 'existing twin' });
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, metadata)
       VALUES ($1, 'context', $2, 'decision', 'decided_by', $3, 'auto:active_thread', 'anchor', '{"seeded":true}'::jsonb)`,
      [ids.control, ids.decisionTarget, projectId]
    );
    await seedEdge(ids.human, ids.taskTarget, 'informs', 'link');
    await seedEdge(ids.autoStore, ids.taskTarget, 'informs', 'auto:context_store');
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* teardown noise */ }
    await db.end();
  });

  test('demotes BOTH strong types, absorbs, preserves provenance, leaves other minters alone — then re-runs as a no-op', async () => {
    // Pre-state: the seeded strong population is present, in both types.
    const pre = await strongAnchorCounts();
    expect(pre.informs).toBeGreaterThanOrEqual(2);
    expect(pre.decided_by).toBeGreaterThanOrEqual(1);

    await applyMigration();

    // ── ACCEPTANCE 5 (widened): post-migration strong anchor edges = 0, BOTH types ──
    expect(await strongAnchorCounts()).toEqual({ informs: 0, decided_by: 0 });

    // plain: converted IN PLACE — related_to now, created_by PRESERVED, original type recorded.
    const plain = (
      await db.query(`SELECT edge_type, created_by, metadata FROM links WHERE from_id = $1 AND to_id = $2`, [ids.plain, ids.taskTarget])
    ).rows;
    expect(plain).toHaveLength(1);
    expect(plain[0].edge_type).toBe('related_to');
    expect(plain[0].created_by).toBe('auto:active_thread');
    expect(plain[0].metadata.d1_demoted).toBe(true);
    expect(plain[0].metadata.original_edge_type).toBe('informs');
    expect(plain[0].metadata.seeded).toBe(true); // pre-existing metadata merged, not replaced

    // twin: the informs row is GONE; the surviving related_to twin is stamped as the absorber.
    const twin = (
      await db.query(`SELECT edge_type, created_by, metadata FROM links WHERE from_id = $1 AND to_id = $2 ORDER BY edge_type`, [ids.twin, ids.taskTarget])
    ).rows;
    expect(twin).toHaveLength(1);
    expect(twin[0].edge_type).toBe('related_to');
    expect(twin[0].created_by).toBe('auto:inference'); // the twin's own provenance, untouched
    expect(twin[0].metadata.d1_absorbed_informs).toBe(true);
    expect(twin[0].metadata.pre).toBe('existing twin');

    // control: the anchor's decided_by is DEMOTED too (Coordinator's widening ruling) — same
    // provenance preservation, original type recorded as decided_by.
    const control = (
      await db.query(`SELECT edge_type, created_by, metadata FROM links WHERE from_id = $1`, [ids.control])
    ).rows;
    expect(control).toHaveLength(1);
    expect(control[0].edge_type).toBe('related_to');
    expect(control[0].created_by).toBe('auto:active_thread');
    expect(control[0].metadata.d1_demoted).toBe(true);
    expect(control[0].metadata.original_edge_type).toBe('decided_by');
    expect(control[0].metadata.seeded).toBe(true);

    // human: an informs by any OTHER minter is untouched.
    const human = (
      await db.query(`SELECT edge_type, created_by FROM links WHERE from_id = $1`, [ids.human])
    ).rows;
    expect(human).toEqual([{ edge_type: 'informs', created_by: 'link' }]);

    // autoStore: a DECLARED auto:* minter's informs is untouched — the created_by scope is
    // EXACTLY 'auto:active_thread', not an auto:% family (Reviewer NIT 1: this is the
    // control that goes RED if the demotion predicates are widened to LIKE 'auto:%').
    const autoStore = (
      await db.query(`SELECT edge_type, created_by FROM links WHERE from_id = $1`, [ids.autoStore])
    ).rows;
    expect(autoStore).toEqual([{ edge_type: 'informs', created_by: 'auto:context_store' }]);

    // ── IDEMPOTENT: a re-run changes NOTHING (full row-level compare) ──
    const before = await projectLinkRows();
    await applyMigration();
    const after = await projectLinkRows();
    expect(after).toEqual(before);
    expect(await strongAnchorCounts()).toEqual({ informs: 0, decided_by: 0 });
  });
});
