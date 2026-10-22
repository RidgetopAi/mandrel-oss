/**
 * ONE-TIME TASK-EDGE BACKFILL — the existing 706 tasks that were born graph leaves
 * (Q5).
 *
 * task_create now mints edges, but every task created BEFORE that still has zero outbound
 * edges. This applies the SAME write-time minters to the existing backlog, in two passes:
 *
 *   PASS 1  `dependencies` column -> `depends_on` edges   (createdBy backfill:task_deps)
 *   PASS 2  threading tags        -> the matrix's edges   (createdBy backfill:task_tags)
 *
 * REUSE, DON'T REINVENT: pass 2 drives `autoMintFromTags` and pass 1 drives
 * `autoMintFromTaskDependencies` — the EXACT helpers the task_create route uses. There is no
 * second minter here and no second copy of the matrix; this module only ENUMERATES tasks and
 * calls the shared code per task. A parallel backfill minter would be free to drift from the
 * write path, which is the whole failure mode.
 *
 * ── THE FOUR NON-NEGOTIABLES ────────────────────────────────────────────────────────────
 *
 * 1. PER-TASK PROJECT SCOPING. Every tag is resolved against THE TASK'S OWN project_id —
 *    never a session's "active project". This is the single most likely way to mint
 *    confidently-wrong edges at scale: two projects routinely contain id8 prefixes that
 *    collide, so resolving project B's task against project A silently attaches the edge to
 *    whatever A happens to have at that prefix. The contract test proves this with a
 *    deliberately COLLIDING two-project fixture.
 *
 * 2. DRY-RUN IS THE DEFAULT. A live write needs an explicit `apply: true`. The dry run is not
 *    a separate estimating code path (which could disagree with reality) — it runs the REAL
 *    minters inside a transaction and ROLLS BACK. So "dry-run counts == apply counts" is true
 *    BY CONSTRUCTION, not by two implementations happening to agree.
 *
 * 3. IDEMPOTENT BY CONSTRUCTION. mintEdge is ON CONFLICT DO NOTHING on
 *    UNIQUE(from_id,to_id,edge_type) and reports created:false on a dedup, so a second run
 *    mints 0. Asserted, not assumed.
 *
 * 4. WHOLESALE REVERSIBLE. Every edge this backfill mints carries a DISTINCT createdBy stamp
 *    (`backfill:task_deps` / `backfill:task_tags`), so the undo is ONE provenance-scoped
 *    statement. THE PROPERTY THAT CARRIES THE GATE IS NOT "we won't be wrong" — it is "if
 *    we're wrong, the undo is one statement."
 *
 *    THE MECHANISM, PRECISELY (undoTaskEdgeBackfill): a direct
 *        DELETE FROM links WHERE created_by = ANY(<the two backfill stamps>)
 *    optionally narrowed by project_id. It does NOT go through unlinkEdge — the protection is
 *    the WHERE clause itself. `links.created_by` is single-valued per row, and the backfill's
 *    two stamps are disjoint from every write-path stamp (`auto:task_create`,
 *    `auto:task_deps`, `auto:task_update`, `links:task_create`) and from human ones (`link`),
 *    so a row minted by any other path simply does not match and is never touched. Proven in
 *    the contract test with a human `link` edge and a write-path edge planted on the same
 *    (from,to,type) shape: the undo removed exactly the backfill rows and left both.
 *
 *    HONEST LIMIT (same single-valued-created_by issue as tag removal): mintEdge dedups on
 *    (from,to,type) with FIRST WRITER WINS on created_by. So if the backfill minted an edge
 *    the write path would later also justify, the row keeps the BACKFILL stamp and the undo
 *    WILL remove it — even though a live write also warranted it. The re-mint on the next
 *    write restores it, and the alternative (leaving rows the undo cannot account for) is
 *    worse, but do not read "the undo is exact" as stronger than "the undo removes exactly
 *    the rows STAMPED by the backfill."
 *
 * ⚠️ TRUST-SCORE SIDE EFFECT — OPERATOR MUST NOT DISCOVER THIS, HE MUST BE TOLD. Backfilled
 * `decided_by` edges enter the TRUST WALK (decided_by is in trust.ts OUTCOME_OUT_EDGE_TYPES).
 * Trust scores on old tasks WILL SHIFT after pass 2 — that is the POINT (tasks finally ladder
 * up to the decisions that authorized them) but it is a visible behaviour change on live data.
 * `depends_on` deliberately does NOT do this (it is not an outcome edge), so pass 1 is
 * trust-inert. The dry-run report quantifies the exposure: it counts the decided_by edges that
 * WOULD be minted, so the blast radius is a number before it is a decision.
 */

