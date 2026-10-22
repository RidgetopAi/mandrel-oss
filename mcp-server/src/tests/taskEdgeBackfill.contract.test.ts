/**
 * TASK-EDGE BACKFILL — contract + adversarial tests (Q5).
 *
 * The backfill applies the write-path minters to the ~706 tasks that were created before
 * task_create minted anything. It runs against LIVE DATA, so the properties that make it
 * gateable are the ones under test here:
 *
 *   * DRY-RUN COUNTS == APPLY COUNTS — because the dry run IS the real code inside a
 *     rolled-back transaction, not a second estimating implementation that could disagree.
 *   * A DRY RUN WRITES NOTHING (the rollback actually rolls back).
 *   * IDEMPOTENT — a second apply mints 0 (mintEdge's ON CONFLICT DO NOTHING).
 *   * PER-TASK PROJECT SCOPING — proven with a deliberately COLLIDING id8 fixture across two
 *     projects. This is the single most likely way to mint confidently-wrong edges at scale,
 *     so it gets a hostile test rather than a happy-path one.
 *   * THE UNDO REMOVES EXACTLY THE BACKFILL SET — and provably not a write-path or
 *     human-curated edge on the same (from,to,type).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { mintEdge } from '../services/links.js';
import {
  runTaskEdgeBackfill,
  undoTaskEdgeBackfill,
  BACKFILL_CREATED_BY,
} from '../services/taskEdgeBackfill.js';
import { TASK_EDGE_CREATED_BY } from '../config/tagEdgeConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const PROJ_A = `backfill-A-${STAMP}`;
const PROJ_B = `backfill-B-${STAMP}`;

let projectA: string;
let projectB: string;

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

/** Insert a task DIRECTLY (bypassing the route) — simulating a pre-minting legacy task. */
async function legacyTask(
  projectId: string,
  title: string,
  opts: { tags?: string[]; dependencies?: string[]; id?: string } = {}
): Promise<string> {
  const cols = ['project_id', 'title', 'type', 'status', 'priority', 'tags', 'dependencies'];
  const vals: any[] = [
    projectId,
    title,
    'general',
    'todo',
    'medium',
    opts.tags ?? null,
    opts.dependencies ?? null,
  ];
  let sql = `INSERT INTO tasks (${cols.join(', ')}`;
  if (opts.id) {
    sql += ', id';
    vals.push(opts.id);
  }
  sql += `) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`;
  const r = await db.query(sql, vals);
  return r.rows[0].id;
}

async function edgeCountFor(createdBy: readonly string[], projectId?: string): Promise<number> {
  const params: any[] = [createdBy];
  let sql = `SELECT count(*)::int AS c FROM links WHERE created_by = ANY($1)`;
  if (projectId) {
    params.push(projectId);
    sql += ` AND project_id = $${params.length}`;
  }
  const r = await db.query(sql, params);
  return r.rows[0].c;
}

