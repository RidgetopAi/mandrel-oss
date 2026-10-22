/**
 * REPROJECT — MOVE a record (context / decision / task) from one project to another,
 * PRESERVING its identity.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────
 * Every mutating op is project-scoped BY DESIGN: `context_update` resolves the record
 * INSIDE one project, so it can never cross the boundary. Measured behaviourally on prod
 *: `context update` with `projectId:'riverbend'` on a record living in
 * `personal` returned `Context not found` — `projectId` scoped the LOOKUP to the
 * destination, found nothing, and changed nothing. Sweeping all gateway actions found no
 * reparent op. Project membership was effectively IMMUTABLE after write, for all three
 * record types, and records misfiled by a project-slot bleed stayed misfiled forever.
 *
 * ── WHAT A MOVE IS NOT ─────────────────────────────────────────────────────────────────
 * NOT store-into-destination + delete-from-source. That mints a NEW id (breaking the
 * `/r/<id8>` permalink) and discards created_at, session_id and every inbound typed edge —
 * a lossy copy wearing a move's clothes. This is an UPDATE of the membership column, in one
 * transaction, so the id, the timestamps, the session provenance and the whole edge
 * neighbourhood are the SAME rows before and after.
 *
 * ── THE PART THAT IS NOT ONE UPDATE ────────────────────────────────────────────────────
 * `project_id` is denormalized across 36 base tables, several of them read with
 * `AND project_id = $2` on the recall/branch/handoff path. So a move that touched only the
 * record row would leave the record's own edges and branch membership stamped with the OLD
 * project and the record would go BLIND in the destination — silently, with no error.
 * Which tables must follow, which must not, and why, is declared ONCE in
 * config/reprojectConfig.ts and re-checked against the live catalog by
 * reprojectSatelliteCoverage.contract.test.ts. This module carries NO table list of its own.
 *
 * ── THE EDGE POLICY (the judgement an earlier task said had to be DECIDED) ───────────────
 * A typed edge joins two records, so after a move its endpoints may sit in different
 * projects and `links.project_id` cannot simply follow one of them. The rule, applied per
 * edge, is:
 *
 *   BOTH endpoints end up in the destination  → RE-STAMP `links.project_id` to the
 *       destination, and CLEAR any stale cross-project markers. This is the case that must
 *       not be skipped: branchMembership.ts and handoffHead.ts both read edges with
 *       `AND l.project_id = $2`, so an un-restamped edge is invisible to the branch walk
 *       and the handoff chain in the project the record now lives in.
 *
 *   the other endpoint is elsewhere          → LEAVE `links.project_id` alone (it records
 *       the WRITER's project — a historical fact, and rewriting it would claim the edge was
 *       authored somewhere it was not) and MARK the row `metadata.cross_project = true`,
 *       the existing queryable convention from services/links.ts. The edge SURVIVES; edges
 *       are never dropped by a move.
 *
 *   the other endpoint does not resolve      → LEFT EXACTLY AS IT IS and counted as
 *       `danglingEdges`. A dangling edge is a pre-existing repair case (see
 *       resolveMintEndpoint's header); calling it "cross-project" would be a false label on
 *       a row whose real problem is that its endpoint is missing.
 *
 * Nothing here deletes an edge. The move is reversible by moving the record back.
 */

import type { Pool, PoolClient } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { resolveMintEndpoint } from '../utils/idResolver.js';
import {
  RECORD_CREATED_AT_COLUMN,
  RECORD_ENTITY,
  RECORD_TABLE,
  REPROJECT_SATELLITES,
  followersFor,
  type ReprojectRecordType,
} from '../config/reprojectConfig.js';

/** The machine code a caller can branch on when a move is refused. */
export const REPROJECT_ERROR_CODE = 'REPROJECT_REFUSED';

/**
 * A refusal, carrying the machine code IN the message the way CallerIdentityError and
 * AnchorSessionKeyError do — formatMcpError appends a generic "re-check your parameters"
 * hint to any message with no 💡 of its own, and the remedy here is never a parameter typo.
 */
export class ReprojectError extends Error {
  readonly code = REPROJECT_ERROR_CODE;
  constructor(message: string) {
    super(`[${REPROJECT_ERROR_CODE}] ${message}`);
    this.name = 'ReprojectError';
  }
}

