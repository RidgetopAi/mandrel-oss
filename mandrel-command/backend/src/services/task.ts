import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import { buildSearchPredicate } from '../utils/searchPredicates';
import { LinkService } from './links';
import { McpService } from './mcp';
import { clampListLimit, parseOffset } from '../config/taskAnalytics';
import { DEFAULT_AGG_TIMEZONE } from '../config/analyticsTime';
import {
  ALL_PROJECTS,
  scopeAllows,
  scopePredicate,
  type ProjectListScope,
} from './projectListScope';
import { actorMatchKey, knownActorKind, listBuiltinActors, type ActorKind } from '../config/actorRegistry';

// Define Task interface locally since shared types are not in rootDir
interface Task {
  id: string;
  project_id: string;
  title: string;
  description?: string;
  type: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  /**
   * THE PUNCH LIST LANE (migration 101). SOURCE OF TRUTH over `status`
   * on the mcp-server side; mirrored read-only here. Null on a cancelled task or a legacy
   * row that predates this migration.
   */
  stage?: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigned_to?: string;
  dependencies: string[];
  tags: string[];
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  /**
   * SOFT-DELETE marker. `null` = live; a timestamp = archived, i.e.
   * what BOTH the UI Delete and MCP `task_delete` now mean by "deleted". Serialized so
   * the drawer can offer Restore instead of Delete on an archived record.
   */
  archived_at?: string | null;
}

/**
 * Task Service
 * Comprehensive task management operations for AIDIS
 */

/** The Punch List `punch` shape — { doneWhen, proofKind, source? } — mirrors mcp-server's
 * punchParam (mcp-server/src/middleware/validation.ts). Each field nullable: an explicit
 * null deletes that sub-key from `metadata.punch` (utils/punchMerge.ts on the mcp-server
 * side); omitted leaves it untouched. */
export interface PunchRequest {
  doneWhen?: string | null;
  proofKind?: 'test' | 'browser' | 'look' | null;
  source?: 'form' | 'chat' | 'machine' | null;
}

export interface CreateTaskRequest {
  project_id: string;
  title: string;
  description?: string;
  type?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assigned_to?: string;
  dependencies?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
  /** THE PUNCH LIST LANE (migration 101). */
  stage?: string;
  punch?: PunchRequest;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  type?: string;
  status?: 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assigned_to?: string;
  dependencies?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
  /** THE PUNCH LIST LANE (migration 101). */
  stage?: string;
  punch?: PunchRequest;
}

/**
 * THE PUNCH LIST LANE (migration 101). Thrown when the mcp-server tool
 * refuses a write with `[PUNCH_INCOMPLETE]` — the controller catches this specifically and
 * returns a 400 carrying the SAME `code`/`missing` (and, for a bulk call, `rows`) the
 * mcp-server response structured — never a generic 500 for a caller-fixable input error.
 */
export class PunchIncompleteRequestError extends Error {
  readonly code = 'PUNCH_INCOMPLETE';

  constructor(
    public readonly missing: string[],
    public readonly rows?: { taskId: string; missing: string[] }[],
  ) {
    super(`Punch list incomplete: missing ${missing.join(', ') || '(see rows)'}`);
    this.name = 'PunchIncompleteRequestError';
  }
}

export interface TaskFilter {
  /**
   * The projects these rows may come from — REQUIRED, no default (an earlier task item 7).
   * `project_id?: string` used to live here and an absent value meant NO FILTER, i.e.
   * every project. See services/projectListScope.ts.
   */
  scope: ProjectListScope;
  assigned_to?: string;
  status?: string | string[];
  /** THE PUNCH LIST LANE FILTER (migration 101). Single value or array. */
  stage?: string | string[];
  /**
   * PER-COLUMN PAGING. A stage column's rows must exclude the BLOCKED
   * LANE — the Punch board's `columnFor` (frontend/pages/punch/stage.ts) renders a
   * `status==='blocked'` task in the blocked lane regardless of its stage, so a per-stage
   * server read has to apply the same override or a blocked task would double-render (its
   * own stage column AND the blocked lane). Single value or array, same shape as `status`.
   */
  excludeStatus?: string | string[];
  priority?: string | string[];
  type?: string;
  tags?: string[];
  search?: string;
  /** Page size — bounded server-side (clamped to TASK_LIST_CONFIG.maxLimit). */
  limit?: number;
  /** Row offset for pagination (non-negative). */
  offset?: number;
  /**
   * ARCHIVE SCOPE. The list excludes soft-deleted rows by DEFAULT
   * (`archived_at IS NULL`) — absent both flags you get live tasks only, which is what
   * every existing caller (board, list, ops bar) wants and what MCP `task_list` already
   * did. `archived_only` is the explicit "Archived" view (`IS NOT NULL`);
   * `include_archived` is the both-worlds escape hatch (no archive predicate at all).
   * `archived_only` WINS if somehow both are set — the narrower, explicit intent.
   */
  include_archived?: boolean;
  archived_only?: boolean;
}

/**
 * One assignee SUGGESTION returned by `TaskService.getActorOptions` — see that method for
 * the security note. Never a whitelist entry: free text remains legal everywhere.
 */
export interface ActorOption {
  /** The canonical spelling to offer the user. See `mergeActorOptions` for how it is picked. */
  actor: string;
  /** The principal kind when the actor is in the first-party registry, else `null`. */
  kind: ActorKind | null;
  /** Live (non-archived) tasks in scope whose `assigned_to` matches, case-insensitively. */
  taskCount: number;
  /** Sessions in scope whose `actor` matches, case-insensitively. */
  sessionCount: number;
  /**
   * Which of the three sources contributed this option. `builtin` means the static
   * first-party roster (not project data); the other two mean real usage in this scope.
   */
  sources: Array<'builtin' | 'tasks' | 'sessions'>;
  /**
   * The OTHER spellings seen in scope for this same case-insensitive key, excluding the
   * canonical one. This is the drift itself, made visible rather than silently collapsed.
   */
  variants: string[];
}

/** A per-(key, spelling) tally from one of the two DB halves. */
interface ActorTally {
  key: string;
  label: string;
  n: number;
}

/**
 * Merge the three sources into one deduped, ordered suggestion list.
 *
 * MATCHING: strictly case-insensitive (`actorMatchKey` = trim + lowercase). Exactly what
 * The operator approved, and deliberately no more — see the note on `actorMatchKey`.
 *
 * CANONICAL SPELLING, in order:
 *   1. the built-in registry's spelling if the key is a first-party principal — the
 *      registry is the definition of how that actor is spelled;
 *   2. otherwise the most-used spelling (tasks first, then sessions);
 *   3. ties broken alphabetically, so the answer is deterministic rather than
 *      dependent on row order.
 *
 * ORDER: by real usage — taskCount desc, sessionCount desc, actor asc. Built-ins that
 * nobody has used sort last with zero counts, which is the honest position for them.
 *
 * Pure and exported so it can be exercised without a database.
 */
export function mergeActorOptions(
  taskTallies: ActorTally[],
  sessionTallies: ActorTally[],
): ActorOption[] {
  interface Acc {
    taskCount: number;
    sessionCount: number;
    sources: Set<'builtin' | 'tasks' | 'sessions'>;
    /** spelling -> weight, used to pick the canonical label. */
    spellings: Map<string, { tasks: number; sessions: number }>;
  }
  const byKey = new Map<string, Acc>();

  const acc = (key: string): Acc => {
    let a = byKey.get(key);
    if (!a) {
      a = { taskCount: 0, sessionCount: 0, sources: new Set(), spellings: new Map() };
      byKey.set(key, a);
    }
    return a;
  };
  const spelling = (a: Acc, label: string) => {
    let s = a.spellings.get(label);
    if (!s) {
      s = { tasks: 0, sessions: 0 };
      a.spellings.set(label, s);
    }
    return s;
  };

  for (const t of taskTallies) {
    if (!t.key) continue;
    const a = acc(t.key);
    a.taskCount += t.n;
    a.sources.add('tasks');
    spelling(a, t.label).tasks += t.n;
  }
  for (const s of sessionTallies) {
    if (!s.key) continue;
    const a = acc(s.key);
    a.sessionCount += s.n;
    a.sources.add('sessions');
    spelling(a, s.label).sessions += s.n;
  }

  const builtinLabel = new Map<string, string>();
  for (const b of listBuiltinActors()) {
    const key = actorMatchKey(b.actor);
    builtinLabel.set(key, b.actor);
    acc(key).sources.add('builtin');
  }

  const options: ActorOption[] = [];
  for (const [key, a] of byKey) {
    const ranked = [...a.spellings.entries()].sort(
      (x, y) =>
        y[1].tasks - x[1].tasks ||
        y[1].sessions - x[1].sessions ||
        x[0].localeCompare(y[0]),
    );
    const canonical = builtinLabel.get(key) ?? ranked[0]?.[0] ?? key;
    options.push({
      actor: canonical,
      kind: knownActorKind(canonical),
      taskCount: a.taskCount,
      sessionCount: a.sessionCount,
      // Stable, legible order rather than Set-insertion order.
      sources: (['builtin', 'tasks', 'sessions'] as const).filter((s) => a.sources.has(s)),
      variants: ranked.map(([label]) => label).filter((label) => label !== canonical),
    });
  }

  options.sort(
    (x, y) =>
      y.taskCount - x.taskCount ||
      y.sessionCount - x.sessionCount ||
      x.actor.localeCompare(y.actor),
  );
  return options;
}

