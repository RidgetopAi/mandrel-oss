/**
 * Re-embed backfill CORE.
 *
 * The testable engine behind scripts/reembed-gemma.ts (a thin CLI wrapper). Re-embeds
 * contexts + technical_decisions through the CURRENTLY-SELECTED embedder
 * (embeddingConfig.activeEmbedder()) into that embedder's column (activeEmbeddingColumn()). Lives
 * in src/ (not scripts/) so the CI gate's vitest suite can exercise the REAL logic — the
 * --force --project scope guard in particular (the reviewer finding 2).
 *
 * DESIGN: config-driven (no hardcoded model/dim/column); embed text mirrors the store path
 * EXACTLY (buildContextEmbeddingText / buildDecisionEmbeddingText); idempotent + resumable
 * (default: only rows that NEED an embedding — see needsReembedSql below: a NULL column OR a
 * DEGENERATE zero-norm vector, which is NOT NULL but uncomparable); dry-run unless apply=true.
 */
import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { embeddingService } from '../services/embedding.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { degenerateEmbeddingSql } from './embedding/degenerate.js';
import { buildContextEmbeddingText } from '../handlers/context.js';
import { buildDecisionEmbeddingText } from '../handlers/decisions.js';
import { buildTaskEmbeddingTextFromRow } from './embedding/taskEmbeddingText.js';

export interface BackfillArgs {
  apply: boolean;
  force: boolean;
  batchSize: number;
  project?: string;
  allProjects: boolean;
  understandTarget: boolean;
}

export interface BackfillStats {
  total: number;
  done: number;
  failed: number;
}

const COL = activeEmbeddingColumn(); // trusted identifier from config (never user input)

/**
 * THE "needs re-embedding" PREDICATE — the single gate that decides whether a row is
 * already embedded. Read by the CLI backfill AND by the self-heal worker (reembedWorker
 * runs this engine with force:false), so it is the one place that definition exists.
 *
 * A NULL column is the classic needs-embed marker. It is NOT the only one: a DEGENERATE
 * (zero-norm) vector is NOT NULL and so satisfied the old `IS NULL` gate forever, while
 * being invisible to semantic recall (pgvector similarity against it is NaN) — measured on
 * a real ci_* DB, a zero-vector row and a NULL row in the same project, and
 * the old heal set contained ONLY the NULL row. A vector that cannot be compared to anything
 * is not an embedding, so it belongs in the heal set. The degeneracy test itself is defined
 * once in services/embedding/degenerate.ts (alongside its JS twin, which is what stops a new
 * one being written) — never spelled out here.
 */
function needsReembedSql(): string {
  return `(${COL} IS NULL OR ${degenerateEmbeddingSql(COL)})`;
}
// COST NOTE (the reviewer N2): the degeneracy half of this predicate is NON-SARGABLE — it computes
// a per-row inner product over the full vector, so this WHERE is a sequential scan plus one
// N-dimensional dot product per row on every sweep. At the current corpus (~8k contexts, 768-d)
// that is negligible next to the re-embedding itself, which is why it is not indexed. It is
// linear in rows × dimensions, so it will NOT stay negligible at 10× — if that lands, the fix is
// a partial/expression index or a persisted `embedding_degenerate` boolean maintained on write,
// NOT a weaker predicate. This is a deliberate cost, not an oversight.

/** Build the row-selection WHERE. The force term is a SINGLE grouped predicate so that
 * `--force --project=X` stays scoped to X: without the parens, `col IS NULL OR TRUE AND
 * project_id=$n` binds AND tighter than OR → every project would match (finding 2). */
function buildWhere(force: boolean, projectFilter: string | null, params: any[]): string {
  const where = [`(${force ? 'TRUE' : needsReembedSql()})`];
  if (projectFilter) { params.push(projectFilter); where.push(`project_id = $${params.length}`); }
  return where.join(' AND ');
}

/**
 * ── THE BACKFILL REGISTRY (S4) ────────────────────────────────────────────
 *
 * ONE spec per embedded table. Everything that varies between tables lives HERE; everything
 * that does not lives in backfillTable() below, ONCE.
 *
 * WHY A REGISTRY REPLACED THE HAND-WRITTEN PER-TABLE FUNCTIONS: `backfillContexts` and
 * `backfillDecisions` were two ~25-line bodies that differed only in a SELECT list, an ORDER
 * BY and a text builder — and were IDENTICAL in the parts that are easy to get wrong (the
 * scoped WHERE, the dry-run branch, the per-row try/catch, the progress cadence, the stats).
 * Adding `tasks` as a third copy would have made three chances for those to drift. The
 * measured shape of this class of bug is already in this file: the `--force --project` scope
 * bug (finding 2) was a WHERE-clause defect, and a third copy is a third place to reintroduce
 * it. Now the WHERE is built in exactly one place and every table gets it.
 *
 * THE REGISTRY IS ALSO THE COVERAGE CONTRACT. The CLI (scripts/reembed-gemma.ts) and the
 * self-heal worker (services/reembedWorker.ts) both ITERATE this array rather than naming
 * tables — so a table that is registered is backfilled AND healed, and a table that is not
 * registered is neither. There is no third list to keep in sync.
 *
 * ADDING A TABLE: add a spec here. That is the whole edit. The table must (a) have the active
 * embedding column (`activeEmbeddingColumn()` — both `embedding` and `embedding_gemma` per
 * migration 088 / 056) and (b) have a `project_id` column, which the optional --project scope
 * filters on.
 */