import type { Pool, PoolClient } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { autoMintFromTags, autoMintFromTaskDependencies, type MintSkip } from './links.js';
import { TASK_EDGE_CREATED_BY } from '../config/tagEdgeConfig.js';

/** The two provenance stamps this backfill writes — the undo keys on exactly these. */
export const BACKFILL_CREATED_BY: readonly string[] = [
  TASK_EDGE_CREATED_BY.backfillDeps,
  TASK_EDGE_CREATED_BY.backfillTags,
];

/** How many example rows the dry-run report carries. */
export const SAMPLE_SIZE = 20;

/** One task considered by the backfill. */
interface TaskRow {
  id: string;
  project_id: string;
  tags: string[] | null;
  dependencies: string[] | null;
}

/** One minted-edge example for the dry-run report. */
export interface BackfillSample {
  taskId: string;
  projectId: string;
  pass: 'dependencies' | 'tags';
  /** What produced it (the dependency ref or the tag). */
  source: string;
}

export interface BackfillOptions {
  /** WRITE. Default false = dry run (transaction + rollback). */
  apply?: boolean;
  /** Restrict to ONE project (by id). Omit to run across every project. */
  projectId?: string;
  /** Safety cap on tasks processed (0 = no cap). */
  limit?: number;
}

export interface BackfillSummary {
  dryRun: boolean;
  /** Tasks examined (had tags and/or dependencies). */
  tasksConsidered: number;
  /** Edges newly created by pass 1. */
  dependencyEdges: number;
  /** Edges newly created by pass 2. */
  tagEdges: number;
  /** Total newly created. */
  totalMinted: number;
  /** Per edge-type counts of what was minted (the report the operator reads). */
  byEdgeType: Record<string, number>;
  /**
   * Of the above, how many are `decided_by` — the TRUST-BEARING subset whose backfill will
   * SHIFT trust scores on existing tasks. Surfaced as its own number so the behaviour change
   * is quantified, not buried in a total.
   */
  trustBearingEdges: number;
  /** Refs that resolved to nothing (skipped, never guessed at). */
  skips: Array<MintSkip & { taskId: string }>;
  /** Up to SAMPLE_SIZE example mints, for eyeballing before applying. */
  samples: BackfillSample[];
}

/**
 * Fetch the tasks in scope: those carrying tags and/or dependencies (anything else can mint
 * nothing, so processing it would be pure noise in the report).
 */
async function fetchTasks(
  pool: Pool | PoolClient,
  opts: BackfillOptions
): Promise<TaskRow[]> {
  const params: any[] = [];
  let sql = `SELECT id::text AS id, project_id::text AS project_id, tags, dependencies
               FROM tasks
              WHERE (tags IS NOT NULL AND array_length(tags, 1) > 0)
                 OR (dependencies IS NOT NULL AND array_length(dependencies, 1) > 0)`;
  if (opts.projectId) {
    params.push(opts.projectId);
    sql += ` AND project_id = $${params.length}`;
  }
  sql += ` ORDER BY created_at ASC`;
  if (opts.limit && opts.limit > 0) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const res = await pool.query(sql, params);
  return res.rows;
}