export interface TaskStats {
  total: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  by_type: Record<string, number>;
  completion_rate: number;
  avg_completion_time?: number;
  /**
   * Count of SOFT-DELETED (archived) tasks in scope. Reported alongside,
   * never inside, `total` / `by_status` — those are live-only. Feeds the Archived view's
   * chip count so it comes from a real uncapped COUNT, not the capped list.
   */
  archived?: number;
}

export interface TaskDependency {
  id: string;
  title: string;
  status: string;
  blocking_tasks: string[];
}

/**
 * One typed graph edge touching a task, resolved for display (the "build story" /
 * TreeWalker moat surfaced on the task-thread detail). These are REAL rows from the
 * `links` table (the typed-edge graph, migration 049) — never task `dependencies` or
 * any semantic "related" list.
 *
 *  - `direction: 'outgoing'` — the edge is stored from THIS task → the other record
 *    (this task is `from_id`); read it forward (e.g. "produced → <context>").
 *  - `direction: 'incoming'` — the edge points AT this task (this task is `to_id`);
 *    the caller reads it with the reverse label (e.g. "informed by").
 *  - `otherKind` is the target's kind for colour/label: a context's `context_type`
 *    (milestone / handoff / …), or the literal `'decision'` / `'task'`.
 *  - `otherTitle` is the target's human title: a decision/task `title`, or a context's
 *    first content line.
 *
 * Mirrors ContextService.getContextLinks exactly (same shape, same joins) so the two
 * thread boxes render identically — the only difference is the subject id's kind.
 */
export interface TaskLink {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherType: 'context' | 'decision' | 'task';
  otherTitle: string;
  otherKind: string;
}

/**
 * SOFT-DELETE — the ARCHIVE semantics, shared by delete and restore.
 *
 * `archived_at` (migration 046) is the ONE meaning of "deleted" on the `tasks` table.
 * The MCP surface (`task_delete` / `task_restore` → TasksHandler.archiveTask/restoreTask)
 * has always used it; the Command UI's Delete used to run a HARD `DELETE FROM tasks`,
 * so a UI delete destroyed a row the MCP layer believed was merely archived — two delete
 * semantics on one table, and no undo. Both surfaces now set/clear the same column.
 *
 * Distinct from the `cancelled` STATUS, which is a lifecycle state a task KEEPS while
 * still listed. Archived rows leave the default list/board/counts and come back only in
 * the explicit Archived view — or permanently via restore.
 *
 * ── HOW THIS RELATES TO MCP's TaskArchiveResult — read this before assuming parity ──
 * The two types agree on the DATABASE EFFECT (which columns are written) and NOT on the
 * result shape. They are deliberately NOT the same type, and an earlier version of this
 * comment claimed they "mirror exactly", which was false in three ways and is precisely
 * the sentence that let a real divergence through review. The differences:
 *
 *   1. `alreadyArchived` on a RESTORE means the OPPOSITE thing. Restoring an
 *      already-live task: this type reports `false` ("it is not archived" — the
 *      end-state), MCP reports `true` ("this call was a no-op"). Do not compare the
 *      two surfaces' booleans; compare the row.
 *   2. MCP additionally carries `id`, and on archive `claimHeld` / `claimActor` /
 *      `claimExpiresAt` — it refuses to archive a task under a live claim and says so.
 *      This surface has no such outcome: see deleteTask's note on why it is not fenced.
 *   3. MCP's archive/restore are PROJECT-SCOPED (`taskId` + `projectId`, so one project
 *      cannot archive another's task). These methods take an id ALONE and are scoped by
 *      the route's own auth instead. Hence `found` here means "the row exists", full stop.
 *
 * What IS guaranteed to match is the write: both set/clear `archived_at`, and both clear
 * the claim columns on restore. That guarantee is the one under test, not this shape.
 */
export interface TaskArchiveResult {
  /**
   * The row exists. NOT project-scoped — unlike MCP's equivalent, these methods take an
   * id alone (see note 3 above); the route's auth is what bounds the caller. `false` → 404.
   */
  found: boolean;
  /**
   * The row was ALREADY in the requested end-state, so this call changed nothing. Both
   * operations are idempotent — a double-delete is not an error, and neither is restoring
   * a live task. NOTE the polarity difference from MCP on restore (note 1 above).
   */
  alreadyArchived: boolean;
  /** The archive timestamp after the call — set by delete, `null` after restore. */
  archivedAt: string | null;
}

/**
 * One id that a bulk status update did NOT move, and why.
 *
 * This type exists because `bulkUpdateStatus` stopped being one database transaction. It
 * delegates, so it can no longer roll a partial batch back — which means a partial batch is
 * now a REAL outcome and needs somewhere honest to land. Silence was survivable while the
 * only skip was a non-existent id; it is not survivable now that a group can be refused
 * (an offline mcp-server, a project the caller cannot write, a live task claim the tool
 * declines to stomp).
 */
export interface BulkStatusSkip {
  id: string;
  /** Verbatim from the tool where there is one — never flattened to a generic string. */
  reason: string;
}

/** The outcome of a bulk status update: what moved, and what did not. */
export interface BulkStatusUpdateResult {
  /** The rows that were actually updated, read back after the write, in REQUEST order. */
  tasks: Task[];
  /** Empty on a fully successful batch. */
  skipped: BulkStatusSkip[];
}

export class TaskService {
  /**
   * Count active tasks (Oracle Phase 2 dashboard requirement)
   * Active = NOT completed (todo, in_progress, blocked)
   *
   * Archived (soft-deleted) rows are NOT active — excluded.
   */
  static async countActive(scope: ProjectListScope): Promise<number> {
    try {
      let query = "SELECT COUNT(*) FROM tasks WHERE archived_at IS NULL AND status != 'completed' AND status != 'cancelled'";
      const params: any[] = [];

      query += scopePredicate(scope, 'project_id', params);

      const result = await pool.query(query, params);
      const count = parseInt(result.rows[0].count);

      logger.info(`📊 TaskService.countActive - Scope: ${scope.mode}, Count: ${count}`);
      return count;
    } catch (error) {
      logger.error('Task count active error', { error });
      throw new Error('Failed to get active task count');
    }
  }