/** One satellite table the move touched, and how many of its rows followed. */
export interface SatelliteMoveCount {
  table: string;
  rows: number;
}

/** What the move did to the record's typed edges. */
export interface EdgeMoveCounts {
  /** Edges with the record at either endpoint — the population the policy ran over. */
  touched: number;
  /** Both endpoints in the destination → `project_id` re-stamped to it. */
  restamped: number;
  /** The other endpoint is in a different project → left stamped, marked cross_project. */
  crossProject: number;
  /** The other endpoint resolves to no record → left exactly as-is (a repair case). */
  dangling: number;
}

export interface ReprojectResult {
  recordType: ReprojectRecordType;
  /** The record's id — UNCHANGED by the move. That is the point of the feature. */
  recordId: string;
  fromProject: { id: string; name: string };
  toProject: { id: string; name: string };
  /** false when the record was ALREADY in the destination (a no-op, not an error). */
  moved: boolean;
  /** Preserved provenance, echoed so a caller can VERIFY preservation without a second read. */
  preserved: { createdAt: string; sessionId: string | null };
  /** Per-table row counts for the satellites whose project_id followed the record. */
  satellites: SatelliteMoveCount[];
  edges: EdgeMoveCounts;
  /**
   * Open branch positions / anchors still standing on this record in the SOURCE project.
   * Deliberately NOT moved (they are per-session slots keyed `(project_id, session_key)` —
   * see the 'caller-slot' class in config/reprojectConfig.ts) and deliberately REPORTED,
   * because a silently stranded cursor is exactly the kind of thing that is discovered
   * three sessions later.
   */
  strandedPositions: number;
}

/** The four keys services/links.ts writes when it mints a cross-project edge, plus ours. */
const CROSS_PROJECT_KEYS = [
  'cross_project',
  'to_project_id',
  'to_project_name',
  'cross_project_ref_form',
  'cross_project_via',
] as const;

/**
 * Resolve a project by id OR name to `{id, name}`.
 *
 * Deliberately a plain query rather than projectHandler.getProject: that method also
 * computes stats and consults session state, none of which a move needs, and importing the
 * handler here would point a service at a handler (the wrong direction).
 */
async function resolveProject(
  identifier: string,
  client: Pool | PoolClient,
): Promise<{ id: string; name: string } | null> {
  const res = await client.query(
    `SELECT id::text AS id, name FROM projects WHERE id::text = $1 OR name = $1 LIMIT 2`,
    [identifier],
  );
  if (res.rows.length === 0) return null;
  if (res.rows.length > 1) {
    // A name that is also a uuid string is the only way to get here; refuse rather than pick.
    throw new ReprojectError(
      `"${identifier}" matches more than one project — pass the project's full id instead.` +
        `\n\n💡 \`project_list\` shows every project's id.`,
    );
  }
  return res.rows[0];
}

export interface ReprojectInput {
  recordType: ReprojectRecordType;
  /** Full UUID or 8+-hex short id. Resolved ACROSS projects — see moveRecord. */
  recordId: string;
  /** Destination project id or name. */
  toProject: string;
}

/**
 * MOVE the record. One transaction: either the record and every follower land in the
 * destination together, or nothing moves.
 *
 * THE ID IS RESOLVED ACROSS PROJECTS, ON PURPOSE. Every other id-taking op scopes short-id
 * resolution to the caller's project, which is right for them and wrong here: the record
 * this op exists to rescue is BY DEFINITION in a project the caller is not in. A short id
 * that matches rows in two projects raises the usual AmbiguousIdError listing both — the
 * resolver never picks.
 */