/** Count edges by type for the given provenance stamps, within an optional project. */
async function countByEdgeType(
  pool: Pool | PoolClient,
  createdBy: readonly string[],
  projectId?: string
): Promise<Record<string, number>> {
  const params: any[] = [createdBy];
  let sql = `SELECT edge_type, count(*)::int AS c FROM links WHERE created_by = ANY($1)`;
  if (projectId) {
    params.push(projectId);
    sql += ` AND project_id = $${params.length}`;
  }
  sql += ` GROUP BY edge_type`;
  const res = await pool.query(sql, params);
  const out: Record<string, number> = {};
  for (const r of res.rows) out[r.edge_type] = r.c;
  return out;
}

/**
 * The core run, against a given executor. Shared by the dry run (a rolled-back transaction)
 * and the real apply — so there is exactly ONE backfill implementation.
 */
async function runPasses(
  exec: Pool | PoolClient,
  tasks: TaskRow[]
): Promise<Omit<BackfillSummary, 'dryRun' | 'byEdgeType' | 'trustBearingEdges'>> {
  let dependencyEdges = 0;
  let tagEdges = 0;
  const skips: Array<MintSkip & { taskId: string }> = [];
  const samples: BackfillSample[] = [];

  for (const task of tasks) {
    // ── PASS 1: dependencies -> depends_on ─────────────────────────────────────
    if (task.dependencies && task.dependencies.length > 0) {
      const res = await autoMintFromTaskDependencies(
        {
          taskId: task.id,
          dependencies: task.dependencies,
          // PER-TASK SCOPING: the task's OWN project, never an ambient/active one.
          projectId: task.project_id,
          createdBy: TASK_EDGE_CREATED_BY.backfillDeps,
        },
        exec as Pool
      );
      dependencyEdges += res.minted;
      for (const s of res.skips) skips.push({ ...s, taskId: task.id });
      if (res.minted > 0 && samples.length < SAMPLE_SIZE) {
        samples.push({
          taskId: task.id,
          projectId: task.project_id,
          pass: 'dependencies',
          source: `${res.minted} dependency ref(s)`,
        });
      }
    }

    // ── PASS 2: threading tags -> the matrix ───────────────────────────────────
    if (task.tags && task.tags.length > 0) {
      const res = await autoMintFromTags(
        {
          fromId: task.id,
          fromType: 'task',
          tags: task.tags,
          // PER-TASK SCOPING again — the failure mode this backfill most has to avoid.
          projectId: task.project_id,
          createdBy: TASK_EDGE_CREATED_BY.backfillTags,
        },
        exec as Pool
      );
      tagEdges += res.minted;
      for (const s of res.skips) skips.push({ ...s, taskId: task.id });
      if (res.minted > 0 && samples.length < SAMPLE_SIZE) {
        samples.push({
          taskId: task.id,
          projectId: task.project_id,
          pass: 'tags',
          source: task.tags.filter((t) => /^(task|decision|context):/i.test(t)).join(', '),
        });
      }
    }
  }

  return {
    tasksConsidered: tasks.length,
    dependencyEdges,
    tagEdges,
    totalMinted: dependencyEdges + tagEdges,
    skips,
    samples,
  };
}

/**
 * Run the backfill.
 *
 * DRY RUN (default): opens a transaction, runs the REAL minters, measures, then ROLLS BACK.
 * The projection is therefore the actual behaviour, not a model of it.
 *
 * APPLY: the same passes against the pool, committed per-statement as usual (each mintEdge is
 * independent and idempotent, so a mid-run interruption leaves a partial but CORRECT and
 * re-runnable state — never a corrupt one).
 */