  /**
   * Get all tasks with optional filtering
   */
  /**
   * PER-COLUMN PAGING. `total` is the TRUE count matching every clause
   * above the LIMIT — computed in the SAME query via `COUNT(*) OVER()` rather than a
   * second round-trip — so a caller paging one board column (`stage`/`status` filter +
   * a small `limit`) can show a real "N of TOTAL" / "load more" affordance instead of
   * mistaking the page length for the whole column. `0` rows still means `total: 0`
   * (the window function returns nothing to divide by when the result set is empty).
   */
  static async getTasks(filter: TaskFilter): Promise<{ tasks: Task[]; total: number }> {
    try {
      let query = `
        SELECT
          t.id, t.project_id, t.title, t.description, t.type,
          t.status, t.stage, t.priority, t.assigned_to, t.dependencies,
          t.tags, t.metadata, t.created_at, t.updated_at, t.archived_at,
          p.name as project_name,
          t.assigned_to as assigned_to_name,
          COUNT(*) OVER() AS full_count
        FROM tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE 1=1
      `;

      const params: any[] = [];
      let paramIndex = 1;

      // SOFT-DELETE SCOPE. Default (neither flag) = live rows only.
      //
      // Two properties hold the door here, and NEITHER of them is this clause's position.
      // Every clause below is AND-ed onto the same string, so the predicate is exactly as
      // effective last as first — an earlier version of this comment claimed being "first"
      // stopped a future branch being added above it, which is not a mechanism SQL has.
      // What actually protects it:
      //   1. It is UNCONDITIONAL — there is no caller input that removes the archive
      //      predicate altogether; the only choice is WHICH of the three predicates applies.
      //   2. The only OR-bearing clause, the search predicate, arrives as a PARENTHESIZED
      //      group (`buildSearchPredicate` returns `(a OR b OR c)` — utils/searchPredicates.ts).
      //      An UNPARENTHESIZED OR is the one shape that would fail open, because
      //      `archived_at IS NULL AND title ILIKE x OR id::text = y` binds AND tighter than
      //      OR and would return archived rows. Guarded by searchPredicateParenthesized in
      //      taskSoftDelete.db.test.ts.
      if (filter.archived_only) {
        query += ` AND t.archived_at IS NOT NULL`;
      } else if (!filter.include_archived) {
        query += ` AND t.archived_at IS NULL`;
      }

      query += scopePredicate(filter.scope, 't.project_id', params);
      paramIndex = params.length + 1;

      if (filter.assigned_to) {
        query += ` AND t.assigned_to = $${paramIndex++}`;
        params.push(filter.assigned_to);
      }

      if (filter.status) {
        if (Array.isArray(filter.status)) {
          query += ` AND t.status = ANY($${paramIndex++})`;
          params.push(filter.status);
        } else {
          query += ` AND t.status = $${paramIndex++}`;
          params.push(filter.status);
        }
      }

      // PER-COLUMN PAGING exclusion — see the field doc on TaskFilter.
      if (filter.excludeStatus) {
        if (Array.isArray(filter.excludeStatus)) {
          query += ` AND t.status <> ALL($${paramIndex++})`;
          params.push(filter.excludeStatus);
        } else {
          query += ` AND t.status <> $${paramIndex++}`;
          params.push(filter.excludeStatus);
        }
      }

      if (filter.priority) {
        if (Array.isArray(filter.priority)) {
          query += ` AND t.priority = ANY($${paramIndex++})`;
          params.push(filter.priority);
        } else {
          query += ` AND t.priority = $${paramIndex++}`;
          params.push(filter.priority);
        }
      }

      // THE PUNCH LIST LANE FILTER (migration 101). `stage IS NOT NULL`
      // stated explicitly, same reasoning as the mcp-server-side filter: a NULL compared to
      // any value is NULL so a cancelled/legacy row is excluded either way, but a reader
      // should not have to know that to know whether "no stage recorded" counts as a match.
      if (filter.stage) {
        if (Array.isArray(filter.stage)) {
          query += ` AND t.stage IS NOT NULL AND t.stage = ANY($${paramIndex++})`;
          params.push(filter.stage);
        } else {
          query += ` AND t.stage = $${paramIndex++}`;
          params.push(filter.stage);
        }
      }

      if (filter.type) {
        query += ` AND t.type = $${paramIndex++}`;
        params.push(filter.type);
      }

      if (filter.tags && filter.tags.length > 0) {
        query += ` AND t.tags && $${paramIndex++}`;
        params.push(filter.tags);
      }

      if (filter.search) {
        // Search matches title/description, id (full UUID or hex prefix), and
        // partial tags — all OR'd, via the shared predicate builder (mirrors
        // mcp-server idResolver; see utils/searchPredicates.ts).
        const clause = buildSearchPredicate(filter.search, paramIndex, {
          textColumns: ['t.title', 't.description'],
          idColumn: 't.id',
          tagsColumn: 't.tags',
        });
        query += ` AND ${clause.sql}`;
        params.push(...clause.params);
        paramIndex = clause.nextParamIndex;
      }

      query += ` ORDER BY
        -- TERMINAL VS QUEUE. status = 'completed' is the only terminal
        -- status either board renders as a real column: the Tasks board's Done column IS
        -- status='completed' (STATUS_COLUMNS, frontend/pages/tasks/config.ts), and the
        -- Punch board's Merged/Deployed stages both IMPLY status='completed'
        -- (STATUS_FOR_STAGE, frontend/pages/punch/config.ts) — a cancelled task is not
        -- rendered on either board. A terminal row answers "what finished most recently",
        -- so it sorts by completed_at DESC. A queue row (still open) answers "what's most
        -- urgent", so it keeps the priority-first order below. This bucket makes the split
        -- explicit rather than leaning on ORDER BY's NULLS LAST default.
        CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END,
        -- QUEUE ORDER — evaluates to NULL (and is ignored) on a terminal row.
        CASE WHEN t.status <> 'completed' THEN
          CASE t.priority
            WHEN 'urgent' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            WHEN 'low' THEN 4
          END
        END,
        -- TERMINAL ORDER — evaluates to NULL (and is ignored) on a queue row. NULLS LAST so
        -- a legacy row with no completed_at stamp (migration 099 left 208 of these NULL
        -- rather than inventing a date) sorts to the BOTTOM of Done, not the top — we do
        -- not know when it finished, so it cannot claim to be the most recent.
        -- completed_at, not closed_at: both are populated on these rows (closed_at was
        -- backfilled from completed_at by migration 098), but completed_at is the field
        -- that means exactly "reached completed", which is exactly what this column is.
        -- closed_at also covers a cancelled close, which neither board ever shows.
        CASE WHEN t.status = 'completed' THEN t.completed_at END DESC NULLS LAST,
        t.created_at DESC,
        -- TOTAL ORDER (tail kept verbatim by an earlier task). Priority +
        -- created_at tie routinely — a board of same-priority tasks filed in one batch
        -- shares both keys, and so do completed_at ties (migration 099: bulk completions
        -- land in one batch sharing a literal timestamp) — and this list is LIMIT/OFFSET
        -- paged below, so a partial order can show one task on two pages and hide another.
        -- t.id is the primary key: unique (the composite becomes total), stable under
        -- edits so a page boundary does not move under a concurrent write (why this is the
        -- PK and not updated_at), and already indexed.
        t.id DESC
      `;

      // Bound the returned ROWS server-side (the board/list was previously UNBOUNDED —
      // every task in every project when unscoped). Always applies a clamped LIMIT (named
      // config default when absent), with an optional OFFSET for pagination. Ordering above
      // is preserved. Stats (`/tasks/stats`) is a COUNT and stays uncapped, so KPIs are
      // unaffected — only the board rows are bounded.
      const limit = clampListLimit(filter.limit);
      query += ` LIMIT $${paramIndex++}`;
      params.push(limit);

      const offset = parseOffset(filter.offset);
      if (offset > 0) {
        query += ` OFFSET $${paramIndex++}`;
        params.push(offset);
      }

      const result = await pool.query(query, params);

      const tasks = result.rows.map((row: any) => ({
        id: row.id,
        project_id: row.project_id,
        title: row.title,
        description: row.description,
        type: row.type,
        status: row.status,
        stage: row.stage ?? null,
        priority: row.priority,
        assigned_to: row.assigned_to,
        dependencies: row.dependencies,
        tags: row.tags,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at ?? null
      }));
      // `full_count` rides every row (the window function repeats it) — 0 rows means no
      // row to read it from, and that IS the honest total (an empty result).
      const total = result.rows.length > 0 ? parseInt(result.rows[0].full_count, 10) : 0;

      return { tasks, total };
    } catch (error) {
      logger.error('Get tasks error', { error });
      throw new Error('Failed to get tasks');
    }
  }

