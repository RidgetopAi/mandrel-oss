/**
 * BELIEF ATTEMPT LEDGER (observability) — the instrument that makes a MISS
 * COUNTABLE.
 *
 * THE DEFECT THIS CLOSES. `belief_adjudications` receives a row only when a pair reaches a
 * verdict, and `belief_adjudication_costs` only when a call returns tokens. Both are
 * success-only by construction, so neither can report the pipeline's own failure rate: their
 * denominator IS their numerator. A failed pair was persisted nowhere, and the container log —
 * ephemeral, reset by every redeploy, unaggregatable — is not a substitute. So a grep returning
 * zero was never evidence of a zero rate.
 *
 * WHAT THIS WRITES. One APPEND-ONLY row per ATTEMPT (migration 097), for BOTH outcomes, at two
 * scopes ('pair' and 'neighbourhood'). "Attempted" and "completed" then come out of ONE query
 * over ONE population (rollupAttempts) — the miss is counted, never inferred from an absence.
 *
 * FAIL-SAFE, exactly like the cost ledger: recordAttemptSafe swallows every error. Telemetry
 * must never change a verdict, and must never turn a skipped pair into a crashed neighbourhood.
 * It also must not change the DEGRADATION behaviour — a bad pair is still skipped (that is
 * correct); it is now merely visible.
 */

import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { BELIEF_ATTEMPT_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefAttemptConfig } from '../../config/beliefConfig.js';
import type { BeliefCallTier } from './types.js';
import type { BeliefFailureStage } from './providerError.js';
import { describeFailure } from './providerError.js';

/** The two scopes an attempt can have. Mirrors the DB CHECK in migration 097. */
export const BELIEF_ATTEMPT_SCOPES = ['pair', 'neighbourhood'] as const;
export type BeliefAttemptScope = (typeof BELIEF_ATTEMPT_SCOPES)[number];

/** The two outcomes. Both are WRITTEN — that is what makes a rate computable. */
export const BELIEF_ATTEMPT_OUTCOMES = ['completed', 'failed'] as const;
export type BeliefAttemptOutcome = (typeof BELIEF_ATTEMPT_OUTCOMES)[number];

