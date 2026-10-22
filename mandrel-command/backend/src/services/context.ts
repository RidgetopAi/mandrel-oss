import { db as pool } from '../database/connection';
import {
  scopePredicate,
  type ProjectListScope,
} from './projectListScope';
import { logger } from '../config/logger';
import { LinkService } from './links';

/*
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SINGLE-ENGINE RULE (search consolidation):                │
 * │   ALL matching/ranking for contexts lives in the mcp-server engine       │
 * │   (contextHandler.searchContext). This backend service may ONLY filter    │
 * │   by STRUCTURED COLUMNS (project/type/exact-tags/session/date) and must    │
 * │   NEVER match text. A free-text `query` is handled by the controller as   │
 * │   a THIN PROXY to the engine — it never reaches this browse listing.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { activeEmbeddingColumn } from '../config/embeddingColumn';

export interface Context {
  id: string;
  project_id: string;
  project_name?: string;
  type: 'code' | 'decision' | 'error' | 'discussion' | 'planning' | 'completion';
  content: string;
  metadata?: Record<string, any>;
  tags?: string[];
  relevance_score?: number;
  session_id?: string;
  embedding?: number[];
  created_at: string;
  updated_at: string;
  /**
   * SOFT-DELETE marker. `null` = live; a timestamp = archived. Rides
   * along on the by-id read so the reader can offer Restore instead of Delete on an
   * archived record — the same shape `tasks` already uses (Task.archived_at).
   */
  archived_at?: string | null;
}

export interface ContextSearchParams {
  query?: string;
  /**
   * The projects these rows may come from — REQUIRED, no default (an earlier task item 7).
   * This was `project_id?: string`, and an absent value meant NO FILTER, i.e. every
   * project. The single-project spelling is gone on purpose: two ways to say "which
   * project" is how the two paths (browse SQL / canonical search) drifted apart.
   * services/contextSearchAdapter.ts derives its one required `projectId` from this.
   */
  scope: ProjectListScope;
  session_id?: string;
  type?: string;
  tags?: string[];
  /** UI-scale minimum similarity, 0–1 (the adapter ×100s it for the canonical engine). */
  min_similarity?: number;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
  sort_by?: 'created_at' | 'relevance' | 'updated_at';
  sort_order?: 'asc' | 'desc';
  /**
   * ARCHIVE SCOPE — mirrors TaskFilter's pair exactly, because two
   * spellings of "show me deleted things" on one product is how the two surfaces drifted
   * in the first place. Absent BOTH flags you get LIVE rows only (`archived_at IS NULL`),
   * which is what every existing caller means. `archived_only` is the explicit Archived
   * view (`IS NOT NULL`); `include_archived` is the both-worlds escape hatch (no archive
   * predicate at all). `archived_only` WINS if somehow both are set — the narrower,
   * explicit intent.
   */
  include_archived?: boolean;
  archived_only?: boolean;
}

export interface ContextStats {
  total_contexts: number;
  by_type: Record<string, number>;
  by_project: Record<string, number>;
  recent_contexts: number;
  total_projects: number;
  most_recent_timestamp?: string;
  /**
   * Count of SOFT-DELETED (archived) contexts in scope. Reported
   * ALONGSIDE, never inside, `total_contexts`/`by_type`/`by_project` — those count LIVE
   * rows only. Without this split, making Delete a soft delete would leave every deleted
   * context in the dashboard totals forever, and "I deleted it and the number did not
   * move" is indistinguishable from "the delete failed".
   */
  archived: number;
}

/**
 * One typed graph edge touching a context, resolved for display (the "thread box" /
 * TreeWalker moat surfaced on the reader). These are REAL rows from the `links` table
 * (the typed-edge graph, migration 049) — never semantic "related" results.
 *
 *  - `direction: 'outgoing'` — the edge is stored from THIS context → the other record
 *    (this context is `from_id`); read it forward (e.g. "decided by → <decision>").
 *  - `direction: 'incoming'` — the edge points AT this context (this context is
 *    `to_id`); the caller reads it with the reverse label.
 *  - `otherKind` is the target's kind for colour/label: a context's `context_type`
 *    (milestone / handoff / …), or the literal `'decision'` / `'task'`.
 *  - `otherTitle` is the target's human title: a decision/task `title`, or a context's
 *    first content line.
 */