  /**
   * Get single task by ID.
   *
   * DELIBERATELY NOT archive-filtered: an archived task must stay
   * fetchable by id or Restore is unreachable — you could never open the record you
   * need to un-delete, and a permalink to an archived task would 404 instead of
   * explaining itself. `archived_at` rides along so the drawer renders Restore rather
   * than Delete. The LIST is where archived rows are hidden; the DETAIL is the undo path.
   */
  static async getTaskById(id: string): Promise<Task | null> {
    try {
      const result = await pool.query(`
        SELECT
          t.id, t.project_id, t.title, t.description, t.type,
          t.status, t.stage, t.priority, t.assigned_to, t.dependencies,
          t.tags, t.metadata, t.created_at, t.updated_at, t.archived_at,
          p.name as project_name,
          t.assigned_to as assigned_to_name
        FROM tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE t.id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        project_id: row.project_id,
        title: row.title,
        description: row.description,
        type: row.type,
        status: row.status,
        stage: row.stage ?? null,
        priority: row.priority,
        assigned_to: row.assigned_to,
        dependencies: row.dependencies,
        tags: row.tags,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at ?? null
      };
    } catch (error) {
      logger.error('Get task by ID error', { error });
      throw new Error('Failed to get task');
    }
  }

  /**
   * Create new task — DELEGATES to the mcp-server `task_create` tool (a past incident fix,
   * an earlier task).
   *
   * THE CLASS being fixed: the Mandrel monorepo had TWO independent task-WRITE paths. The
   * mcp-server MCP tools do the FULL job (mint typed graph edges from tags/dependencies +
   * explicit links, human actor attribution, project resolution, activity tracking). This
   * Command backend used to write the row DIRECTLY via raw `INSERT ... RETURNING *`, so a
   * task born through the Command UI was a GRAPH LEAF — it minted nothing, silently drifting
   * from every task born through the tools. The fix is NOT to duplicate the mint logic here
   * (that just creates a 2nd copy to drift); it is to make Command DELEGATE the write so there
   * is ONE write path. `McpService.callTool` is the already-prod-proven seam (auth Bearer +
   * X-Actor-ID, target resolution for both fleet + systemd topologies).
   *
   * BEHAVIOR-PRESERVING from the API consumer's view: the returned REST `Task` shape is
   * unchanged (mapped from the tool's `structuredContent.task`) — the ONLY observable
   * difference is that edges now get minted. Availability coupling is accepted by design:
   * Command is a UI onto the mcp-server, so if the tool call fails the create fails LOUD
   * (never a phantom 200 over a failed write).
   *
   * `actor` (the logged-in principal, `req.user?.username`) is forwarded as X-Actor-ID so the
   * task is attributed to the human who clicked — same pattern as the naming controller.
   */
  static async createTask(taskData: CreateTaskRequest, actor?: string): Promise<Task> {
    const {
      project_id, title, description, type,
      priority, assigned_to, dependencies,
      tags, metadata, stage, punch,
    } = taskData;

    logger.info('TaskService.createTask delegating to task_create', {
      project_id, title, type, priority, assigned_to,
      dependencies, tags,
    });

    // Map Command's create DTO → the task_create tool's arg names (see
    // mcp-server/src/routes/tasks.routes.ts handleCreate). Omit undefined optionals so the
    // tool applies its OWN documented defaults (type 'general', priority 'medium', status
    // 'todo') — a single source for those defaults instead of a drifting copy here.
    const toolArgs: Record<string, any> = { projectId: project_id, title };
    if (description !== undefined) toolArgs.description = description;
    if (type !== undefined) toolArgs.type = type;
    if (priority !== undefined) toolArgs.priority = priority;
    if (assigned_to !== undefined) toolArgs.assignedTo = assigned_to;
    if (dependencies !== undefined) toolArgs.dependencies = dependencies;
    if (tags !== undefined) toolArgs.tags = tags;
    if (metadata !== undefined) toolArgs.metadata = metadata;
    // THE PUNCH LIST LANE (migration 101). PUNCH_INCOMPLETE surfaces as
    // a tool error below, which the controller maps to a 400 (see controllers/task.ts).
    if (stage !== undefined) toolArgs.stage = stage;
    if (punch !== undefined) toolArgs.punch = punch;

    // mcp-write-scope: self-scoped — `toolArgs` is seeded above as `{ projectId: project_id,
    // title }`, and project_id is a REQUIRED field of the create DTO, so this write always
    // names its project. It was already correct before this states why.
    const result = await McpService.callTool('task_create', toolArgs, actor);

    // TOOL ERROR / isError → callTool sets success:false (makeRequest rejects on
    // isError || success===false and on non-200). Map to the SAME thrown error the raw
    // path used, so the controller returns its existing 500 — never a 200 over a failed
    // write. The tool's message is logged, not leaked verbatim to the client.
    if (!result.success) {
      logger.error('Create task delegation failed', { error: result.error });
      throw new Error('Failed to create task');
    }

    // THE PUNCH LIST LANE (migration 101): a REFUSAL with a real
    // machine-readable code, not just prose — surface it as the SAME typed error the
    // controller maps to a 400, never the generic 500 below.
    if (result.data?.code === 'PUNCH_INCOMPLETE') {
      throw new PunchIncompleteRequestError(result.data.missing ?? []);
    }

    // Canonical MACHINE channel: task_create returns structuredContent =
    // { action:'created', task:{...} } (callTool already unwrapped it into result.data).
    // Read the STRUCTURED record — never regex-parse the prose text block.
    const created = result.data?.task;
    if (!created || !created.id) {
      logger.error('Create task delegation returned no task payload', { data: result.data });
      throw new Error('Failed to create task');
    }

    return TaskService.mapToolTaskToRest(created, taskData);
  }

  /**
   * Adapt the mcp-server `task_create` `structuredContent.task` → the REST `Task` shape the
   * TaskController / frontend consume (behavior-preserving). The structured record carries
   * the post-default id/title/type/status/priority/tags/dependencies/assignedTo/createdAt;
   * the fields it does NOT echo (project_id, description, metadata, updated_at) are taken from
   * the request (what was just persisted) — project_id is the resolved target, and on a fresh
   * create updated_at == created_at. Wire format matches the old `INSERT ... RETURNING *`
   * exactly: created_at/updated_at are ISO strings (pg Dates also serialized to ISO by
   * res.json), assigned_to is null when unset.
   */
  private static mapToolTaskToRest(toolTask: any, input: CreateTaskRequest): Task {
    return {
      id: toolTask.id,
      project_id: input.project_id,
      title: toolTask.title,
      description: input.description,
      type: toolTask.type,
      status: toolTask.status,
      stage: toolTask.stage ?? null,
      priority: toolTask.priority,
      assigned_to: toolTask.assignedTo ?? null,
      dependencies: toolTask.dependencies ?? [],
      tags: toolTask.tags ?? [],
      metadata: input.metadata ?? {},
      created_at: toolTask.createdAt,
      updated_at: toolTask.updatedAt ?? toolTask.createdAt,
    };
  }

  /**
   * Update a task — DELEGATES to the mcp-server `task_update` tool (   * completing the class fix `createTask` started under an earlier task).
   *
   * THE CLASS: this backend used to write `UPDATE tasks SET …` directly, so the Command
   * surface and the MCP surface were two independent implementations of the same write.
   * Every invariant then had to be written twice and stayed correct only by luck — and it
   * did NOT stay correct: the `completed_at` lifecycle and the assignee TRANSITION STAMP
   * each had to be discovered, ported and then guarded on BOTH sides (see the twin-site
   * comments this change deletes). Anything the tool learns next — claim fencing, edge
   * re-mint on a tag edit, byproduct branch position on `in_progress`, short-id
   * resolution, project scoping — the raw path silently would not. One owner, one write.
   *
   * WHY IT STILL READS THE ROW FIRST. Three things the delegation cannot supply:
   *   1. ABSENCE vs FAILURE (C1's third state). The REST contract is `null` → 404, and a
   *      tool error cannot be told apart from "no such task" at this layer without asking.
   *   2. PROJECT SCOPE. Every delegated write must name its project; for
   *      an id-addressed update the only correct answer is the ROW's own project_id.
   *   3. THE RESPONSE BODY. `task_update`'s structuredContent carries the APPLIED FIELDS,
   *      not the row, so the REST `Task` is re-read after the write.
   *
   * @param actor the logged-in principal, forwarded as X-Actor-ID. It is what the tool
   *   uses for the assignee TRANSITION STAMP and for session attribution — the same
   *   principal `createTask` forwards. Blank/absent → no header → the tool's own
   *   "no derivable actor" branch (an honest blank, never a placeholder).
   */
  static async updateTask(
    id: string,
    updates: UpdateTaskRequest,
    actor?: string
  ): Promise<Task | null> {
    const current = await TaskService.getTaskById(id);
    if (current === null) return null;

    // FIELDS THE ONE WRITE PATH CANNOT CARRY — REFUSE, NEVER DROP.
    // `task_update` declares no `type` and no `dependencies` param, and its zod runs in
    // STRICT mode, so passing either would fail the whole call. The raw path used to write
    // both. Silently discarding them is the failure mode this whole task exists to remove
    // (a write that reports success and persisted nothing), so an edit that would actually
    // CHANGE one of them is refused with a message naming the gap. A no-op re-send of the
    // current value is not an edit and is dropped — that is what a client echoing the
    // record back does, and refusing it would be noise.
    // `type` WAS closed exactly that way, by lane K, in this same batch. `dependencies`
    // remains unsupported by task_update and is still refused below.
    const unsupported: string[] = [];
    // `type` WAS here until batch 5 lane K added it to taskSchemas.update + a `type = $n`
    // SET clause in the handler + the re-embed trigger set. It is a supported edit now and
    // is forwarded below with the other fields. `dependencies` is still genuinely absent
    // from task_update, so it keeps refusing rather than silently dropping.
    if (
      updates.dependencies !== undefined &&
      JSON.stringify(updates.dependencies) !== JSON.stringify(current.dependencies ?? [])
    ) unsupported.push('dependencies');
    if (unsupported.length > 0) {
      logger.error('Update task refused: task_update does not accept these fields', {
        id, unsupported,
      });
      throw new Error(
        `Cannot update ${unsupported.join(' / ')}: the task_update tool does not accept ` +
        `${unsupported.length > 1 ? 'these fields' : 'this field'} yet, and this backend ` +
        `no longer writes tasks directly.`
      );
    }

    // Command's update DTO → the tool's arg names. Only fields the caller actually sent are
    // forwarded, so an omitted field leaves its column alone exactly as before.
    const toolArgs: Record<string, any> = { taskId: id, projectId: current.project_id };
    let editedFields = 0;
    const put = (key: string, value: any): void => { toolArgs[key] = value; editedFields++; };
    if (updates.title !== undefined) put('title', updates.title);
    if (updates.description !== undefined) put('description', updates.description);
    if (updates.status !== undefined) put('status', updates.status);
    if (updates.priority !== undefined) put('priority', updates.priority);
    if (updates.assigned_to !== undefined) put('assignedTo', updates.assigned_to);
    if (updates.tags !== undefined) put('tags', updates.tags);
    if (updates.metadata !== undefined) put('metadata', updates.metadata);
    if (updates.type !== undefined) put('type', updates.type);
    // THE PUNCH LIST LANE (migration 101).
    if (updates.stage !== undefined) put('stage', updates.stage);
    if (updates.punch !== undefined) put('punch', updates.punch);

    // Same refusal the raw path gave for an empty edit — the tool's own zod `.refine` says
    // the same thing, but this keeps the message and the 500 identical for existing callers
    // and avoids a pointless round trip.
    if (editedFields === 0) {
      throw new Error('No updates provided');
    }

    // mcp-write-scope: self-scoped — `toolArgs` is seeded above with the ROW's own
    // `project_id`, read from the record being written; an id-addressed update has no other
    // correct project, and it can never fall back to an ambient slot.
    const result = await McpService.callTool('task_update', toolArgs, actor);

    if (!result.success) {
      logger.error('Update task delegation failed', { id, error: result.error });
      throw new Error('Failed to update task');
    }

    // THE PUNCH LIST LANE (migration 101): same typed carry as
    // createTask — see the note there.
    if (result.data?.code === 'PUNCH_INCOMPLETE') {
      throw new PunchIncompleteRequestError(result.data.missing ?? []);
    }

    // An IN-BAND tool error (claim fence, ambiguous id, validation) arrives as HTTP 200 with
    // `structuredContent: { ok: false, … }` and NO `task` — see McpService.makeRequest. Treat
    // a missing applied-fields record as a failed write; never a phantom 200 over it.
    const applied = result.data?.task;
    if (!applied || !applied.id) {
      logger.error('Update task delegation returned no applied-fields payload', {
        id, data: result.data,
      });
      throw new Error('Failed to update task');
    }

    // Re-read: the tool reports what it APPLIED, not the resulting row, and the REST
    // contract here is the whole task.
    return TaskService.getTaskById(id);
  }

  /**
   * DELETE a task = SOFT-DELETE / ARCHIVE it.
   *
   * This used to be `DELETE FROM tasks WHERE id = $1` — the row was destroyed, with no
   * undo, while MCP `task_delete` on the SAME table only set `archived_at`. A UI delete
   * could therefore annihilate a record the MCP layer (and every typed edge pointing at
   * it) believed was merely archived. One table, one meaning: set `archived_at = now()`.
   *
   * IDEMPOTENT and non-destructive — deleting an already-archived task is a no-op that
   * reports `alreadyArchived: true` and leaves the ORIGINAL timestamp intact (a second
   * delete must not rewrite when it was deleted). Returns `found: false` only when no
   * such row exists at all, which is the caller's 404.
   *
   * NOT claim-fenced, unlike TasksHandler.archiveTask: claim fencing is an agent-
   * coordination concern on the MCP surface and there is no `force` override on this
   * HTTP route to escape it with. Named here so the difference is a decision on the
   * record rather than an omission — see the report for an earlier task.
   */
  static async deleteTask(id: string): Promise<TaskArchiveResult> {
    try {
      // task-write-path: raw-allowed — ARCHIVE, not a field edit. The tool that owns this
      // operation is `task_delete`, not `task_update`, and delegating it is a separate
      // change with its own claim-fencing decision (spelled out in the doc block above).
      // Named here so this statement is a stated exception rather than an unnoticed one.
      const updated = await pool.query(
        `UPDATE tasks SET archived_at = now()
         WHERE id = $1 AND archived_at IS NULL
         RETURNING archived_at`,
        [id]
      );
      if (updated.rows.length === 1) {
        return { found: true, alreadyArchived: false, archivedAt: updated.rows[0].archived_at };
      }
      // Nothing updated → either already archived, or not there at all. Those are very
      // different answers (200 vs 404), so probe rather than collapsing them.
      const probe = await pool.query('SELECT archived_at FROM tasks WHERE id = $1', [id]);
      if (probe.rows.length === 0) {
        return { found: false, alreadyArchived: false, archivedAt: null };
      }
      return { found: true, alreadyArchived: true, archivedAt: probe.rows[0].archived_at };
    } catch (error) {
      logger.error('Delete task error', { error });
      throw new Error('Failed to delete task');
    }
  }

  /**
   * RESTORE (un-archive) a task — the undo that a hard delete could never offer
   *. Clears `archived_at` back to NULL, so the row returns to the
   * default list/board/counts. Mirror of deleteTask: idempotent (restoring a live task
   * reports `alreadyArchived: false` and changes nothing), `found: false` → 404.
   *
   * Deliberately does NOT touch `status`: archive and lifecycle status are orthogonal,
   * so a cancelled task restores as cancelled, exactly as it was left.
   *
   * CLAIM AWARENESS — clears the atomic-claim lease, matching
   * mcp-server/src/handlers/tasks.ts restoreTask (SPEC §6.8). A task coming
   * back from the archive must NOT carry a stale lease: whoever held it moved on, and a
   * resurrected claim fences the very people restoring the task — every subsequent MCP
   * `task_update` is refused until the lease expires. This is LIVE, not theoretical:
   * `MANDREL_TASK_CLAIM_ENABLED=true` in prod, while the CODE default is `false`, which is
   * exactly what makes the omission easy to miss.
   *
   * Cleared UNCONDITIONALLY rather than behind a re-read of the claim flag. The flag lives
   * in mcp-server's TASK_CLAIM_CONFIG, which this package cannot import, and a second copy
   * of a config value is the drift this whole task is about. When claims are disabled these
   * columns are already NULL, so the write is a no-op; when they are enabled it matches MCP.
   * The one divergence is deliberate and safe: if claims were enabled and later turned off,
   * MCP would leave a dead lease behind and we clear it — clearing a lease nothing can
   * enforce cannot harm a caller.
   *
   * The column list is pinned to MCP's by a static reconcile assertion in
   * taskSoftDelete.db.test.ts, so adding a claim column on one side and not the other is RED.
   */
  static async restoreTask(id: string): Promise<TaskArchiveResult> {
    try {
      // task-write-path: raw-allowed — UN-ARCHIVE, not a field edit; the mirror of
      // deleteTask above. Owned by `task_restore` on the MCP side, not `task_update`.
      const updated = await pool.query(
        `UPDATE tasks
            SET archived_at = NULL,
                claim_id = NULL,
                claim_actor = NULL,
                claim_expires_at = NULL
         WHERE id = $1 AND archived_at IS NOT NULL
         RETURNING id`,
        [id]
      );
      if (updated.rows.length === 1) {
        return { found: true, alreadyArchived: false, archivedAt: null };
      }
      const probe = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
      if (probe.rows.length === 0) {
        return { found: false, alreadyArchived: false, archivedAt: null };
      }
      // Present and already live — nothing to restore. `alreadyArchived: false` reads as
      // "it is not archived", which is the true end-state either way.
      return { found: true, alreadyArchived: false, archivedAt: null };
    } catch (error) {
      logger.error('Restore task error', { error });
      throw new Error('Failed to restore task');
    }
  }

  /**
   * Get task statistics.
   *
   * ARCHIVE-AWARE: every count here is over LIVE rows only
   * (`archived_at IS NULL`). Without this, making Delete a soft-delete would have been
   * a visible regression — you delete a task, it leaves the board, and the progress bar
   * keeps counting it forever. `archived` is reported SEPARATELY so the Archived view's
   * chip has a real count instead of a hardcoded or client-derived one; it is NOT part
   * of `total` and therefore never moves `completion_rate`.
   */
  static async getTaskStats(
    scope: ProjectListScope,
    rangeDays: number | null = null,
  ): Promise<TaskStats> {
    try {
      let baseQuery = 'FROM tasks WHERE archived_at IS NULL';
      let archivedQuery = 'FROM tasks WHERE archived_at IS NOT NULL';
      const params: any[] = [];

      const scopeClause = scopePredicate(scope, 'project_id', params);
      baseQuery += scopeClause;
      archivedQuery += scopeClause;

      // ── THE WINDOW (item 4) ──────────────────────────────────────────
      // This read had no date predicate, so the Analytics "Work mix" panel answered ALL
      // TIME under a 7d/30d/90d control that did not even re-fetch it. Measured on prod
      // 2026-08-10: all-time it renders 2772 completed of 3121 live non-cancelled tasks
      // (88.8% Done, and unmoving); the same question asked over 30 days is 268 of 383
      // (70.0%); on the 7d view it drew 3121 rows against a real 7-day population of 61.
      //
      // CREATED, not TOUCHED. `created_at` fixes each task in exactly one cohort for
      // good: "of the work we took on in this window, where does it stand now". An
      // `updated_at` window would answer "tasks that moved", whose membership changes
      // when someone edits a description, and where the same task can appear in the 7d
      // and 30d views in different states. It is also the same verb the KPI tile on this
      // page already counts ("Tasks created"), so the two panels share one definition.
      // The window is BOUND via make_interval, matching getLeadTimeDistribution below.
      //
      // `null` = unbounded, and is the default: every OTHER caller of this method (the
      // Tasks board's progress counts) asks an all-time question and must not silently
      // acquire a window.
      if (rangeDays !== null) {
        params.push(rangeDays);
        const windowClause = ` AND created_at >= NOW() - make_interval(days => $${params.length})`;
        baseQuery += windowClause;
        archivedQuery += windowClause;
      }

      const [totalResult, statusResult, priorityResult, typeResult, archivedResult] = await Promise.all([
        pool.query(`SELECT COUNT(*) as total ${baseQuery}`, params),
        pool.query(`SELECT status, COUNT(*) as count ${baseQuery} GROUP BY status`, params),
        pool.query(`SELECT priority, COUNT(*) as count ${baseQuery} GROUP BY priority`, params),
        pool.query(`SELECT type, COUNT(*) as count ${baseQuery} GROUP BY type`, params),
        pool.query(`SELECT COUNT(*) as total ${archivedQuery}`, params)
      ]);

      const total = parseInt(totalResult.rows[0].total);
      const archived = parseInt(archivedResult.rows[0].total);
      const by_status: Record<string, number> = {};
      const by_priority: Record<string, number> = {};
      const by_type: Record<string, number> = {};

      statusResult.rows.forEach((row: any) => {
        by_status[row.status] = parseInt(row.count);
      });

      priorityResult.rows.forEach((row: any) => {
        by_priority[row.priority] = parseInt(row.count);
      });

      typeResult.rows.forEach((row: any) => {
        by_type[row.type] = parseInt(row.count);
      });

      const completed = by_status.completed || 0;
      const completion_rate = total > 0 ? (completed / total) * 100 : 0;

      return {
        total,
        by_status,
        by_priority,
        by_type,
        completion_rate: Math.round(completion_rate * 100) / 100,
        archived
      };
    } catch (error) {
      logger.error('Get task stats error', { error });
      throw new Error('Failed to get task statistics');
    }
  }

  /**
   * Get the TYPED GRAPH EDGES touching a task (the TreeWalker "build story" moat).
   *
   * Reads the real `links` table (migration 049) — BOTH directions: outgoing
   * (from_id = :id) and incoming (to_id = :id). Each edge is resolved to its OTHER
   * endpoint's display fields by joining the endpoint's own table (contexts /
   * technical_decisions / tasks) on the id + kind. This is STRUCTURE, not the task's
   * `dependencies` array and not any semantic list — it must never be confused with
   * either. Mirrors ContextService.getContextLinks exactly.
   *
   * Scope: a task id is globally unique, so — like getTaskById (a by-id sub-resource)
   * — this returns the record's real edges without an extra project filter;
   * over-filtering would silently hide legitimate edges whose stored `links.project_id`
   * is null (pre-project-scoping) or set to the endpoint's project.
   */
  static async getTaskLinks(taskId: string): Promise<TaskLink[]> {
    // Delegates to the ONE canonical typed-edge resolver (LinkService.getLinksForRecord).
    // The query keys only on the id, so a task id works unchanged; keeping this public
    // method + its route means nothing upstream changes. See services/links.ts (    // one resolver, not three copies).
    return LinkService.getLinksForRecord(taskId);
  }

  /**
   * Get lead time distribution analytics.
   *
   * ARCHIVE-AWARE. This read used to filter only
   * `status='completed' AND completed_at IS NOT NULL AND created_at IS NOT NULL`,
   * while `getTaskStats` above already excluded archived rows. The Analytics "Work mix"
   * panel draws both: Created/day and Open now came from the archive-aware read,
   * Completed/day and Median time to done from this one. Two halves of one panel, cut
   * on two populations, disagreeing silently the moment anyone archives a completed
   * task. The panel must be able to state ONE population, so this read joins the other.
   */
  static async getLeadTimeDistribution(
    scope: ProjectListScope,
    rangeDays: number | null = null,
  ): Promise<{
    distribution: Array<{ leadTimeDays: number; count: number }>;
    stats: {
      totalTasks: number;
      averageLeadTime: number;
      medianLeadTime: number;
      p90LeadTime: number;
    }
  }> {
    try {
      let baseQuery = `
        SELECT
          EXTRACT(EPOCH FROM (completed_at - created_at)) / 86400 as lead_time_days,
          title,
          type,
          priority
        FROM tasks
        WHERE archived_at IS NULL
          AND status = 'completed'
          AND completed_at IS NOT NULL
          AND created_at IS NOT NULL
      `;
      const params: any[] = [];

      baseQuery += scopePredicate(scope, 'project_id', params);

      // RANGE-AWARE (Analytics 7d/30d/90d selector): filter completed tasks by
      // `completed_at` within the trailing window. `rangeDays === null` = "All" (no
      // window — the pre-range behaviour). `make_interval(days => $n)` keeps the window
      // fully parameterized (no interpolated literal).
      if (rangeDays !== null) {
        params.push(rangeDays);
        baseQuery += ` AND completed_at >= NOW() - make_interval(days => $${params.length})`;
      }

      baseQuery += ' ORDER BY lead_time_days';

      const result = await pool.query(baseQuery, params);
      const leadTimes = result.rows.map(row => parseFloat(row.lead_time_days));
      
      if (leadTimes.length === 0) {
        return {
          distribution: [],
          stats: {
            totalTasks: 0,
            averageLeadTime: 0,
            medianLeadTime: 0,
            p90LeadTime: 0
          }
        };
      }

      // Create distribution buckets (0-1 day, 1-2 days, 2-7 days, 1-2 weeks, 2+ weeks)
      const buckets = [
        { range: [0, 1], label: '< 1 day' },
        { range: [1, 2], label: '1-2 days' },
        { range: [2, 7], label: '2-7 days' },
        { range: [7, 14], label: '1-2 weeks' },
        { range: [14, Infinity], label: '2+ weeks' }
      ];

      const distribution = buckets.map(bucket => ({
        leadTimeDays: bucket.range[1] === Infinity ? 21 : bucket.range[1], // Use 21 for display of "2+ weeks"
        count: leadTimes.filter(lt => lt >= bucket.range[0] && lt < bucket.range[1]).length,
        label: bucket.label
      }));

      // Calculate statistics
      const totalTasks = leadTimes.length;
      const averageLeadTime = leadTimes.reduce((sum, lt) => sum + lt, 0) / totalTasks;
      const medianLeadTime = leadTimes[Math.floor(totalTasks / 2)];
      const p90Index = Math.floor(totalTasks * 0.9);
      const p90LeadTime = leadTimes[p90Index];

      return {
        distribution,
        stats: {
          totalTasks,
          averageLeadTime: Math.round(averageLeadTime * 10) / 10,
          medianLeadTime: Math.round(medianLeadTime * 10) / 10,
          p90LeadTime: Math.round(p90LeadTime * 10) / 10
        }
      };
    } catch (error) {
      logger.error('Get lead time distribution error', { error });
      throw new Error('Failed to get lead time distribution');
    }
  }

  /**
   * Per-day THROUGHPUT series (the Analytics "Throughput vs created" trend). Returns one
   * point per day across the selected window with the REAL count of tasks COMPLETED that
   * day (by `completed_at`) and CREATED that day (by `created_at`), zero-filled so the
   * chart is continuous. Scoped by `project_id` like the other task reads.
   *
   * Window: `rangeDays` (7/30/90) is a trailing window ending today; `null` = "All" —
   * the window then starts at the earliest task date for the scope. Days with no activity
   * read 0 (real zeros, not gaps).
   *
   * HONEST EMPTY (policy 10397f65): we return `[]` (→ the panel's "not yet available"
   * state) only when there is ZERO task ACTIVITY of either kind — no created AND no
   * completed — in the window. The chart plots BOTH a completed/day and a created/day
   * line, so a window with created-but-not-yet-completed tasks is real activity and lights
   * up (the created line shows, completed reads 0). Emptiness = nothing happened, not
   * "nothing completed".
   */
  static async getThroughputSeries(
    scope: ProjectListScope,
    rangeDays: number | null = null,
    tz: string = DEFAULT_AGG_TIMEZONE,
  ): Promise<Array<{ day: string; completed: number; created: number }>> {
    try {
      // $1 projectId (nullable), $2 rangeDays (nullable), $3 tz. A NULL project param
      // means "all projects" (unscoped); a NULL rangeDays means the "All" window.
      // Per-day buckets AND the trailing window are computed in the VIEWER's tz (an earlier task
      // — whole-class per-day-in-UTC bug): a task completed at 8pm-EDT
      // (00:00Z next day) lands on its LOCAL calendar day, not the UTC one. tz is a
      // validated IANA zone bound as $3 (never interpolated); UTC reproduces the old
      // `date_trunc('day', x)` bucketing exactly (regression guard).
      //
      // ARCHIVE-AWARE (sibling of getLeadTimeDistribution). All three CTEs
      // exclude archived rows: `b` (which fixes the chart's left edge from the oldest
      // task), `comp` and `crea`. `services/dailySeries.ts` computes the same
      // tasks-done / tasks-opened-per-day pair and already carried `t.archived_at IS NULL`
      // on both — this read is the copy that drifted.
      const query = `
        WITH tz AS (
          SELECT (now() AT TIME ZONE $3)::date AS local_today
        ),
        b AS (
          SELECT CASE
            WHEN $2::int IS NULL THEN
              (SELECT (MIN(LEAST(t.created_at, COALESCE(t.completed_at, t.created_at))) AT TIME ZONE $3)::date
                 FROM tasks t
                 WHERE t.archived_at IS NULL
                   AND ($4::boolean OR t.project_id = ANY($1::uuid[])))
            ELSE ((SELECT local_today FROM tz) - make_interval(days => $2::int - 1))::date
          END AS start_day
        ),
        days AS (
          SELECT generate_series((SELECT start_day FROM b), (SELECT local_today FROM tz), interval '1 day')::date AS day
        ),
        comp AS (
          SELECT (t.completed_at AT TIME ZONE $3)::date AS day, COUNT(*) AS n
          FROM tasks t
          WHERE t.archived_at IS NULL
            AND t.completed_at IS NOT NULL AND t.status = 'completed'
            AND ($4::boolean OR t.project_id = ANY($1::uuid[]))
            AND (t.completed_at AT TIME ZONE $3)::date >= (SELECT start_day FROM b)
          GROUP BY 1
        ),
        crea AS (
          SELECT (t.created_at AT TIME ZONE $3)::date AS day, COUNT(*) AS n
          FROM tasks t
          WHERE t.archived_at IS NULL
            AND t.created_at IS NOT NULL
            AND ($4::boolean OR t.project_id = ANY($1::uuid[]))
            AND (t.created_at AT TIME ZONE $3)::date >= (SELECT start_day FROM b)
          GROUP BY 1
        )
        SELECT
          to_char(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(comp.n, 0)::int AS completed,
          COALESCE(crea.n, 0)::int AS created
        FROM days d
        LEFT JOIN comp ON comp.day = d.day
        LEFT JOIN crea ON crea.day = d.day
        ORDER BY d.day
      `;
      // $1 is ALWAYS a uuid[] and $4 says whether to ignore it. The old shape was
      // `$1::uuid IS NULL OR t.project_id = $1` — a NULL project meaning "every project",
      // which is the defect in SQL form: the unrestricted mode was reachable by passing
      // nothing. It is now the explicit boolean below, and an EMPTY array is genuinely
      // empty rather than unrestricted.
      const unrestricted = scope.mode === ALL_PROJECTS;
      const result = await pool.query(query, [
        unrestricted ? [] : [...scope.projectIds],
        rangeDays,
        tz,
        unrestricted,
      ]);

      const series = result.rows.map((row: any) => ({
        day: row.day as string,
        completed: parseInt(row.completed, 10),
        created: parseInt(row.created, 10),
      }));

      // Honest empty: only when there is ZERO activity of either kind in the window (no
      // created AND no completed) → [] (drives the panel's empty state). A window with
      // created-but-not-completed tasks is real activity and lights up the created line.
      const totalActivity = series.reduce((sum, p) => sum + p.completed + p.created, 0);
      if (totalActivity === 0) {
        return [];
      }

      return series;
    } catch (error) {
      logger.error('Get throughput series error', { error });
      throw new Error('Failed to get throughput series');
    }
  }

  /**
   * COMPLETED-BY-ACTOR breakdown (the Analytics "Completed by actor" bars). Counts tasks
   * COMPLETED within the selected window, grouped by their `assigned_to` (the actor
   * dimension already stored + serialized on the task record). Scoped by `project_id`.
   *
   * WHY a backend aggregation (not FE-derived): the board's loaded rows are (a) bounded by
   * the list `limit` and (b) NOT filtered by completion date, and the list payload does not
   * carry `completed_at`, so a window-accurate "completed in the last N days by actor" count
   * CANNOT be derived on the client without lying. This mirrors how Sessions serve their
   * by-actor panels (an earlier task / sessionAnalytics.ts) — a real GROUP BY, not a client
   * guess. Tasks with no assignee are a REAL `unassigned` bucket (honest, not fabricated).
   *
   * `rangeDays === null` = "All" (no completion window). Honest empty `[]` when nothing
   * completed in the window.
   */
  static async getCompletedByActor(
    scope: ProjectListScope,
    rangeDays: number | null = null,
  ): Promise<Array<{ actor: string; count: number }>> {
    try {
      let query = `
        SELECT COALESCE(NULLIF(TRIM(t.assigned_to), ''), 'unassigned') AS actor,
               COUNT(*)::int AS count
        FROM tasks t
        WHERE t.archived_at IS NULL
          AND t.status = 'completed' AND t.completed_at IS NOT NULL
      `;
      const params: any[] = [];

      query += scopePredicate(scope, 't.project_id', params);

      if (rangeDays !== null) {
        params.push(rangeDays);
        query += ` AND t.completed_at >= NOW() - make_interval(days => $${params.length})`;
      }

      query += ` GROUP BY 1 ORDER BY count DESC, actor ASC`;

      const result = await pool.query(query, params);
      return result.rows.map((row: any) => ({
        actor: row.actor as string,
        count: parseInt(row.count, 10),
      }));
    } catch (error) {
      logger.error('Get completed-by-actor error', { error });
      throw new Error('Failed to get completed-by-actor breakdown');
    }
  }

  /**
   * Assignee SUGGESTIONS for a project — the union of the built-in principal registry,
   * the actors that have actually held a session here, and the assignees already in use
   * on this project's tasks (Phase 1).
   *
   * ── THIS IS A SUGGESTION SOURCE, NOT A WHITELIST ──────────────────────────────────
   * `tasks.assigned_to` is free-form varchar and STAYS free-form. Nothing in this path
   * validates or rejects an assignee. Its only job is to make the canonical spelling the
   * path of least resistance at the write surface, so `builder` / `the builder` /
   * `builder (P3 Insight)` stop being three buckets for one actor.
   *
   * ── SECURITY ──────────────────────────────────────────────────────────────────────
   * Both halves take the SAME `scopePredicate(scope, …)` every other multi-row read on
   * this service takes; the scope is a REQUIRED argument with no default, so an
   * every-project read is unreachable by omission. `sessions.project_id` is NULLABLE and
   * `= ANY($n::uuid[])` never matches NULL, so a project-less session cannot leak into a
   * project-scoped answer.
   *
   * The built-in half is NOT project data — it is the same static first-party roster for
   * every project — so it is added regardless of scope, with zero counts when unused.
   *
   * Case-insensitive merge, and the canonical label, are decided in `mergeActorOptions`.
   */
  static async getActorOptions(scope: ProjectListScope): Promise<ActorOption[]> {
    try {
      // ONE params array for ONE query: the two scopePredicate calls append to it in
      // order and mint $1 / $2 of the SAME statement. Splitting this into two statements
      // sharing one array is how a scope param silently binds to the wrong placeholder.
      const params: unknown[] = [];

      // Assignees already in use. Archived tasks excluded — they are deleted rows, and
      // suggesting an assignee that survives only on a deleted task is noise.
      let query = `
        SELECT 'task' AS src,
               LOWER(BTRIM(t.assigned_to)) AS key,
               BTRIM(t.assigned_to) AS label,
               COUNT(*)::int AS n
        FROM tasks t
        WHERE t.archived_at IS NULL
          AND BTRIM(COALESCE(t.assigned_to, '')) <> ''
      `;
      query += scopePredicate(scope, 't.project_id', params);
      query += ` GROUP BY 1, 2, 3
        UNION ALL
        SELECT 'session' AS src,
               LOWER(BTRIM(s.actor)) AS key,
               BTRIM(s.actor) AS label,
               COUNT(*)::int AS n
        FROM sessions s
        WHERE BTRIM(COALESCE(s.actor, '')) <> ''
      `;
      query += scopePredicate(scope, 's.project_id', params);
      query += ' GROUP BY 1, 2, 3';

      const result = await pool.query(query, params);
      const rows = result.rows as Array<{ src: string; key: string; label: string; n: number }>;

      return mergeActorOptions(
        rows.filter((r) => r.src === 'task').map((r) => ({ key: r.key, label: r.label, n: Number(r.n) })),
        rows.filter((r) => r.src === 'session').map((r) => ({ key: r.key, label: r.label, n: Number(r.n) })),
      );
    } catch (error) {
      logger.error('Get actor options error', { error });
      throw new Error('Failed to get actor options');
    }
  }

  /**
   * Get task dependencies (what this task depends on and what depends on it)
   */
  static async getTaskDependencies(taskId: string): Promise<{
    dependencies: TaskDependency[];
    dependents: TaskDependency[];
  }> {
    try {
      // Get tasks that this task depends on
      const dependenciesResult = await pool.query(`
        SELECT id, title, status
        FROM tasks 
        WHERE id = ANY(
          SELECT unnest(dependencies) FROM tasks WHERE id = $1
        )
      `, [taskId]);

      // Get tasks that depend on this task
      const dependentsResult = await pool.query(`
        SELECT id, title, status, dependencies
        FROM tasks 
        WHERE $1 = ANY(dependencies)
      `, [taskId]);

      const dependencies: TaskDependency[] = dependenciesResult.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        blocking_tasks: []
      }));

      const dependents: TaskDependency[] = dependentsResult.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        blocking_tasks: row.dependencies
      }));

      return { dependencies, dependents };
    } catch (error) {
      logger.error('Get task dependencies error', { error });
      throw new Error('Failed to get task dependencies');
    }
  }

  /**
   * Bulk update task status (the Kanban board's drag-and-drop) — DELEGATES to the
   * mcp-server `task_bulk_update` tool.
   *
   * TRANSACTIONALITY — DELIBERATE, AND IT CHANGED. The old raw path wrapped N single-row
   * `UPDATE`s in ONE `BEGIN`/`COMMIT`, so any error rolled every row back. A delegated
   * write cannot be enrolled in this process's transaction, so that guarantee is not
   * available and pretending otherwise would be the lie. What replaces it:
   *
   *   - the ids are grouped by (project_id, target status) and each group is ONE
   *     `task_bulk_update` call, which the tool applies as a single atomic
   *     `UPDATE ... WHERE id = ANY($n)`. So a group is still all-or-nothing;
   *   - the COMMON CASE — a card, or a multi-select, dragged to one column of one board —
   *     is exactly one group, i.e. the same atomicity as before;
   *   - ACROSS groups it is best-effort with PER-ITEM OUTCOMES. A failed group does not
   *     roll back a succeeded one, and it is never silently dropped: it is returned in
   *     `skipped` with the reason, alongside the rows that did land.
   *
   * WHAT A CALLER SEES ON PARTIAL FAILURE. The two extremes are unchanged: everything
   * succeeded means the same 200 with the same rows; NOTHING succeeded and something
   * errored means the same thrown `Failed to bulk update task statuses` and the same 500.
   * Only the mixed case is new, and it is reported rather than hidden: 200, the rows that
   * moved, plus a `skipped` entry per id that did not. The controller surfaces it; see
   * TaskController.bulkUpdateTasks.
   *
   * IDS THAT DO NOT EXIST are still skipped rather than failing the batch (the raw path's
   * `WHERE id = $2` simply matched no row) — now reported instead of invisible. They are
   * removed by the pre-read below, BEFORE grouping, which also keeps the tool's own
   * "an unresolvable id aborts the whole bulk" rule from turning one stale board card into
   * a failed drag for every other card in the same column.
   *
   * @param actor the logged-in principal, forwarded as X-Actor-ID. The tool uses it for the
   *   assignee TRANSITION STAMP — dragging a card to Done IS how a task completes in this
   *   UI, so this is the site where losing the doer mattered most.
   */
  static async bulkUpdateStatus(
    updates: Array<{ id: string; status: string }>,
    scope: ProjectListScope,
    actor?: string
  ): Promise<BulkStatusUpdateResult> {
    if (updates.length === 0) {
      return { tasks: [], skipped: [] };
    }

    const skipped: BulkStatusSkip[] = [];

    // PRE-READ — the delegated call needs a project to scope to, and only the rows
    // themselves can say which. Doubles as the existence check (see the doc above).
    const known = new Map<string, string>(); // task id -> project_id
    try {
      const rows = await pool.query(
        'SELECT id, project_id FROM tasks WHERE id = ANY($1::uuid[])',
        [updates.map((u) => u.id)]
      );
      for (const row of rows.rows) known.set(row.id, row.project_id);
    } catch (error) {
      logger.error('Bulk update status pre-read failed', { error });
      throw new Error('Failed to bulk update task statuses');
    }

    // Group by (project_id, status). Insertion order is request order.
    const groups = new Map<string, { projectId: string; status: string; ids: string[] }>();
    for (const update of updates) {
      const projectId = known.get(update.id);
      // One reason for "unknown" and "not yours": distinguishing them is an existence oracle
      // for foreign ids, and contexts/move already collapse the two.
      if (projectId === undefined) {
        skipped.push({ id: update.id, reason: 'not found in the caller\'s project scope' });
        continue;
      }
      // CALLER SCOPE (REALIGN step 9). The row's own project is what the
      // delegated call is scoped TO; it says nothing about whether THIS caller may touch it.
      // Before this check any session could move any task on the box by id.
      if (!scopeAllows(scope, projectId)) {
        skipped.push({ id: update.id, reason: 'not found in the caller\'s project scope' });
        continue;
      }
      const key = `${projectId} ${update.status}`;
      const group = groups.get(key);
      if (group) group.ids.push(update.id);
      else groups.set(key, { projectId, status: update.status, ids: [update.id] });
    }

    const updatedIds = new Set<string>();
    let anyGroupErrored = false;

    for (const group of groups.values()) {
      // mcp-write-scope: self-scoped — `projectId` is the project the rows in this group
      // actually belong to, read from the rows above; the group key IS the project, so a
      // batch spanning projects becomes several correctly-scoped calls, never one ambient one.
      const result = await McpService.callTool(
        'task_bulk_update',
        { projectId: group.projectId, task_ids: group.ids, status: group.status },
        actor
      );

      // A transport/auth refusal (success:false) and an in-band tool error (200 with
      // `structuredContent.ok === false`) are the SAME outcome for the caller — nothing in
      // this group was written — and both must be reported, never counted as applied.
      const failure = !result.success
        ? (result.error ?? 'delegated bulk update failed')
        : result.data?.ok === false
          ? (result.data?.error ?? 'the task_bulk_update tool rejected this group')
          : null;
      if (failure !== null) {
        anyGroupErrored = true;
        logger.error('Bulk update status delegation failed for a group', {
          projectId: group.projectId, status: group.status, ids: group.ids, error: failure,
        });
        for (const id of group.ids) skipped.push({ id, reason: failure });
        continue;
      }

      // The tool reports exactly which rows it updated. Rows it declined (a live claim it
      // will not stomp) come back in `errors` — read the ids it CONFIRMED, never assume the
      // requested set was applied.
      const confirmed: string[] = Array.isArray(result.data?.updatedTaskIds)
        ? result.data.updatedTaskIds
        : [];
      for (const id of confirmed) updatedIds.add(id);
      for (const id of group.ids) {
        if (!updatedIds.has(id)) {
          skipped.push({
            id,
            reason: (result.data?.errors ?? []).join('; ') || 'not updated by task_bulk_update',
          });
        }
      }
    }

    // TOTAL FAILURE keeps the old shape: throw, and the controller's existing 500.
    if (updatedIds.size === 0 && anyGroupErrored) {
      throw new Error('Failed to bulk update task statuses');
    }

    if (updatedIds.size === 0) {
      return { tasks: [], skipped };
    }

    // Re-read the rows that moved. `task_bulk_update` returns ids, not records, and the
    // REST response is the records — the same columns the old `RETURNING *` produced.
    try {
      const rows = await pool.query('SELECT * FROM tasks WHERE id = ANY($1::uuid[])', [
        [...updatedIds],
      ]);
      const byId = new Map<string, Task>(rows.rows.map((row: Task) => [row.id, row]));
      // Request order, not database order — the caller listed them for a reason.
      const tasks: Task[] = [];
      for (const update of updates) {
        const row = byId.get(update.id);
        if (row) { tasks.push(row); byId.delete(update.id); }
      }
      return { tasks, skipped };
    } catch (error) {
      logger.error('Bulk update status read-back failed', { error });
      throw new Error('Failed to bulk update task statuses');
    }
  }

  /**
   * Bulk move tasks to a different project
   */
  /**
   * Move tasks to another project — DELEGATES per task to the mcp-server
   * `project_move_record` tool (Punch fix round 1, the reviewer finding 2 sibling).
   *
   * THE CLASS (same as updateTask above): this used to be a raw `UPDATE tasks SET project_id`,
   * which moved the task row and NOTHING that carries a denormalized copy of its project_id —
   * task_attachments (the column every attachment read/delete is authorized by), the claim
   * event log, branch memberships. A bulk-moved task's images stayed filed under the
   * old project: a stale grant for its users and a 403 for the new project's. The tool owns the
   * declared satellite registry (mcp-server config/reprojectConfig.ts, guarded by
   * reprojectSatelliteCoverage) and the edge policy; a second copy here would drift again.
   *
   * PROJECT-SCOPED (REALIGN step 9). `project_id` is the DESTINATION,
   * authorized upstream as a scope candidate; `scope` is the set of projects the caller may
   * move rows OUT OF, applied here BEFORE delegation so the tool is never asked to move a row
   * the caller may not reach. `skipped` = requested ids outside that scope or nonexistent (not
   * distinguished, on purpose — same as before). `errors` = in-scope ids the tool refused or
   * the transport could not deliver, each with its reason, the way bulkUpdateStatus reports.
   * `updated` counts 'moved' AND 'already_there' — the old UPDATE's rowCount counted a row
   * already sitting in the destination too.
   *
   * @param actor forwarded as X-Actor-ID, as every delegated write does.
   */
  static async bulkMoveToProject(
    ids: string[],
    project_id: string,
    scope: ProjectListScope,
    actor?: string
  ): Promise<{ updated: number; skipped: string[]; errors: Array<{ id: string; reason: string }> }> {
    if (ids.length === 0) {
      return { updated: 0, skipped: [], errors: [] };
    }

    try {
      // Verify target project exists — kept ahead of delegation so a bad destination is one
      // refusal, not N identical tool errors.
      const projectCheck = await pool.query(
        'SELECT id FROM projects WHERE id = $1',
        [project_id]
      );

      if (projectCheck.rows.length === 0) {
        throw new Error('Target project not found');
      }

      const params: unknown[] = [ids];
      const rows = await pool.query(
        `SELECT id FROM tasks WHERE id = ANY($1::uuid[])` + scopePredicate(scope, 'project_id', params),
        params
      );
      const inScope: string[] = rows.rows.map((r: { id: string }) => r.id);
      const inScopeSet = new Set(inScope);
      const skipped = [...new Set(ids)].filter((id) => !inScopeSet.has(id));

      const errors: Array<{ id: string; reason: string }> = [];
      let updated = 0;
      for (const id of inScope) {
        // mcp-write-scope: self-scoped — `toProject` names the destination explicitly, which
        // the mcp-server's caller-identity guard accepts as the call's project target
        // (projectBinding.ts PROJECT_PARAM_EXEMPTIONS: 'project_move_record.toProject').
        const result = await McpService.callTool(
          'project_move_record',
          { recordType: 'task', recordId: id, toProject: project_id },
          actor
        );
        // Transport refusal (success:false) and in-band tool error (ok:false) are the same
        // outcome for the caller: this row did not move. Report, never count.
        const failure = !result.success
          ? (result.error ?? 'delegated move failed')
          : result.data?.ok === false
            ? (result.data?.error ?? 'the project_move_record tool rejected this task')
            : null;
        if (failure !== null) {
          logger.error('Bulk move delegation failed for a task', { id, project_id, error: failure });
          errors.push({ id, reason: failure });
          continue;
        }
        updated += 1;
      }

      // TOTAL FAILURE keeps the old shape: throw, and the controller's existing 500.
      if (updated === 0 && errors.length > 0) {
        throw new Error('Failed to bulk move tasks');
      }

      return { updated, skipped, errors };
    } catch (error) {
      logger.error('Bulk move tasks error', { error });
      throw new Error('Failed to bulk move tasks');
    }
  }
}