export interface RecordAttemptInput {
  scope: BeliefAttemptScope;
  outcome: BeliefAttemptOutcome;
  projectId: string | null;
  pairKey?: string | null;
  aId?: string | null;
  bId?: string | null;
  sourceId?: string | null;
  provider?: string | null;
  model?: string | null;
  failedStage?: BeliefFailureStage | null;
  failedTier?: BeliefCallTier | null;
  errorClass?: string | null;
  httpStatus?: number | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/** Truncate a persisted error message to the configured bound (config, not a literal). */
export function truncateErrorMessage(
  message: string | null | undefined,
  cfg: BeliefAttemptConfig = BELIEF_ATTEMPT_CONFIG
): string | null {
  if (typeof message !== 'string' || message.length === 0) return null;
  const max = cfg.errorMessageMaxChars;
  if (!Number.isInteger(max) || max <= 0) return message;
  return message.length <= max ? message : message.slice(0, max);
}

/**
 * Build the ledger input for a FAILED attempt from a thrown value. Keeps the classification in
 * ONE place so the pair path and the neighbourhood path cannot describe the same error two ways.
 */
export function failureAttempt(
  e: unknown,
  base: Omit<RecordAttemptInput, 'outcome' | 'failedStage' | 'failedTier' | 'errorClass' | 'httpStatus' | 'errorMessage'> & {
    fallbackStage: BeliefFailureStage;
  },
  cfg: BeliefAttemptConfig = BELIEF_ATTEMPT_CONFIG
): RecordAttemptInput {
  const { fallbackStage, ...rest } = base;
  const d = describeFailure(e, fallbackStage);
  return {
    ...rest,
    outcome: 'failed',
    // The provider identity from the error itself wins: an attempt that died inside the tiered
    // provider knows which TIER's model it was calling, which the caller does not.
    provider: d.provider ?? rest.provider ?? null,
    model: d.model ?? rest.model ?? null,
    failedStage: d.stage,
    failedTier: d.tier,
    errorClass: d.errorClass,
    httpStatus: d.httpStatus,
    errorMessage: truncateErrorMessage(d.message, cfg),
  };
}

/**
 * Insert ONE attempt row. MAY throw (DB error) — callers on the adjudication path MUST use
 * recordAttemptSafe. Returns the new row id.
 */
export async function recordAttempt(
  input: RecordAttemptInput,
  pool: Pool = db
): Promise<{ id: string }> {
  const r = await pool.query(
    `INSERT INTO belief_adjudication_attempts (
        project_id, scope, outcome, pair_key, a_id, b_id, source_id,
        provider, model, failed_stage, failed_tier, error_class, http_status,
        error_message, duration_ms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id::text AS id`,
    [
      input.projectId,
      input.scope,
      input.outcome,
      input.pairKey ?? null,
      input.aId ?? null,
      input.bId ?? null,
      input.sourceId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.failedStage ?? null,
      input.failedTier ?? null,
      input.errorClass ?? null,
      input.httpStatus ?? null,
      input.errorMessage ?? null,
      input.durationMs ?? null,
    ]
  );
  return { id: r.rows[0].id };
}

/**
 * FAIL-SAFE, non-blocking attempt write. Any error (DB down, bad row) is caught + logged and
 * SWALLOWED. Returns true iff a row was written — so a test can assert the write happened
 * without reaching into the DB, and so a caller can never mistake "disabled" for "recorded".
 * Honours cfg.enabled (off ⇒ no write, returns false).
 */
export async function recordAttemptSafe(
  input: RecordAttemptInput,
  pool: Pool = db,
  cfg: BeliefAttemptConfig = BELIEF_ATTEMPT_CONFIG
): Promise<boolean> {
  try {
    if (!cfg.enabled) return false;
    await recordAttempt(input, pool);
    return true;
  } catch (e) {
    logger.warn('🧪 belief attempt ledger: write failed — skipping (verdict unaffected)', {
      metadata: { error: (e as Error)?.message, scope: input.scope, outcome: input.outcome },
    });
    return false;
  }
}

// ── Rollup: the ONE query that answers "what is the failure rate?" ───────────────────────────

export interface AttemptTotals {
  attempted: number;
  completed: number;
  failed: number;
  /** failed / attempted, 0 when attempted is 0 (an empty population has no rate, not a 0% one). */
  failureRate: number;
}

export interface AttemptScopeTotals extends AttemptTotals {
  scope: BeliefAttemptScope;
}

export interface AttemptFailureBreakdownRow {
  failedStage: string | null;
  failedTier: string | null;
  httpStatus: number | null;
  errorClass: string | null;
  count: number;
}

export interface AttemptDayRow {
  day: string; // YYYY-MM-DD (UTC)
  scope: BeliefAttemptScope;
  attempted: number;
  completed: number;
  failed: number;
}

export interface AttemptRollup {
  windowDays: number;
  since: string; // YYYY-MM-DD
  /** Totals across BOTH scopes (the headline attempted/completed/failed). */
  overall: AttemptTotals;
  byScope: AttemptScopeTotals[];
  byDay: AttemptDayRow[];
  /** Why the failures failed — stage × tier × status × class. Empty when there are none. */
  failures: AttemptFailureBreakdownRow[];
}

function totals(attempted: number, completed: number, failed: number): AttemptTotals {
  return { attempted, completed, failed, failureRate: attempted > 0 ? failed / attempted : 0 };
}

/**
 * Roll up the attempt ledger over the last `windowDays` (UTC day boundaries). The headline —
 * attempted / completed / failed — comes from a SINGLE query over a SINGLE population, which is
 * the whole point of the table: a miss is counted, not inferred from an absence.
 */
export async function rollupAttempts(
  pool: Pool = db,
  windowDays: number = BELIEF_ATTEMPT_CONFIG.rollupWindowDays,
  cfg: BeliefAttemptConfig = BELIEF_ATTEMPT_CONFIG,
  /** Optional scope to ONE project/tenant — the per-tenant reliability question, and what lets a
   *  test assert an exact count without another test's rows landing in its population. */
  projectId: string | null = null
): Promise<AttemptRollup> {
  const days = Number.isInteger(windowDays) && windowDays > 0 ? windowDays : cfg.rollupWindowDays;
  const sinceExpr = `date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1::int - 1)`;
  const projectClause = projectId ? ' AND project_id = $2' : '';
  const params: unknown[] = projectId ? [days, projectId] : [days];

  // THE ONE QUERY. attempted, completed and failed all come off the same rows, per day per scope;
  // every coarser number below is folded from these in-process.
  const dayR = await pool.query(
    `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            scope,
            count(*)::bigint                                          AS attempted,
            count(*) FILTER (WHERE outcome = 'completed')::bigint     AS completed,
            count(*) FILTER (WHERE outcome = 'failed')::bigint        AS failed
       FROM belief_adjudication_attempts
      WHERE created_at >= ${sinceExpr}${projectClause}
      GROUP BY day, scope
      ORDER BY day DESC, scope`,
    params
  );

  const failR = await pool.query(
    `SELECT failed_stage, failed_tier, http_status, error_class, count(*)::bigint AS count
       FROM belief_adjudication_attempts
      WHERE created_at >= ${sinceExpr} AND outcome = 'failed'${projectClause}
      GROUP BY 1,2,3,4
      ORDER BY count DESC`,
    params
  );

  const byDay: AttemptDayRow[] = dayR.rows.map((r) => ({
    day: r.day,
    scope: r.scope as BeliefAttemptScope,
    attempted: Number(r.attempted),
    completed: Number(r.completed),
    failed: Number(r.failed),
  }));

  const scopeMap = new Map<BeliefAttemptScope, { a: number; c: number; f: number }>();
  let a = 0;
  let c = 0;
  let f = 0;
  for (const row of byDay) {
    a += row.attempted;
    c += row.completed;
    f += row.failed;
    const s = scopeMap.get(row.scope) ?? { a: 0, c: 0, f: 0 };
    s.a += row.attempted;
    s.c += row.completed;
    s.f += row.failed;
    scopeMap.set(row.scope, s);
  }

  const byScope = [...scopeMap.entries()]
    .map(([scope, s]) => ({ scope, ...totals(s.a, s.c, s.f) }))
    .sort((x, y) => y.attempted - x.attempted);

  const failures: AttemptFailureBreakdownRow[] = failR.rows.map((r) => ({
    failedStage: r.failed_stage ?? null,
    failedTier: r.failed_tier ?? null,
    httpStatus: r.http_status === null || r.http_status === undefined ? null : Number(r.http_status),
    errorClass: r.error_class ?? null,
    count: Number(r.count),
  }));

  return {
    windowDays: days,
    since: new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10),
    overall: totals(a, c, f),
    byScope,
    byDay,
    failures,
  };
}