export interface BackfillTableSpec {
  /** Stable key used in CLI output, worker logs and tests. */
  key: string;
  /** Physical table name. Trusted (source-code literal), interpolated into SQL. */
  table: string;
  /** Plural human label for progress/summary lines. */
  label: string;
  /** Column list this table's text builder needs, plus `id`. */
  selectColumns: string;
  /** Deterministic, oldest-first ordering so an interrupted run resumes sensibly. */
  orderBy: string;
  /** Row -> the EXACT text the write path would embed for that row. */
  buildText: (row: any) => string;
}

export const BACKFILL_TABLES: BackfillTableSpec[] = [
  {
    key: 'contexts',
    table: 'contexts',
    label: 'contexts',
    selectColumns: 'id, project_id, context_type, content, tags',
    orderBy: 'created_at ASC',
    buildText: (row) =>
      buildContextEmbeddingText(row.context_type, row.tags || [], String(row.content ?? '')),
  },
  {
    key: 'decisions',
    table: 'technical_decisions',
    label: 'decisions',
    selectColumns:
      'id, decision_type, title, description, rationale, problem_statement, success_criteria, tags',
    orderBy: 'decision_date ASC',
    buildText: (row) =>
      buildDecisionEmbeddingText({
        decisionType: row.decision_type,
        title: row.title,
        description: row.description,
        rationale: row.rationale,
        problemStatement: row.problem_statement,
        successCriteria: row.success_criteria,
        tags: row.tags || [],
      }),
  },
  {
    // TASKS (S7) — the source smart_search has listed since commit 1 and never
    // had embeddings for. Registered here AFTER migration 088 adds the columns; the text is
    // built by the SAME function the write path uses, so a backfilled row and a freshly
    // written row are byte-identical inputs to the embedder.
    key: 'tasks',
    table: 'tasks',
    label: 'tasks',
    selectColumns: 'id, project_id, type, priority, tags, title, description',
    orderBy: 'created_at ASC',
    buildText: (row) => buildTaskEmbeddingTextFromRow(row),
  },
];

/** Look a spec up by key. Throws on an unknown key rather than silently backfilling nothing. */
export function backfillSpec(key: string): BackfillTableSpec {
  const spec = BACKFILL_TABLES.find((t) => t.key === key);
  if (!spec) {
    throw new Error(
      `Unknown backfill table "${key}". Registered: ${BACKFILL_TABLES.map((t) => t.key).join(', ')}`,
    );
  }
  return spec;
}

/**
 * THE ONE BACKFILL LOOP. Selects the spec's needs-reembed set (scoped), and — only when
 * args.apply — re-embeds each row through the active embedder into the active column.
 *
 * A per-row failure is COUNTED and the sweep CONTINUES: one poison row must never stop the
 * other 3,500 (and a still-failing row is simply retried on the next sweep, because it stays
 * NULL and therefore stays in the needs-reembed set).
 */
export async function backfillTable(
  spec: BackfillTableSpec, projectFilter: string | null, args: BackfillArgs, pool: Pool = db
): Promise<BackfillStats> {
  const params: any[] = [];
  const whereSql = buildWhere(args.force, projectFilter, params);
  const rows = (await pool.query(
    `SELECT ${spec.selectColumns} FROM ${spec.table} WHERE ${whereSql} ORDER BY ${spec.orderBy}`, params
  )).rows;
  console.log(`📦 ${spec.label} needing re-embed (col=${COL}, force=${args.force}): ${rows.length}`);
  let done = 0, failed = 0;
  for (const row of rows) {
    const text = spec.buildText(row);
    try {
      if (args.apply) {
        const emb = await embeddingService.generateEmbedding({ text, role: 'document' });
        await pool.query(`UPDATE ${spec.table} SET ${COL} = $1::vector WHERE id = $2`, [`[${emb.embedding.join(',')}]`, row.id]);
      }
      done++;
      if (done % args.batchSize === 0) console.log(`   …${spec.label} ${done}/${rows.length}`);
    } catch (e) {
      failed++;
      console.error(`   ⚠️  ${spec.label} row ${String(row.id).slice(0, 8)} failed: ${(e as Error).message}`);
    }
  }
  return { total: rows.length, done, failed };
}

/** Backfill EVERY registered table, in registry order. Returns stats keyed by spec key. */
export async function backfillAllTables(
  projectFilter: string | null, args: BackfillArgs, pool: Pool = db
): Promise<Record<string, BackfillStats>> {
  const out: Record<string, BackfillStats> = {};
  for (const spec of BACKFILL_TABLES) {
    out[spec.key] = await backfillTable(spec, projectFilter, args, pool);
  }
  return out;
}

/**
 * NAMED WRAPPERS — kept because existing tests and call sites import them by name. Thin
 * delegations to the registry; they hold no logic of their own, so they cannot drift from it.
 */
export async function backfillContexts(
  projectFilter: string | null, args: BackfillArgs, pool: Pool = db
): Promise<BackfillStats> {
  return backfillTable(backfillSpec('contexts'), projectFilter, args, pool);
}

export async function backfillDecisions(
  projectFilter: string | null, args: BackfillArgs, pool: Pool = db
): Promise<BackfillStats> {
  return backfillTable(backfillSpec('decisions'), projectFilter, args, pool);
}

export async function backfillTasks(
  projectFilter: string | null, args: BackfillArgs, pool: Pool = db
): Promise<BackfillStats> {
  return backfillTable(backfillSpec('tasks'), projectFilter, args, pool);
}

/** Resolve a project by UUID or name → id, or null if not found. */
export async function resolveProjectId(project: string, pool: Pool = db): Promise<string | null> {
  const byId = await pool.query('SELECT id FROM projects WHERE id::text = $1', [project]);
  if (byId.rows.length) return byId.rows[0].id;
  const byName = await pool.query('SELECT id FROM projects WHERE name = $1', [project]);
  return byName.rows.length ? byName.rows[0].id : null;
}