export interface ContextLink {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherType: 'context' | 'decision' | 'task';
  otherTitle: string;
  otherKind: string;
}

/**
 * The archive scope of a multi-row context read.
 *
 *   absent both flags  → LIVE rows only (`archived_at IS NULL`) — the default every
 *                        existing caller already means.
 *   archived_only      → the Archived view (`archived_at IS NOT NULL`).
 *   include_archived   → no archive predicate at all.
 *
 * `archived_only` wins over `include_archived`: the narrower, explicit intent.
 */
export interface ArchiveScope {
  include_archived?: boolean;
  archived_only?: boolean;
}

/**
 * THE ONE SPELLING of the archive predicate for `contexts` (a past incident — one resolver,
 * not N copies drifting apart). Returns a fragment beginning with ` AND `, or `''` when
 * no predicate applies, so it composes onto any query that already has a WHERE.
 *
 * It takes the fully-qualified column from the caller because these queries alias
 * differently (`c.archived_at`, `c2.archived_at`, bare `archived_at`). That argument is
 * always a literal in this file, never caller input.
 *
 * WHY IT IS APPLIED FIRST at every call site: the predicate must sit ABOVE any
 * caller-supplied filter, so no future branch can be inserted between the WHERE and the
 * archive test and quietly widen it. Same rule as TaskService.getTasks.
 */
export function contextArchivePredicate(column: string, scope: ArchiveScope = {}): string {
  if (scope.archived_only) return ` AND ${column} IS NOT NULL`;
  if (scope.include_archived) return '';
  return ` AND ${column} IS NULL`;
}

/**
 * The outcome of a soft delete / restore on ONE context. Mirrors
 * TaskArchiveResult so both record kinds report the same three-way answer and the
 * controllers can keep 404 ("no such row, or not yours") distinguishable from
 * "already in that state" — collapsing those two into one boolean is how a delete that
 * silently did nothing reads as success.
 */
export interface ContextArchiveResult {
  /** The row exists AND is inside the caller's project scope. */
  found: boolean;
  /** The row was already in the requested end-state, so this call changed nothing. */
  alreadyArchived: boolean;
  /** The row's `archived_at` after the call: a timestamp when archived, null when live. */
  archivedAt: string | null;
}

export class ContextService {
  /**
   * Get context count for a project (Oracle Phase 2 dashboard requirement)
   * This provides the core count used in dashboard aggregation
   */
  static async count(scope: ProjectListScope): Promise<number> {
    try {
      const params: any[] = [];
      // LIVE rows only. This count feeds the dashboard; a soft-deleted
      // context must leave the total, or Delete looks like it did nothing.
      const query =
        'SELECT COUNT(*) FROM contexts WHERE archived_at IS NULL' +
        scopePredicate(scope, 'project_id', params);

      const result = await pool.query(query, params);
      const count = parseInt(result.rows[0].count);
      
      logger.info(`📊 ContextService.count - Scope: ${scope.mode}, Count: ${count}`);
      return count;
    } catch (error) {
      logger.error('Context count error', { error });
      throw new Error('Failed to get context count');
    }
  }

