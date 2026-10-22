/**
 * EDGE PROVENANCE METER — the DB gather (PHASE 0).
 *
 * Reads the meter views migration 079 defines. THE CLASSIFICATION LIVES IN SQL (the
 * `link_provenance` view) — this module never re-spells declared/guessed; it only reads
 * `provenance_class` back. One rule, one home.
 *
 * Consumers:
 *   - GET /api/v2/graph/provenance (healthServer) → readProvenanceMeter()
 *   - the declared-rate alarm (provenanceAlarm.ts) → countDeclaredInWindow()
 *   - the coverage split reads the SAME view directly in projectCoverage.readEdges().
 *
 * FAIL LOUD (projectCoverage.ts's inherited rule): a failed read THROWS. No silent zero —
 * a meter that returns 0 when it could not measure would report the exact failure shape it
 * exists to detect (C1: "could not measure" must never share a value with "no").
 */

import type { Pool, QueryConfig } from 'pg';
import { db } from '../config/database.js';
import { PROVENANCE_CONFIG } from '../config/provenanceConfig.js';

/**
 * Statement-level timeout wrapper for THE ALARM'S two reads (countDeclaredInWindow,
 * measureSourceLiveness) — pg's per-query `query_timeout`, so a hung query THROWS
 * ('Query read timeout') instead of blocking forever. WHY: with no bound
 * anywhere in the chain (server statement_timeout is 0), one hung meter query wedged the
 * alarm's single-flight latch permanently — silent blindness, the exact shape this module's
 * FAIL LOUD rule exists to prevent. Scoped here, NOT pool-wide: migrations/backfills may
 * legitimately run long. `query_timeout` is read per-query at runtime (pg client.js) but
 * @types/pg only declares it on ClientConfig, hence the narrow intersection type.
 */
function withMeterTimeout(text: string, values: unknown[]): QueryConfig & { query_timeout: number } {
  return { text, values, query_timeout: PROVENANCE_CONFIG.meterQueryTimeoutMs };
}

/** The classification vocabulary the link_provenance view emits. */
export type ProvenanceClass = 'declared' | 'guessed' | 'unclassified';

/** One class-rollup meter row: week × project, counts + declared rate. */
export interface ProvenanceWeeklyClassRow {
  weekStart: string;
  projectId: string | null;
  declared: number;
  guessed: number;
  unclassified: number;
  total: number;
  /** declared/total for the week (4 dp), null only for an empty group (never in practice). */
  declaredRate: number | null;
}

/** One source-grain meter row: week × project × created_by stamp. This is the grain the
 *  2026-07-28 auto:active_thread collapse is visible at — both dead-and-dying sources and
 *  their replacement guesses share the 'guessed' class, so the rollup alone cannot show a
 *  single mechanism dying. */
export interface ProvenanceWeeklySourceRow {
  weekStart: string;
  projectId: string | null;
  createdBy: string | null;
  provenanceClass: ProvenanceClass;
  edges: number;
}

export interface ProvenanceMeter {
  /** Class rollup, newest week first. */
  byClass: ProvenanceWeeklyClassRow[];
  /** Source grain, newest week first then by edge count. */
  bySource: ProvenanceWeeklySourceRow[];
  /** The scope this answer covers, stated exactly. */
  scope: { weeks: number; projectId: string | null };
}

/**
 * Read the meter: the last `weeks` weeks (including the current partial week), optionally
 * scoped to one project (null/undefined = all projects, the grain the alarm watches).
 */