export async function moveRecord(
  input: ReprojectInput,
  pool: Pool = db,
): Promise<ReprojectResult> {
  const { recordType } = input;
  const table = RECORD_TABLE[recordType];

  const destination = await resolveProject(input.toProject, pool);
  if (!destination) {
    throw new ReprojectError(
      `destination project "${input.toProject}" does not exist — nothing was moved.` +
        `\n\n💡 \`project_list\` shows every project; \`project_create\` makes a new one.`,
    );
  }

  // Existence- and shape-checked, across every project (see the doc above).
  const recordId = await resolveMintEndpoint(
    RECORD_ENTITY[recordType],
    input.recordId,
    undefined,
    pool,
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the record row and read the BEFORE state inside the transaction, so a concurrent
    // move of the same record serializes behind this one instead of interleaving.
    const createdAtColumn = RECORD_CREATED_AT_COLUMN[recordType];
    const before = await client.query(
      `SELECT project_id::text AS project_id, ${createdAtColumn} AS created_at,
              session_id::text AS session_id
         FROM ${table} WHERE id = $1 FOR UPDATE`,
      [recordId],
    );
    if (before.rows.length === 0) {
      // Only reachable if the row was deleted between resolution and the lock.
      throw new ReprojectError(
        `${recordType} ${recordId} no longer exists — nothing was moved.`,
      );
    }
    const sourceId: string | null = before.rows[0].project_id;
    const preserved = {
      createdAt: new Date(before.rows[0].created_at).toISOString(),
      sessionId: before.rows[0].session_id ?? null,
    };

    const sourceRow = sourceId ? await resolveProject(sourceId, client) : null;
    const fromProject = sourceRow ?? { id: sourceId ?? '', name: sourceId ? '(unknown)' : '(none)' };

    // ALREADY THERE → a no-op, reported as one. Not an error: asking for a state the system
    // is already in is a reasonable thing for a UI button to do twice.
    if (sourceId === destination.id) {
      await client.query('ROLLBACK');
      return {
        recordType,
        recordId,
        fromProject,
        toProject: destination,
        moved: false,
        preserved,
        satellites: [],
        edges: { touched: 0, restamped: 0, crossProject: 0, dangling: 0 },
        strandedPositions: 0,
      };
    }

    // ── 1. the record row itself. project_id ONLY. ────────────────────────────────────
    // Every other column is untouched — INCLUDING created_at, session_id and (for tasks)
    // updated_at and version. A move changes where the record is FILED, not what it says,
    // so bumping updated_at would reorder every "recently updated" view for a record whose
    // content did not change, and bumping `version` would invalidate a live claim holder's
    // optimistic update for a change that has nothing to do with them.
    await client.query(`UPDATE ${table} SET project_id = $2 WHERE id = $1`, [
      recordId,
      destination.id,
    ]);

    // ── 2. the followers, straight off the declared registry ─────────────────────────
    const satellites: SatelliteMoveCount[] = [];
    for (const entry of followersFor(recordType)) {
      // Column names come from the frozen registry, never from caller input; the record id
      // and both project ids are BOUND parameters.
      const predicate = entry.match!.columns.map((c) => `${c} = $1`).join(' OR ');
      const res = await client.query(
        `UPDATE ${entry.table} SET project_id = $2 WHERE (${predicate}) AND project_id = $3`,
        [recordId, destination.id, sourceId],
      );
      if (res.rowCount) satellites.push({ table: entry.table, rows: res.rowCount });
    }

    // ── 3. the edge policy ───────────────────────────────────────────────────────────
    const edges = await applyEdgePolicy(recordId, destination.id, client);

    // ── 4. what we deliberately did NOT move, counted so it is not invisible ─────────
    const strandedPositions = await countStrandedPositions(recordId, sourceId, recordType, client);

    await client.query('COMMIT');

    logger.info(
      `📦 reproject: ${recordType} ${recordId} ${fromProject.name} → ${destination.name} ` +
        `(edges touched=${edges.touched} restamped=${edges.restamped} ` +
        `cross=${edges.crossProject} dangling=${edges.dangling})`,
    );

    return {
      recordType,
      recordId,
      fromProject,
      toProject: destination,
      moved: true,
      preserved,
      satellites,
      edges,
      strandedPositions,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Apply the EDGE POLICY documented at the top of this file to every edge touching the
 * record. Runs AFTER the record row has been updated, so a self-edge sees the record in
 * the destination — which is what "both endpoints in the destination" means for it.
 */
async function applyEdgePolicy(
  recordId: string,
  destinationId: string,
  client: PoolClient,
): Promise<EdgeMoveCounts> {
  // The other endpoint of each touching edge, resolved to ITS project. The three-way
  // COALESCE is the polymorphic lookup `links` needs and no FK can give us: from_type /
  // to_type say which table the id lives in.
  //
  // ARCHIVED ENDPOINTS COUNT, deliberately — there is no `archived_at IS NULL` here. The
  // question this asks is "which project is that record FILED IN", and a soft-deleted record
  // is still filed somewhere; it can be restored, and when it is, its edges must already be
  // stamped correctly. Excluding archived rows would classify a live edge to a restorable
  // record as DANGLING and leave its stamp behind — the one outcome that is wrong in both
  // directions at once.
  const OTHER_ENDPOINT_CTE = `
    WITH touched AS (
      SELECT l.id,
             CASE WHEN l.from_id = $1 THEN l.to_id   ELSE l.from_id   END AS other_id,
             CASE WHEN l.from_id = $1 THEN l.to_type ELSE l.from_type END AS other_type
        FROM links l
       WHERE l.from_id = $1 OR l.to_id = $1
    ),
    resolved AS (
      SELECT t.id,
             COALESCE(
               (SELECT c.project_id FROM contexts c
                 WHERE t.other_type = 'context'  AND c.id = t.other_id),
               (SELECT d.project_id FROM technical_decisions d
                 WHERE t.other_type = 'decision' AND d.id = t.other_id),
               (SELECT k.project_id FROM tasks k
                 WHERE t.other_type = 'task'     AND k.id = t.other_id)
             )::text AS other_project
        FROM touched t
    )`;

  const touched = (
    await client.query(`${OTHER_ENDPOINT_CTE} SELECT count(*)::int AS c FROM resolved`, [recordId])
  ).rows[0].c as number;

  // BOTH ENDPOINTS IN THE DESTINATION → re-stamp, and drop any now-false cross-project
  // markers so an audit of `metadata->>'cross_project'` does not report a boundary that no
  // longer exists.
  const stripKeys = CROSS_PROJECT_KEYS.map((k) => `- '${k}'`).join(' ');
  const restamped =
    (
      await client.query(
        `${OTHER_ENDPOINT_CTE}
         UPDATE links SET project_id = $2::uuid, metadata = metadata ${stripKeys}
           FROM resolved r
          WHERE links.id = r.id AND r.other_project = $2`,
        [recordId, destinationId],
      )
    ).rowCount ?? 0;

  // THE OTHER ENDPOINT IS ELSEWHERE → keep the writer-project stamp, mark it crossing.
  const crossProject =
    (
      await client.query(
        `${OTHER_ENDPOINT_CTE}
         UPDATE links SET metadata = metadata || jsonb_build_object(
                            'cross_project', true, 'cross_project_via', 'reproject')
           FROM resolved r
          WHERE links.id = r.id
            AND r.other_project IS NOT NULL
            AND r.other_project <> $2`,
        [recordId, destinationId],
      )
    ).rowCount ?? 0;

  // THE OTHER ENDPOINT DOES NOT RESOLVE → untouched, but counted rather than swallowed.
  const dangling =
    (
      await client.query(
        `${OTHER_ENDPOINT_CTE} SELECT count(*)::int AS c FROM resolved WHERE other_project IS NULL`,
        [recordId],
      )
    ).rows[0].c as number;

  return { touched, restamped, crossProject, dangling };
}

/**
 * How many per-caller cursors are still pointing at this record in the project it just
 * left. Derived from the 'caller-slot' entries in the registry — this function holds no
 * table names of its own, so a new caller-slot table is counted the moment it is declared.
 */
async function countStrandedPositions(
  recordId: string,
  sourceId: string | null,
  recordType: ReprojectRecordType,
  client: PoolClient,
): Promise<number> {
  if (!sourceId) return 0;
  let total = 0;
  for (const entry of REPROJECT_SATELLITES) {
    if (entry.kind !== 'caller-slot') continue;
    if (!entry.match!.types.includes(recordType)) continue;
    const predicate = entry.match!.columns.map((c) => `${c} = $1`).join(' OR ');
    // SOFT-DELETE-EXEMPT: the tables this iterates are the 'caller-slot' class — today
    // `branch_positions` and `active_thread_anchors` — and NEITHER carries an `archived_at`
    // column: a cursor is opened and closed, never soft-deleted. There is no archived row for
    // a predicate to exclude, so adding one would not narrow this count, it would fail. The
    // population is not a guess: it is `REPROJECT_SATELLITES.filter(kind === 'caller-slot')`,
    // and reprojectSatelliteCoverage.contract.test.ts G3 proves every column named there
    // exists on its table, so a future caller-slot table cannot be added here unseen.
    const res = await client.query(
      `SELECT count(*)::int AS c FROM ${entry.table} WHERE (${predicate}) AND project_id = $2`,
      [recordId, sourceId],
    );
    total += res.rows[0].c as number;
  }
  return total;
}