  /**
   * BROWSE listing (search consolidation).
   *
   * Structured-column filtering + real pagination ONLY — NO text/id/tag MATCHING.
   * Any free-text `query` is handled upstream by the controller as a thin proxy to
   * the one engine (contextHandler.searchContext) and never reaches here. This
   * method exists solely for the "no query" browse case: filter by
   * project/type/exact-tags/session/date, sort by a structured column, and paginate
   * with an honest COUNT(*) OVER() total.
   *
   * Excludes archived rows by DEFAULT (archived_at IS NULL) — fixes the prior
   * literal path that leaked soft-deleted contexts into the list.
   */
  static async searchContexts(params: ContextSearchParams): Promise<{
    contexts: Context[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      scope,
      session_id,
      type,
      tags,
      date_from,
      date_to,
      limit = 20,
      offset = 0,
      sort_by = 'created_at',
      sort_order = 'desc',
      include_archived,
      archived_only
    } = params;

    // SINGLE-ENGINE RULE: browse NEVER matches text. `params.query` is intentionally
    // ignored here — a query routes to the canonical engine in the controller.

    let sql = `
      SELECT
        c.id, c.project_id, c.context_type as type, c.content, c.metadata, c.tags,
        c.relevance_score, c.session_id, c.created_at, c.created_at as updated_at,
        p.name as project_name,
        COUNT(*) OVER() as total_count
      FROM contexts c
      LEFT JOIN projects p ON c.project_id = p.id
      WHERE 1=1${contextArchivePredicate('c.archived_at', { include_archived, archived_only })}
    `;

    const sqlParams: any[] = [];
    let paramIndex = 1;

    sql += scopePredicate(scope, 'c.project_id', sqlParams);
    paramIndex = sqlParams.length + 1;

    if (session_id) {
      sql += ` AND c.session_id = $${paramIndex++}`;
      sqlParams.push(session_id);
    }

    if (type) {
      sql += ` AND c.context_type = $${paramIndex++}`;
      sqlParams.push(type);
    }

    // Exact-tag chips (structured filter, NOT text matching): rows whose tags[]
    // overlap the requested set.
    if (tags && tags.length > 0) {
      sql += ` AND c.tags && $${paramIndex++}::text[]`;
      sqlParams.push(tags);
    }

    if (date_from) {
      sql += ` AND c.created_at >= $${paramIndex++}`;
      sqlParams.push(date_from);
    }

    if (date_to) {
      sql += ` AND c.created_at <= $${paramIndex++}`;
      sqlParams.push(date_to);
    }

    // Sorting (browse-only; search is relevance-ordered by the engine)
    let sortColumn = 'c.created_at'; // default
    if (sort_by === 'relevance') {
      sortColumn = 'c.relevance_score';
    } else if (sort_by === 'updated_at') {
      sortColumn = 'c.created_at'; // contexts table doesn't have updated_at
    } else if (sort_by === 'created_at') {
      sortColumn = 'c.created_at';
    }
    // TOTAL ORDER. Every sortColumn above is non-unique — `created_at`
    // ties for rows written in one batch, and `relevance_score` ties constantly (it is a
    // coarse bucket) — and this browse list is LIMIT/OFFSET paged on the very next line.
    // Two page requests are two independent sorts of the same tied block, so a partial
    // order can show one context twice and silently drop another. `c.id` is the primary
    // key: unique (making the composite total), STABLE under updates so a page boundary
    // cannot shift beneath a concurrent write (the reason the tiebreaker is a PK and never
    // `updated_at`), and already covered by the PK btree. The tiebreaker mirrors the
    // caller's sort_order so an ascending browse reads in a consistent direction; either
    // direction would be total, only determinism matters.
    sql += ` ORDER BY ${sortColumn} ${sort_order.toUpperCase()}, c.id ${sort_order.toUpperCase()}`;

    // Pagination
    sql += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    sqlParams.push(limit, offset);

    try {
      const result = await pool.query(sql, sqlParams);
      
      const contexts = result.rows.map(row => ({
        id: row.id,
        project_id: row.project_id,
        project_name: row.project_name,
        type: row.type,
        content: row.content,
        metadata: row.metadata,
        tags: row.tags,
        relevance_score: row.relevance_score,
        session_id: row.session_id,
        created_at: row.created_at,
        updated_at: row.updated_at
      }));

      const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;

      return {
        contexts,
        total,
        page: Math.floor(offset / limit) + 1,
        limit
      };
    } catch (error) {
      logger.error('Context search error', { error });
      throw new Error('Failed to search contexts');
    }
  }

