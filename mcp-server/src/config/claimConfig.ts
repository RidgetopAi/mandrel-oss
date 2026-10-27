/**
 * claimConfig — every tunable of the ATOMIC TASK CLAIM
 * (SPEC v1 §6.3/§6.4/§6.6/§10).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * The lease bounds, the kill switch, the allowed-status sets, and the audit retention window
 * all live HERE — a named value with a documented default and an env override — never as a
 * literal buried in the handler or the zod schema. Mirrors config/sessionConfig.ts and
 * config/taskConfig.ts: the config is the contract, the code reads it.
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default), exactly
 * like sessionConfig.envInt/envBool. TASK_CLAIM_CONFIG is a MUTABLE object on purpose so a
 * test can flip a knob per-case and restore it (the SESSION_CONFIG.resolverMode pattern)
 * without writing process.env — the suite's env-leak guard requires that.
 */

/** Read a non-negative-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a boolean env var, falling back to `fallback` on missing/unknown. Accepts (case- and
 * whitespace-insensitive) 1/true/yes/on → true and 0/false/no/off → false; anything else
 * (incl. empty/missing) → `fallback`. Same tolerant shape as sessionConfig.envBool.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * Read a comma-separated list env var, falling back to `fallback` on missing/empty. Values
 * are trimmed and lower-cased (task statuses are a lower-case vocabulary); empty entries are
 * dropped. A garbage value that yields NO entries falls back rather than producing an empty
 * allow-list — an empty allowedStatuses would make every claim fail closed and silently.
 */
function envList(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return [...fallback];
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...fallback];
}

export interface TaskClaimConfig {
  /**
   * THE KILL SWITCH (merge, deploy, and enable are three separate decisions).
   *
   * DEFAULT FALSE — with the 067 schema applied and this flag off, the runtime behaves
   * EXACTLY as it does today: task_update / task_bulk_update / task_delete are unfenced,
   * and the claim/renew/release actions answer with a typed `disabled` conflict instead of
   * mutating anything. Flipping it on is a separate, reversible decision per environment.
   *
   * env: MANDREL_TASK_CLAIM_ENABLED
   */
  enabled: boolean;

  /**
   * Default lease length when a caller does not specify one.
   *
   * WHY 2700s (45 min), not the textbook 900s: OUR workers are long-lived agents across an
   * HTTP/MCP boundary — a Builder build runs 30–60+ minutes and will NOT call back mid-build
   * to heartbeat. A lease shorter than a real unit of work makes expiry the common case
   * instead of the failure case (SPEC §6.6).
   *
   * env: MANDREL_TASK_CLAIM_DEFAULT_LEASE_SECONDS
   */
  defaultLeaseSeconds: number;

  /**
   * Floor for a caller-supplied `leaseSeconds`. A value below this is REJECTED with an
   * actionable error (never silently clamped — a silently-shortened lease is a lie about how
   * long you hold the task). `leaseSeconds: 0` would be instantly stealable, which is why a
   * floor is mandatory rather than advisory (SPEC §6.3 condition 3).
   *
   * env: MANDREL_TASK_CLAIM_MIN_LEASE_SECONDS
   */
  minLeaseSeconds: number;

  /**
   * Ceiling for a caller-supplied `leaseSeconds`. Bounds how long a crashed worker can hold
   * a task hostage before anyone can reclaim it. 24h.
   *
   * env: MANDREL_TASK_CLAIM_MAX_LEASE_SECONDS
   */
  maxLeaseSeconds: number;

  /**
   * The DEFAULT `allowedStatuses` for a fresh claim (SPEC D1 — the status guard is MANDATORY
   * and its default is the only status a task can be claimed FROM). Without this guard the
   * claim predicate passes on every unarchived task — including completed and cancelled ones
   * — and the SET clause then forces status='in_progress', SILENTLY RESURRECTING FINISHED
   * WORK. That was the worst defect in the spec's v0 draft; do not widen this casually.
   *
   * env: MANDREL_TASK_CLAIM_ALLOWED_STATUSES (comma-separated)
   */
  defaultAllowedStatuses: string[];