export async function readProvenanceMeter(
  opts: { projectId?: string | null; weeks?: number } = {},
  pool: Pool = db
): Promise<ProvenanceMeter> {
  const weeks = opts.weeks && Number.isInteger(opts.weeks) && opts.weeks > 0 ? opts.weeks : 12;
  const projectId = opts.projectId ?? null;

  const since = `date_trunc('week', now()) - ($1::int - 1) * interval '1 week'`;
  const projectFilter = projectId === null ? '' : 'AND project_id = $2::uuid';
  const params: unknown[] = projectId === null ? [weeks] : [weeks, projectId];

  const classRes = await pool.query(
    `SELECT week_start::text, project_id::text, declared, guessed, unclassified, total,
            declared_rate
       FROM link_provenance_weekly_class
      WHERE week_start >= ${since} ${projectFilter}
      ORDER BY week_start DESC, project_id`,
    params
  );
  const sourceRes = await pool.query(
    `SELECT week_start::text, project_id::text, created_by, provenance_class, edges
       FROM link_provenance_weekly
      WHERE week_start >= ${since} ${projectFilter}
      ORDER BY week_start DESC, edges DESC`,
    params
  );

  return {
    byClass: classRes.rows.map((r) => ({
      weekStart: r.week_start,
      projectId: r.project_id ?? null,
      declared: r.declared,
      guessed: r.guessed,
      unclassified: r.unclassified,
      total: r.total,
      declaredRate: r.declared_rate === null ? null : Number(r.declared_rate),
    })),
    bySource: sourceRes.rows.map((r) => ({
      weekStart: r.week_start,
      projectId: r.project_id ?? null,
      createdBy: r.created_by ?? null,
      provenanceClass: r.provenance_class,
      edges: r.edges,
    })),
    scope: { weeks, projectId },
  };
}

/**
 * Count DECLARED-class edges minted in the rolling window ending now. THE alarm's input —
 * a structured integer straight from SQL, never parsed from prose (an earlier task
 * acceptance 4). `windowDays` accepts fractions (interval arithmetic), which is how the
 * contract test constructs a genuinely-empty window without touching other rows.
 *
 * THROWS on a failed read — the caller (provenanceAlarm.runOnce) maps that to its explicit
 * could-not-measure branch, never to "0 declared".
 */
export async function countDeclaredInWindow(windowDays: number, pool: Pool = db): Promise<number> {
  const res = await pool.query(withMeterTimeout(
    `SELECT count(*)::int AS declared
       FROM link_provenance
      WHERE provenance_class = 'declared'
        AND created_at >= now() - ($1::numeric * interval '1 day')`,
    [windowDays]
  ));
  return res.rows[0].declared as number;
}

/** One source's liveness measurement — structured integers straight from SQL. */
export interface SourceLiveness {
  /** The created_by stamp. */
  source: string;
  /** Its busiest week in the lookback (edges/week) — proof it was historically active. */
  peakWeekly: number;
  /** Edges it minted in the current rolling window. 0 = the mechanism looks dead. */
  inWindow: number;
}

/**
 * Measure liveness for every HISTORICALLY ACTIVE source (dead-source alarm leg, the coordinator
 * ruling on an earlier task): a source qualifies when at least one week in the last
 * `lookbackWeeks` minted >= `activePerWeek` edges; for each, count its mints in the
 * current `windowDays` window. Class-agnostic BY DESIGN — the 2026-07-28 death was of a
 * GUESSED-class source, and a dead mechanism is a dead mechanism regardless of bucket.
 *
 * All values are SQL ints (acceptance: verdicts derive from structured counts). THROWS on
 * a failed read — the alarm maps that to could-not-measure, never to "everything is dead"
 * or "everything is fine".
 */
export async function measureSourceLiveness(
  args: { windowDays: number; lookbackWeeks: number; activePerWeek: number },
  pool: Pool = db
): Promise<SourceLiveness[]> {
  const res = await pool.query(withMeterTimeout(
    `WITH weekly AS (
       SELECT created_by, date_trunc('week', created_at) AS week, count(*)::int AS edges
         FROM link_provenance
        WHERE created_by IS NOT NULL
          AND created_at >= date_trunc('week', now()) - ($2::int * interval '1 week')
        GROUP BY 1, 2
     ),
     active AS (
       SELECT created_by, max(edges)::int AS peak_weekly
         FROM weekly
        GROUP BY 1
       HAVING max(edges) >= $3::int
     ),
     recent AS (
       SELECT created_by, count(*)::int AS in_window
         FROM link_provenance
        WHERE created_by IS NOT NULL
          AND created_at >= now() - ($1::numeric * interval '1 day')
        GROUP BY 1
     )
     SELECT a.created_by AS source,
            a.peak_weekly,
            COALESCE(r.in_window, 0)::int AS in_window
       FROM active a
       LEFT JOIN recent r ON r.created_by = a.created_by
      ORDER BY a.created_by`,
    [args.windowDays, args.lookbackWeeks, args.activePerWeek]
  ));
  return res.rows.map((r) => ({
    source: r.source as string,
    peakWeekly: r.peak_weekly as number,
    inWindow: r.in_window as number,
  }));
}