  /**
   * Get single context by ID.
   *
   * DELIBERATELY NOT archive-filtered: an archived context must stay
   * reachable by id or Restore is unreachable — the reader is exactly where a user
   * discovers they need to un-delete, and a permalink to an archived context would 404
   * instead of explaining itself. `archived_at` rides along so the reader renders
   * Restore rather than Delete. The LIST is where archived rows are hidden; the DETAIL
   * is the undo path. Same split as TaskService.getTaskById.
   */
  static async getContextById(id: string): Promise<Context | null> {
    try {
      const result = await pool.query(`
        SELECT 
          c.id, c.project_id, c.context_type as type, c.content, c.metadata, c.tags,
          c.relevance_score, c.session_id, c.created_at, c.created_at as updated_at,
          c.archived_at,
          p.name as project_name
        FROM contexts c
        LEFT JOIN projects p ON c.project_id = p.id
        WHERE c.id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        project_id: row.project_id,
        project_name: row.project_name,
        type: row.type,
        content: row.content,
        metadata: row.metadata,
        tags: row.tags,
        relevance_score: row.relevance_score,
        session_id: row.session_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at ?? null
      };
    } catch (error) {
      logger.error('Get context error', { error });
      throw new Error('Failed to get context');
    }
  }

  /**
   * Update context
   */
  static async updateContext(id: string, updates: {
    content?: string;
    tags?: string[];
    metadata?: Record<string, any>;
    relevance_score?: number;
    project_id?: string;
  }): Promise<Context | null> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.content !== undefined) {
      setClauses.push(`content = $${paramIndex++}`);
      values.push(updates.content);
    }

    if (updates.tags !== undefined) {
      setClauses.push(`tags = $${paramIndex++}`);
      values.push(updates.tags);
    }

    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }

    if (updates.relevance_score !== undefined) {
      setClauses.push(`relevance_score = $${paramIndex++}`);
      values.push(updates.relevance_score);
    }

    if (updates.project_id !== undefined) {
      setClauses.push(`project_id = $${paramIndex++}`);
      values.push(updates.project_id);
    }

    if (setClauses.length === 0) {
      throw new Error('No updates provided');
    }

    // Note: contexts table doesn't have updated_at column
    values.push(id);

    try {
      const result = await pool.query(`
        UPDATE contexts
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING
          id, project_id, context_type as type, content, metadata, tags,
          relevance_score, session_id, created_at, created_at as updated_at
      `, values);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      logger.error('Update context error', { error });
      throw new Error('Failed to update context');
    }
  }

  /**
   * SOFT-DELETE (archive) ONE context — the Command UI's Delete.
   *
   * THE DEFECT THIS CLOSES. This ran `DELETE FROM contexts WHERE id = $1`. The row was
   * DESTROYED — unlistable, unrecoverable, and with it every typed edge pointing at it —
   * while the MCP surface on the SAME table (`context_delete` → ContextHandler
   * .archiveContext, handlers/context.ts) only ever set `archived_at`. Two delete
   * semantics on one table meant a Command UI delete could annihilate a record the MCP
   * layer believed was merely archived, and `context restore` — a live, advertised
   * gateway action — had nothing left to clear. The frontend's own comment claimed this
   * was already a soft delete. It was not.
   *
   * Both surfaces now set and clear the same column.
   *
   * IDEMPOTENT and non-destructive: deleting an already-archived context is a no-op that
   * does NOT rewrite the original `archived_at`, so the first delete's timestamp survives
   * a double-click.
   *
   * NOT project-scoped, unlike ContextHandler.archiveContext — deliberately, and it is
   * safe here for a reason that does NOT hold for the bulk path below: this route is
   * `router.param('id', authorizeIdParam)` on routes/contexts.ts, so the id is authorized
   * against the caller's grants during ROUTING, before this ever runs. The bulk route has
   * no such per-id authorization, which is why it takes an explicit scope.
   */
  static async deleteContext(id: string): Promise<ContextArchiveResult> {
    try {
      const updated = await pool.query(
        `UPDATE contexts SET archived_at = now()
         WHERE id = $1 AND archived_at IS NULL
         RETURNING archived_at`,
        [id]
      );
      if (updated.rowCount && updated.rowCount > 0) {
        return { found: true, alreadyArchived: false, archivedAt: updated.rows[0].archived_at };
      }

      // Nothing updated → either already archived, or not there at all. Those are very
      // different answers to the caller (409-ish vs 404) and must not be collapsed.
      const probe = await pool.query('SELECT archived_at FROM contexts WHERE id = $1', [id]);
      if (probe.rowCount === 0) {
        return { found: false, alreadyArchived: false, archivedAt: null };
      }
      return { found: true, alreadyArchived: true, archivedAt: probe.rows[0].archived_at };
    } catch (error) {
      logger.error('Delete context error', { error });
      throw new Error('Failed to delete context');
    }
  }

  /**
   * RESTORE (un-archive) ONE context — the undo for the soft delete above, and the thing
   * that makes the `context restore` action honest for records deleted through the UI
   *. Clears `archived_at` back to NULL so the row returns to the default
   * list, counts and export.
   *
   * Mirror of deleteContext: idempotent (restoring a live context reports
   * `alreadyArchived: false` — "it is not archived" is the true end-state either way),
   * and it distinguishes "no such row" from "already live".
   */
  static async restoreContext(id: string): Promise<ContextArchiveResult> {
    try {
      const updated = await pool.query(
        `UPDATE contexts SET archived_at = NULL
         WHERE id = $1 AND archived_at IS NOT NULL
         RETURNING id`,
        [id]
      );
      if (updated.rowCount && updated.rowCount > 0) {
        return { found: true, alreadyArchived: false, archivedAt: null };
      }

      const probe = await pool.query('SELECT id FROM contexts WHERE id = $1', [id]);
      if (probe.rowCount === 0) {
        return { found: false, alreadyArchived: false, archivedAt: null };
      }
      return { found: true, alreadyArchived: false, archivedAt: null };
    } catch (error) {
      logger.error('Restore context error', { error });
      throw new Error('Failed to restore context');
    }
  }

  /**
   * BULK SOFT-DELETE — the widest destructive path on the contexts
   * surface, and it had TWO holes, not one.
   *
   *   1. It hard-deleted: `DELETE FROM contexts WHERE id = ANY($1::uuid[])`.
   *   2. IT CROSSED PROJECTS. There was NO project predicate at all, while the MCP
   *      archive path on the same table is project-scoped (`WHERE id = $1 AND
   *      project_id = $2`). Any authenticated caller holding an id could destroy a row in
   *      a project they hold no grant on — the bulk route has no `router.param('id')`
   *      authorization to fall back on, because its ids arrive in the BODY.
   *
   * Both are closed here. `scope` is a REQUIRED parameter with no default, so a future
   * call site cannot reach the unscoped behaviour by omission — omitting it is a COMPILE
   * error (services/projectListScope.ts, the J3 shape). The EMPTY scope
   * (`{mode:'projects', projectIds: []}` — a caller with zero grants) is a first-class
   * value that correctly deletes NOTHING; it must never be special-cased into "no filter".
   *
   * `deleted` counts rows this call actually TRANSITIONED live → archived. Ids that were
   * already archived, do not exist, or lie outside `scope` are all excluded, so the number
   * the UI shows is the number of things that changed.
   */
  static async bulkDeleteContexts(
    ids: string[],
    scope: ProjectListScope
  ): Promise<{ deleted: number }> {
    if (ids.length === 0) {
      return { deleted: 0 };
    }

    try {
      const params: any[] = [ids];
      const sql =
        `UPDATE contexts SET archived_at = now()
         WHERE id = ANY($1::uuid[]) AND archived_at IS NULL` +
        scopePredicate(scope, 'project_id', params);

      const result = await pool.query(sql, params);

      return { deleted: result.rowCount || 0 };
    } catch (error) {
      logger.error('Bulk delete contexts error', { error });
      throw new Error('Failed to bulk delete contexts');
    }
  }

  /**
   * Bulk update contexts
   */
  /**
   * PROJECT-SCOPED (REALIGN step 9). The ids arrive in the body, so —
   * exactly as bulkDeleteContexts — `scope` is the only thing between a caller and a row in
   * a project they hold no grant on. It constrains the WHERE; it is never a post-filter.
   *
   * `skipped` is every requested id the UPDATE did not touch: out of scope OR nonexistent.
   * The two are deliberately not distinguished — telling a caller "that id exists, you just
   * can't see it" is the leak in miniature.
   *
   * The DESTINATION of a `project_id` move is the CONTROLLER's check, not this one: the
   * scope answers "which rows may I touch", the destination is a separate grant.
   */
  static async bulkUpdateContexts(
    ids: string[],
    updates: {
      project_id?: string;
      tags?: string[];
      relevance_score?: number;
    },
    scope: ProjectListScope
  ): Promise<{ updated: number; skipped: string[] }> {
    if (ids.length === 0) {
      return { updated: 0, skipped: [] };
    }

    try {
      // Build SET clause dynamically based on which fields are provided
      const setClauses: string[] = [];
      const values: any[] = [ids]; // $1 will be the ids array
      let paramIndex = 2;

      if (updates.project_id !== undefined) {
        setClauses.push(`project_id = $${paramIndex}`);
        values.push(updates.project_id);
        paramIndex++;
      }

      if (updates.tags !== undefined) {
        setClauses.push(`tags = $${paramIndex}`);
        values.push(updates.tags);
        paramIndex++;
      }

      if (updates.relevance_score !== undefined) {
        setClauses.push(`relevance_score = $${paramIndex}`);
        values.push(updates.relevance_score);
        paramIndex++;
      }

      if (setClauses.length === 0) {
        return { updated: 0, skipped: [...new Set(ids)] };
      }

      const query =
        `UPDATE contexts
         SET ${setClauses.join(', ')}
         WHERE id = ANY($1::uuid[])` +
        scopePredicate(scope, 'project_id', values) +
        ` RETURNING id`;

      const result = await pool.query(query, values);
      const touched = new Set<string>(result.rows.map((r: { id: string }) => r.id));

      return {
        updated: result.rowCount || 0,
        skipped: [...new Set(ids)].filter((id) => !touched.has(id)),
      };
    } catch (error) {
      logger.error('Bulk update contexts error', { error });
      throw new Error('Failed to bulk update contexts');
    }
  }

  /**
   * Get context statistics
   */
  static async getContextStats(scope: ProjectListScope): Promise<ContextStats> {
    try {
      const params: any[] = [];
      // LIVE rows only, and the archive predicate is applied FIRST — above the caller's
      // project filter — so no future branch can be inserted between the WHERE and the
      // archive test. `archived` is counted separately below.
      const projectFilter =
        ' WHERE c.archived_at IS NULL' + scopePredicate(scope, 'c.project_id', params);

      // Get basic counts first
      const basicResult = await pool.query(`
        SELECT
          COUNT(*) as total_contexts,
          COUNT(*) FILTER (WHERE c.created_at >= NOW() - INTERVAL '7 days') as recent_contexts,
          COUNT(DISTINCT c.project_id) as total_projects,
          MAX(c.created_at) as most_recent_timestamp
        FROM contexts c
        ${projectFilter}
      `, params);

      // Get type counts
      const typeResult = await pool.query(`
        SELECT 
          c.context_type,
          COUNT(*) as count
        FROM contexts c
        ${projectFilter}
        GROUP BY c.context_type
        ORDER BY c.context_type
      `, params);

      // Get project counts
      const projectResult = await pool.query(`
        SELECT 
          COALESCE(p.name, 'Unknown') as project_name,
          COUNT(*) as count
        FROM contexts c
        LEFT JOIN projects p ON c.project_id = p.id
        ${projectFilter}
        GROUP BY p.name
        ORDER BY project_name
      `, params);

      // SOFT-DELETED rows, reported ALONGSIDE the live totals (never inside them).
      const archivedParams: any[] = [];
      const archivedResult = await pool.query(
        'SELECT COUNT(*) as archived FROM contexts c WHERE c.archived_at IS NOT NULL' +
          scopePredicate(scope, 'c.project_id', archivedParams),
        archivedParams
      );

      // Build the by_type object
      const by_type: Record<string, number> = {};
      typeResult.rows.forEach(row => {
        by_type[row.context_type] = parseInt(row.count);
      });

      // Build the by_project object  
      const by_project: Record<string, number> = {};
      projectResult.rows.forEach(row => {
        by_project[row.project_name] = parseInt(row.count);
      });

      const basicRow = basicResult.rows[0];

      return {
        total_contexts: parseInt(basicRow.total_contexts),
        recent_contexts: parseInt(basicRow.recent_contexts),
        total_projects: parseInt(basicRow.total_projects),
        most_recent_timestamp: basicRow.most_recent_timestamp,
        by_type,
        by_project,
        archived: parseInt(archivedResult.rows[0].archived)
      };
    } catch (error) {
      logger.error('Get context stats error', { error });
      throw new Error('Failed to get context statistics');
    }
  }

  /**
   * Get weekly context velocity analytics
   */
  static async getWeeklyVelocity(scope: ProjectListScope): Promise<Array<{
    week: string;
    contexts: number;
    weekStart: string;
  }>> {
    try {
      const params: any[] = [];
      // LIVE rows only — a velocity chart that keeps counting deleted
      // contexts reports work that no longer exists. Archive predicate applied first.
      const projectFilter =
        ' WHERE archived_at IS NULL' + scopePredicate(scope, 'project_id', params);

      const result = await pool.query(`
        SELECT 
          DATE_TRUNC('week', created_at) as week_start,
          TO_CHAR(DATE_TRUNC('week', created_at), 'YYYY-MM-DD') as week,
          COUNT(*) as contexts
        FROM contexts
        ${projectFilter}
        GROUP BY DATE_TRUNC('week', created_at)
        ORDER BY week_start DESC
        LIMIT 12
      `, params);

      return result.rows.map(row => ({
        week: row.week,
        contexts: parseInt(row.contexts),
        weekStart: row.week
      })).reverse(); // Reverse to show oldest first for chart display
    } catch (error) {
      logger.error('Get weekly velocity error', { error });
      throw new Error('Failed to get weekly context velocity');
    }
  }

  /**
   * Export contexts
   */
  static async exportContexts(
    params: ContextSearchParams,
    format: 'json' | 'csv' | 'md' = 'json'
  ): Promise<{ data: string; filename: string; contentType: string }> {
    // Get all matching contexts (no pagination for export)
    const searchResult = await this.searchContexts({ ...params, limit: 10000, offset: 0 });

    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      return {
        data: JSON.stringify({
          contexts: searchResult.contexts,
          exported_at: new Date().toISOString(),
          total_exported: searchResult.contexts.length,
          filters: params
        }, null, 2),
        filename: `contexts-export-${timestamp}.json`,
        contentType: 'application/json'
      };
    } else if (format === 'csv') {
      // CSV format
      const headers = [
        'ID', 'Project', 'Type', 'Content Preview', 'Tags',
        'Relevance Score', 'Created At', 'Updated At'
      ].join(',');

      const rows = searchResult.contexts.map(ctx => [
        `"${ctx.id}"`,
        `"${ctx.project_name || 'Unknown'}"`,
        `"${ctx.type}"`,
        `"${ctx.content.substring(0, 100).replace(/"/g, '""')}..."`,
        `"${(ctx.tags || []).join('; ')}"`,
        ctx.relevance_score || 0,
        `"${ctx.created_at}"`,
        `"${ctx.updated_at}"`
      ].join(',')).join('\n');

      return {
        data: `${headers}\n${rows}`,
        filename: `contexts-export-${timestamp}.csv`,
        contentType: 'text/csv'
      };
    } else if (format === 'md') {
      // Markdown format - full content with all metadata
      const header = `# AIDIS Context Export\n\n**Exported:** ${new Date().toISOString()}\n**Total Contexts:** ${searchResult.contexts.length}\n\n---\n\n`;

      const content = searchResult.contexts.map((ctx, index) => {
        const metadata = ctx.metadata ? JSON.stringify(ctx.metadata, null, 2) : 'None';
        const tags = ctx.tags && ctx.tags.length > 0 ? ctx.tags.join(', ') : 'None';
        const sessionId = ctx.session_id || 'None';
        const relevance = ctx.relevance_score || 'N/A';

        return `## Context ${index + 1}: ${ctx.type}

**Project:** ${ctx.project_name || 'Unknown'}
**Tags:** ${tags}
**Relevance Score:** ${relevance}
**Session ID:** ${sessionId}
**Created:** ${ctx.created_at}
**Updated:** ${ctx.updated_at}

### Content

${ctx.content}

### Metadata

\`\`\`json
${metadata}
\`\`\`

---

`;
      }).join('\n');

      return {
        data: header + content,
        filename: `contexts-export-${timestamp}.md`,
        contentType: 'text/markdown'
      };
    }

    throw new Error(`Unsupported export format: ${format}`);
  }

  /**
   * Get the TYPED GRAPH EDGES touching a context (the TreeWalker "thread box" moat).
   *
   * Reads the real `links` table (migration 049) — BOTH directions: outgoing
   * (from_id = :id) and incoming (to_id = :id). Each edge is resolved to its OTHER
   * endpoint's display fields by joining the endpoint's own table (contexts /
   * technical_decisions / tasks) on the id + kind. This is STRUCTURE, not semantics —
   * it must never be confused with getRelatedContexts (embedding similarity).
   *
   * Scope: a context id is globally unique, so — like getContext / getRelatedContexts
   * (both by-id sub-resources) — this returns the record's real edges without an extra
   * project filter; over-filtering would silently hide legitimate edges whose stored
   * `links.project_id` is null (pre-project-scoping) or set to the endpoint's project.
   */
  static async getContextLinks(contextId: string): Promise<ContextLink[]> {
    // Delegates to the ONE canonical typed-edge resolver (LinkService.getLinksForRecord).
    // The query keys only on the id, so a context id works unchanged; keeping this public
    // method + its route means nothing upstream changes. See services/links.ts (    // one resolver, not three copies).
    return LinkService.getLinksForRecord(contextId);
  }

  /**
   * Get related contexts using semantic similarity
   */
  static async getRelatedContexts(contextId: string, limit = 5): Promise<Context[]> {
    try {
      // NEIGHBOURS are LIVE rows only (`c2.archived_at IS NULL`): a
      // soft-deleted context must not be recommended back to the user under another
      // record. The ANCHOR `c1` is deliberately NOT filtered — the reader still resolves
      // an archived context by id (see getContextById), and its related list should work
      // there too.
      // Lesson-011 class-fix: read the ACTIVE embedder's column (config, never the
      // hardcoded legacy `embedding`) so this degrades gracefully post-gemma-cutover.
      const col = activeEmbeddingColumn();
      const result = await pool.query(`
        SELECT
          c2.id, c2.project_id, c2.context_type as type, c2.content, c2.metadata, c2.tags,
          c2.relevance_score, c2.session_id, c2.created_at, c2.created_at as updated_at,
          p.name as project_name,
          c1.${col} <-> c2.${col} as distance
        FROM contexts c1
        JOIN contexts c2 ON c1.id != c2.id
        LEFT JOIN projects p ON c2.project_id = p.id
        WHERE c1.id = $1 AND c2.archived_at IS NULL
          AND c1.${col} IS NOT NULL AND c2.${col} IS NOT NULL
        ORDER BY c1.${col} <-> c2.${col} ASC
        LIMIT $2
      `, [contextId, limit]);

      return result.rows.map(row => ({
        id: row.id,
        project_id: row.project_id,
        project_name: row.project_name,
        type: row.type,
        content: row.content,
        metadata: row.metadata,
        tags: row.tags,
        relevance_score: row.relevance_score,
        session_id: row.session_id,
        created_at: row.created_at,
        updated_at: row.updated_at
      }));
    } catch (error) {
      logger.error('Get related contexts error', { error });
      return [];
    }
  }
}