describe('task-edge backfill (an earlier task Q5)', () => {
  beforeAll(async () => {
    projectA = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'backfill A') RETURNING id`,
        [PROJ_A]
      )
    ).rows[0].id;
    projectB = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'backfill B') RETURNING id`,
        [PROJ_B]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      for (const pid of [projectA, projectB]) {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      }
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── DRY RUN: real numbers, zero writes ─────────────────────────────────────
  describe('dry run', () => {
    test('projects real counts and writes NOTHING; a subsequent apply matches exactly', async () => {
      const depTarget = await legacyTask(projectA, 'backfill dep target');
      const dec = (
        await db.query(
          `INSERT INTO technical_decisions
             (project_id, decision_type, title, description, rationale, impact_level)
           VALUES ($1,'pattern','backfill decision','d','r','medium') RETURNING id::text AS id`,
          [projectA]
        )
      ).rows[0].id;

      await legacyTask(projectA, 'legacy with deps', { dependencies: [depTarget] });
      await legacyTask(projectA, 'legacy with tags', { tags: [`decision:${id8(dec)}`] });

      const before = await edgeCountFor(BACKFILL_CREATED_BY, projectA);
      expect(before, 'no backfill edges yet').toBe(0);

      const dry = await runTaskEdgeBackfill({ projectId: projectA }, db);
      expect(dry.dryRun).toBe(true);
      expect(dry.totalMinted, 'the dry run projects real mints').toBeGreaterThan(0);
      expect(dry.dependencyEdges).toBe(1);
      expect(dry.tagEdges).toBe(1);

      // THE ROLLBACK ACTUALLY ROLLED BACK.
      expect(await edgeCountFor(BACKFILL_CREATED_BY, projectA), 'dry run wrote nothing').toBe(0);

      // DRY-RUN COUNTS == APPLY COUNTS.
      const applied = await runTaskEdgeBackfill({ projectId: projectA, apply: true }, db);
      expect(applied.dryRun).toBe(false);
      expect(applied.totalMinted).toBe(dry.totalMinted);
      expect(applied.dependencyEdges).toBe(dry.dependencyEdges);
      expect(applied.tagEdges).toBe(dry.tagEdges);
      expect(applied.byEdgeType).toEqual(dry.byEdgeType);
      expect(await edgeCountFor(BACKFILL_CREATED_BY, projectA)).toBe(applied.totalMinted);
    });

    test('the report quantifies the TRUST-BEARING subset (the visible behaviour change)', async () => {
      // decided_by enters the trust walk; depends_on does not. The operator must see the
      // number BEFORE applying, not discover the score shift afterwards.
      const summary = await runTaskEdgeBackfill({ projectId: projectA }, db);
      expect(summary.trustBearingEdges).toBe(summary.byEdgeType.decided_by ?? 0);
      expect(summary.byEdgeType.depends_on ?? 0).toBeGreaterThan(0);
    });
  });

  // ── IDEMPOTENCE ────────────────────────────────────────────────────────────
  test('a SECOND apply mints 0 (idempotent by construction — ON CONFLICT DO NOTHING)', async () => {
    const second = await runTaskEdgeBackfill({ projectId: projectA, apply: true }, db);
    expect(second.totalMinted, 're-running the backfill mints nothing new').toBe(0);
  });

  // ── PER-TASK PROJECT SCOPING (the hostile case) ────────────────────────────
  describe('per-task project scoping with COLLIDING id8 prefixes', () => {
    test('a tag resolves against the TASK\'S OWN project, never another project\'s match', async () => {
      // Build a genuine collision: two decisions in DIFFERENT projects whose ids share the
      // same leading 8 hex chars. A backfill that resolved against an ambient/active project
      // (or unscoped) would attach project B's task to project A's decision.
      const sharedPrefix = 'abcdef12';
      const decA = `${sharedPrefix}-1111-4111-8111-111111111111`;
      const decB = `${sharedPrefix}-2222-4222-8222-222222222222`;

      for (const [pid, did, label] of [
        [projectA, decA, 'collision decision A'],
        [projectB, decB, 'collision decision B'],
      ] as const) {
        await db.query(
          `INSERT INTO technical_decisions
             (id, project_id, decision_type, title, description, rationale, impact_level)
           VALUES ($1,$2,'pattern',$3,'d','r','medium')`,
          [did, pid, label]
        );
      }

      // Sanity: the prefix really is ambiguous ACROSS projects (the trap is real).
      const both = await db.query(
        `SELECT id::text FROM technical_decisions WHERE id::text LIKE $1 || '%'`,
        [sharedPrefix]
      );
      expect(both.rows.length, 'the fixture genuinely collides').toBe(2);

      // A task in project B tagging that ambiguous prefix.
      const taskB = await legacyTask(projectB, 'task in B tagging a colliding prefix', {
        tags: [`decision:${sharedPrefix}`],
      });

      await runTaskEdgeBackfill({ projectId: projectB, apply: true }, db);

      const edges = await db.query(
        `SELECT to_id::text AS to_id FROM links WHERE from_id = $1 AND edge_type = 'decided_by'`,
        [taskB]
      );
      expect(edges.rows.length, 'exactly one edge minted').toBe(1);
      // THE ASSERTION: it points at B's decision, NOT A's. Scoping made the ambiguous
      // prefix unambiguous within the task's own project.
      expect(edges.rows[0].to_id).toBe(decB);
      expect(edges.rows[0].to_id).not.toBe(decA);
    });

    test('an unresolvable ref is SKIPPED and reported, never guessed at', async () => {
      await legacyTask(projectB, 'task with a dead tag', {
        tags: ['decision:99999999'],
      });
      const summary = await runTaskEdgeBackfill({ projectId: projectB }, db);
      expect(summary.skips.length).toBeGreaterThan(0);
      expect(summary.skips.some((s) => s.ref === '99999999')).toBe(true);
    });
  });

  // ── THE UNDO ───────────────────────────────────────────────────────────────
  describe('provenance-scoped undo', () => {
    test('removes EXACTLY the backfill set — write-path and human edges survive', async () => {
      // A "human curated" edge and a "write path" edge, both on the SAME (from,to,type)
      // shape the backfill also produces, but with different provenance.
      const t1 = await legacyTask(projectA, 'undo: human edge source');
      const t2 = await legacyTask(projectA, 'undo: human edge target');
      await mintEdge({
        fromId: t1,
        fromType: 'task',
        toId: t2,
        toType: 'task',
        edgeType: 'related_to',
        projectId: projectA,
        createdBy: 'link', // a human `link` call
        via: EDGE_MINT_VIA.linkTool,
      });
      const t3 = await legacyTask(projectA, 'undo: write-path source');
      await mintEdge({
        fromId: t3,
        fromType: 'task',
        toId: t2,
        toType: 'task',
        edgeType: 'related_to',
        projectId: projectA,
        createdBy: TASK_EDGE_CREATED_BY.taskTags, // the live write path
        via: EDGE_MINT_VIA.tag,
      });

      const backfillBefore = await edgeCountFor(BACKFILL_CREATED_BY, projectA);
      expect(backfillBefore).toBeGreaterThan(0);

      // Dry-run the undo first: it reports, removes nothing.
      const undoDry = await undoTaskEdgeBackfill({ projectId: projectA }, db);
      expect(undoDry.dryRun).toBe(true);
      expect(undoDry.removed).toBe(backfillBefore);
      expect(await edgeCountFor(BACKFILL_CREATED_BY, projectA)).toBe(backfillBefore);

      // Apply it.
      const undone = await undoTaskEdgeBackfill({ projectId: projectA, apply: true }, db);
      expect(undone.removed).toBe(backfillBefore);
      expect(await edgeCountFor(BACKFILL_CREATED_BY, projectA), 'backfill set gone').toBe(0);

      // THE OTHER TWO SURVIVE — the undo is scoped by provenance, not by shape.
      expect(await edgeCountFor(['link'], projectA), 'human edge survives').toBe(1);
      expect(
        await edgeCountFor([TASK_EDGE_CREATED_BY.taskTags], projectA),
        'write-path edge survives'
      ).toBe(1);
    });
  });
});