export async function runTaskEdgeBackfill(
  opts: BackfillOptions = {},
  pool: Pool = db
): Promise<BackfillSummary> {
  const dryRun = !opts.apply;

  if (dryRun) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tasks = await fetchTasks(client, opts);
      const result = await runPasses(client, tasks);
      // Measure INSIDE the transaction — this is what WOULD exist after an apply.
      const byEdgeType = await countByEdgeType(client, BACKFILL_CREATED_BY, opts.projectId);
      return {
        dryRun: true,
        ...result,
        byEdgeType,
        trustBearingEdges: byEdgeType.decided_by ?? 0,
      };
    } finally {
      // ALWAYS roll back, including on an error path — a dry run must never leave a row.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the connection may already be unusable; releasing it discards the txn anyway */
      }
      client.release();
    }
  }

  const tasks = await fetchTasks(pool, opts);
  logger.info(`🔗 task-edge backfill: APPLYING across ${tasks.length} task(s)`);
  const result = await runPasses(pool, tasks);
  const byEdgeType = await countByEdgeType(pool, BACKFILL_CREATED_BY, opts.projectId);
  return {
    dryRun: false,
    ...result,
    byEdgeType,
    trustBearingEdges: byEdgeType.decided_by ?? 0,
  };
}

/**
 * THE UNDO — one provenance-scoped statement. Removes EXACTLY the edges this backfill minted
 * and nothing else: a `decided_by` edge on the same (from,to) minted by the WRITE path
 * (auto:task_create) or by a human (`link`) carries a different created_by and survives.
 *
 * This is the property that makes the prod run gateable: being wrong costs one command.
 */
export async function undoTaskEdgeBackfill(
  opts: { projectId?: string; apply?: boolean } = {},
  pool: Pool = db
): Promise<{ removed: number; dryRun: boolean }> {
  const params: any[] = [BACKFILL_CREATED_BY];
  let where = `created_by = ANY($1)`;
  if (opts.projectId) {
    params.push(opts.projectId);
    where += ` AND project_id = $${params.length}`;
  }

  if (!opts.apply) {
    const res = await pool.query(`SELECT count(*)::int AS c FROM links WHERE ${where}`, params);
    return { removed: res.rows[0].c, dryRun: true };
  }
  const res = await pool.query(`DELETE FROM links WHERE ${where} RETURNING id`, params);
  return { removed: res.rowCount ?? res.rows.length, dryRun: false };
}

/** Render a summary as the human report the operator reads before deciding to apply. */
export function formatSummary(s: BackfillSummary): string {
  const lines: string[] = [];
  lines.push(s.dryRun ? '🔍 DRY RUN (nothing written — transaction rolled back)' : '✍️  APPLIED');
  lines.push(`   tasks considered:   ${s.tasksConsidered}`);
  lines.push(`   pass 1 depends_on:  ${s.dependencyEdges}`);
  lines.push(`   pass 2 tag edges:   ${s.tagEdges}`);
  lines.push(`   TOTAL minted:       ${s.totalMinted}`);
  lines.push('   by edge type:');
  for (const [t, c] of Object.entries(s.byEdgeType).sort()) lines.push(`      ${t}: ${c}`);
  lines.push(
    `   ⚠️  trust-bearing (decided_by): ${s.trustBearingEdges} — these ENTER THE TRUST WALK; ` +
      'trust scores on existing tasks will shift.'
  );
  lines.push(`   skipped (unresolvable): ${s.skips.length}`);
  if (s.skips.length > 0) {
    for (const sk of s.skips.slice(0, 10)) {
      lines.push(`      • task ${sk.taskId.slice(0, 8)}: ${sk.reason}`);
    }
    if (s.skips.length > 10) lines.push(`      … and ${s.skips.length - 10} more`);
  }
  if (s.samples.length > 0) {
    lines.push(`   sample (${s.samples.length}):`);
    for (const ex of s.samples) {
      lines.push(`      • [${ex.pass}] task ${ex.taskId.slice(0, 8)} ← ${ex.source}`);
    }
  }
  lines.push('');
  lines.push(
    '   UNDO: one provenance-scoped statement — ' +
      `DELETE FROM links WHERE created_by = ANY(ARRAY[${BACKFILL_CREATED_BY.map((c) => `'${c}'`).join(', ')}]);`
  );
  return lines.join('\n');
}