  /**
   * THE CEILING: the maximal set of statuses a claim may EVER match, whether
   * the caller took the default or passed its own `allowedStatuses`. `allowedStatuses` may
   * NARROW within this set; it can never WIDEN past it — a caller naming a status outside this
   * list (e.g. 'completed') gets it silently dropped from the effective guard, never honoured.
   *
   * WHY THIS EXISTS: before it did, `defaultAllowedStatuses` (['todo']) was safe only because
   * nobody widened it past a terminal status, but `allowedStatuses` was passed to CLAIM_SQL
   * completely unchecked — a caller could simply NAME 'completed' or 'cancelled' and the D1
   * guard passed on a finished task, silently resurrecting it (measured on prod 2026-09-19).
   * The refusal hint at routes/tasks.routes.ts:165 ("a completed/cancelled
   * task is NOT re-opened by a claim") was FALSE for any caller who named the terminal status.
   *
   * BOTH the default path and the allowedStatuses path filter through THIS ONE constant
   * (services/taskClaim.ts `claim()`) rather than each carrying its own literal list — that is
   * what keeps a future edit to either path from silently reintroducing the hole.
   *
   * env: MANDREL_TASK_CLAIM_CLAIMABLE_STATUSES (comma-separated)
   */
  claimableStatuses: string[];

  /**
   * The EXTRA statuses a RE-ENTRANT claim may claim from — i.e. a caller that presents the
   * claim_id it already holds (the idempotent-retry path, SPEC §8 case 7).
   *
   * WHY THIS EXISTS: a successful claim sets status='in_progress', so a retry with the same
   * token would be refused by the (mandatory) status guard whose default is ['todo'] — the
   * idempotent-retry requirement and the D1 status guard collide. Widening the guard ONLY for
   * a caller that already presents the matching server-minted token satisfies both: it can
   * never resurrect a completed/cancelled task (those are not in this list either), and it
   * cannot be reached by a caller that does not already hold the claim.
   *
   * env: MANDREL_TASK_CLAIM_REENTRY_STATUSES (comma-separated)
   */
  reentryStatuses: string[];

  /**
   * Statuses that END the work and therefore CLEAR the claim on a fenced holder write (SPEC
   * §6.6: "Completion is fenced — completing carries claimId and clears the claim on
   * success"). Without this, a finished task sits "held" until its lease expires, and the
   * zombie holder could still complete it — the exact 2026-07-11 double-build, reproduced by
   * the fix meant to prevent it. `cancelled` is included for the same reason: it is terminal.
   *
   * env: MANDREL_TASK_CLAIM_CLEARING_STATUSES (comma-separated)
   */
  clearingStatuses: string[];

  /**
   * Retention window for task_claim_events (SPEC §6.4). EVERY claim attempt writes a row, so
   * a hot contended board grows the table fast; this states the expectation up front so it is
   * a decision, not a surprise. Consumed by TaskClaimService.pruneEvents(); SCHEDULING that
   * sweep (timer/cron) is a named follow-up, deliberately out of scope for this task.
   *
   * env: MANDREL_TASK_CLAIM_EVENT_RETENTION_DAYS
   */
  eventRetentionDays: number;
}

export const TASK_CLAIM_CONFIG: TaskClaimConfig = {
  enabled: envBool('MANDREL_TASK_CLAIM_ENABLED', false),
  defaultLeaseSeconds: envInt('MANDREL_TASK_CLAIM_DEFAULT_LEASE_SECONDS', 2700),
  minLeaseSeconds: envInt('MANDREL_TASK_CLAIM_MIN_LEASE_SECONDS', 60),
  maxLeaseSeconds: envInt('MANDREL_TASK_CLAIM_MAX_LEASE_SECONDS', 86400),
  defaultAllowedStatuses: envList('MANDREL_TASK_CLAIM_ALLOWED_STATUSES', ['todo']),
  claimableStatuses: envList('MANDREL_TASK_CLAIM_CLAIMABLE_STATUSES', ['todo', 'in_progress', 'blocked']),
  reentryStatuses: envList('MANDREL_TASK_CLAIM_REENTRY_STATUSES', ['in_progress']),
  clearingStatuses: envList('MANDREL_TASK_CLAIM_CLEARING_STATUSES', ['completed', 'cancelled']),
  eventRetentionDays: envInt('MANDREL_TASK_CLAIM_EVENT_RETENTION_DAYS', 90),
};
