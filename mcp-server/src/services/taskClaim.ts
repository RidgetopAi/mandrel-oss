/**
 * TaskClaimService — the ATOMIC TASK CLAIM (SPEC v1).
 *
 * THE PROBLEM THIS EXISTS FOR: `task_update` is an unconditional last-writer-wins write whose
 * WHERE clause is `id` ONLY. A second worker that OBSERVES an active assignment can overwrite
 * it and both calls return success — so independent agents cannot safely coordinate THROUGH
 * Mandrel. This module is the compare-and-swap + lease that makes ownership real.
 *
 * THE FOUR LOAD-BEARING CORRECTNESS POINTS (each was a defect in the spec's v0 draft — do not
 * "simplify" any of them):
 *
 *   D1  THE STATUS GUARD IS MANDATORY. `AND status = ANY($allowedStatuses)` (default ['todo']).
 *       Every pre-existing row has claim_id IS NULL, so without it the predicate passes on
 *       EVERY unarchived task — including completed and cancelled ones — and the SET clause
 *       then forces status='in_progress', SILENTLY RESURRECTING FINISHED WORK.
 *
 *   D2  claim_id (SERVER-MINTED uuid) IS THE FENCING TOKEN; the actor is ATTRIBUTION ONLY.
 *       `assigned_to`/`claim_actor` is a free-form varchar with no FK and no registry, so
 *       keying exclusion on it means two workers sharing a name BOTH "hold" the claim —
 *       decorative for exactly the collision class this fixes. Re-entry, renewal, release and
 *       every fenced write require presenting the matching claim_id.
 *
 *   D3  THE LIFECYCLE IS FENCED END-TO-END (claim → renew → release/complete). Without it a
 *       finished task sits "held" until expiry AND an expired holder can still complete it via
 *       a plain update — the reclaiming worker and the zombie both ship (the 2026-07-11
 *       double-build, reproduced by the fix meant to prevent it).
 *
 *   D4  THE VERSION BUMP LIVES IN A DB TRIGGER (migration 067), never here. Ordinary
 *       task_update, the Command backend, and bulkUpdateTasks are all unguarded; a
 *       handler-side bump would make `expectedVersion` a lie.
 *
 * CONCURRENCY (auditor-verified safe under exactly these conditions):
 *   1. The claim is ONE statement — NEVER SELECT-then-UPDATE. Under READ COMMITTED two
 *      concurrent single-statement UPDATEs serialize on the row lock and the loser
 *      re-evaluates the predicate against the winner's COMMITTED row (EvalPlanQual), so it
 *      sees the fresh claim_expires_at and matches 0 rows. Two workers therefore cannot both
 *      win an expired claim.
 *   2. Isolation is PINNED to READ COMMITTED on the claim transaction (under REPEATABLE READ
 *      the loser would get a serialization ERROR instead of a clean rowCount 0).
 *   3. leaseSeconds is validated server-side against the config floor/ceiling — a 0-second
 *      lease is instantly stealable.
 *
 * AUDIT (SPEC §6.4): the WINNER event is written INSIDE the claim transaction — if the audit
 * insert fails, the claim ROLLS BACK. This DELIBERATELY INVERTS the house error-swallowing
 * stance (ActivityRepo returns null on failure) because audit-with-CAS is the whole reason
 * this exists: an unauditable claim is not a claim. Loser/observability events are
 * best-effort — losing one to a crash is acceptable.
 */

import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

import { db } from '../config/database.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { logger } from '../utils/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * Vocabulary + types
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The audit event vocabulary — the SINGLE source of the `task_claim_events.event_type`
 * values. Deliberately NOT a DB CHECK constraint: adding an event type must never require a
 * migration across the tenant fleet.
 */
export const TASK_CLAIM_EVENT = {
  /** A fresh claim was won (the winner event — written inside the claim transaction). */
  won: 'claim_won',
  /** A holder re-presented its own claim_id and the claim was re-affirmed (idempotent retry). */
  reentered: 'claim_reentered',
  /** A claim attempt was refused; `reason` carries the typed conflict. */
  rejected: 'claim_rejected',
  /** A lease was extended — explicitly via `renew`, or implicitly by a fenced holder write. */
  renewed: 'claim_renewed',
  /** A renew was refused (typically claim-lost). */
  renewRejected: 'renew_rejected',
  /** A claim was released by its holder. */
  released: 'claim_released',
  /** A release was refused (typically claim-lost). */
  releaseRejected: 'release_rejected',
  /** An ordinary write was refused by the claim fence (no/invalid token against a claim). */
  fenceRejected: 'fence_rejected',
  /** An ordinary write deliberately overrode a live claim via force:true (the human escape hatch). */
  forceOverride: 'force_override',
  /** The claim was cleared because the task reached a terminal status (fenced completion). */
  cleared: 'claim_cleared',
} as const;

export type TaskClaimEventType = (typeof TASK_CLAIM_EVENT)[keyof typeof TASK_CLAIM_EVENT];

/** Coarse outcome, for cheap aggregate reads over the audit. */
export type ClaimOutcome = 'won' | 'rejected' | 'ok';

/**
 * The typed conflict vocabulary returned to the caller (SPEC §6.1). A claim/renew/release
 * NEVER fails with a bare boolean — the caller is told exactly why, so it can decide between
 * backing off, re-claiming, and giving up.
 */
export type ClaimConflictReason =
  /** Someone else holds a LIVE claim (or you presented no token for one). */
  | 'held'
  /** The task's status is not in allowedStatuses (the D1 guard) — e.g. already completed. */
  | 'wrong-status'
  /** The task is soft-deleted (archived_at IS NOT NULL). */
  | 'archived'
  /** expectedVersion did not match — the row changed underneath you. */
  | 'version-stale'
  /** No such task in this project. */
  | 'not-found'
  /** You presented a claim_id that is no longer the live claim (released, superseded, or never real). */
  | 'claim-lost'
  /**
   * A LIVE claim exists and the claim_id you presented is not it. Distinct
   * from `claim-lost`: someone else provably owns the task RIGHT NOW, so "re-claim" is not
   * actionable — waiting for the lease or force:true is.
   */
  | 'claim-mismatch'
  /**
   * The claim your token names is still ON the row but its lease has EXPIRED.
   * Distinguishable from `claim-lost` because the row still carries your token: nobody took
   * over, your lease simply ran out. Re-claiming (allowedStatuses widened) is the fix.
   */
  | 'claim-expired'
  /** The claim feature is switched off in this environment (MANDREL_TASK_CLAIM_ENABLED). */
  | 'disabled'
  /** leaseSeconds outside the configured floor/ceiling. */
  | 'lease-out-of-bounds'
  /** The row changed between the guarded UPDATE and the diagnostic probe — retry. */
  | 'conflict';

export interface ClaimGranted {
  claimed: true;
  taskId: string;
  /** THE FENCING TOKEN. Present this on renew/release and on every task_update while you hold the claim. */
  claimId: string;
  /** Attribution only — never the lock key. */
  actor: string;
  version: number;
  status: string;
  expiresAt: string;
  leaseSeconds: number;
  /** True when this was an idempotent re-entry (same token) rather than a fresh acquisition. */
  reentered: boolean;
}

export interface ClaimRefused {
  claimed: false;
  taskId: string;
  reason: ClaimConflictReason;
  message: string;
  currentAssignee?: string | null;
  currentActor?: string | null;
  currentStatus?: string | null;
  currentVersion?: number | null;
  expiresAt?: string | null;
}

export type ClaimResult = ClaimGranted | ClaimRefused;

export interface ClaimReleased {
  released: true;
  taskId: string;
  claimId: string;
  version: number;
}

export type ReleaseResult = ClaimReleased | ClaimRefused;

/** The live/absent claim state of a row, as read by the diagnostic probe. */
export interface TaskProbe {
  found: boolean;
  id?: string;
  projectId?: string;
  status?: string;
  version?: number;
  assignedTo?: string | null;
  claimId?: string | null;
  claimActor?: string | null;
  claimExpiresAt?: Date | null;
  archivedAt?: Date | null;
  /** claim_id IS NOT NULL AND claim_expires_at > now() — evaluated by the DB, not the app clock. */
  claimLive?: boolean;
}

/** The typed refusals an ordinary fenced write can produce (see fenceRejection for the map). */
export type FenceRejectionReason = Extract<
  ClaimConflictReason,
  'held' | 'claim-lost' | 'claim-mismatch' | 'claim-expired'
>;

/**
 * Thrown when an ordinary write (task_update / task_delete / task_bulk_update) is refused by
 * the claim fence (SPEC §6.5, widened by an earlier task). Carries the typed reason + the
 * holder so the route can render an ACTIONABLE error that points the caller at `claim`.
 *
 * The four reasons, and what each tells the caller to DO:
 *   held           — a live claim exists and you presented NO token. Claim it, or force.
 *   claim-mismatch — a live claim exists and your token is NOT it. Someone else owns the task
 *                    right now; wait for the lease, or force.
 *   claim-expired  — your token is still on the row but its lease ran out. Nobody took over;
 *                    re-claim (allowedStatuses: ['todo','in_progress']) to continue.
 *   claim-lost     — no live claim matches your token and the row does not carry it (released,
 *                    superseded, or never real). Re-claim before writing.
 */
export class TaskClaimFencedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: FenceRejectionReason,
    public readonly holder: string | null,
    public readonly expiresAt: Date | null,
    public readonly presentedClaimId?: string,
  ) {
    super(TaskClaimFencedError.messageFor(taskId, reason, holder, expiresAt));
    this.name = 'TaskClaimFencedError';
  }

  private static messageFor(
    taskId: string,
    reason: FenceRejectionReason,
    holder: string | null,
    expiresAt: Date | null,
  ): string {
    const until = expiresAt ? ` until ${expiresAt.toISOString()}` : '';
    switch (reason) {
      case 'claim-mismatch':
        return (
          `Claim mismatch on task ${taskId}: a LIVE claim held by '${holder ?? 'unknown'}'${until} ` +
          `exists and the claimId you presented is not it. Nothing was changed. Wait for the ` +
          `lease, have the holder release it, or override deliberately with force:true (audited).`
        );
      case 'claim-expired':
        return (
          `Claim expired on task ${taskId}: the claimId you presented is still on the row but its ` +
          `lease has run out, so it is no longer ownership. Nothing was changed. Re-claim the task ` +
          `(task claim, allowedStatuses widened to its current status) to continue.`
        );
      case 'claim-lost':
        return (
          `Claim lost on task ${taskId}: the claimId you presented does not match any claim on this ` +
          `task (it was released, superseded, or never issued for it). Nothing was changed. ` +
          `Re-claim before writing.`
        );
      case 'held':
      default:
        return (
          `Task ${taskId} is claimed by '${holder ?? 'unknown'}'${until}. While a claim is LIVE, ` +
          `EVERY task_update write is fenced — acquire the claim first, or pass the claimId you hold.`
        );
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * SQL
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE CLAIM STATEMENT (SPEC §6.3) — ONE statement, never SELECT-then-UPDATE.
 *
 * Params:
 *   $1 taskId · $2 projectId · $3 freshClaimId (ALWAYS a server-minted uuid) · $4 actor ·
 *   $5 leaseSeconds · $6 allowedStatuses (text[]) · $7 presentedClaimId (re-entry, nullable) ·
 *   $8 expectedVersion (nullable) · $9 reentryStatuses (text[])
 *
 * THE TOKEN IS SERVER-MINTED, AND SQL — NOT THE CALLER — DECIDES THAT (SPEC §6.2).
 * $3 is a fresh uuid on EVERY call; $7 (whatever the caller presented) appears ONLY inside
 * predicates, never as a value that can be written. The `CASE` keeps the existing token if
 * and only if the presented one MATCHES a LIVE claim on this row — i.e. re-entry by the real
 * holder. Everything else (no token, a forged token, a token against an unclaimed or expired
 * row) writes $3. A caller therefore cannot PIN the row's lock key to a value it chose:
 * gating on the PRESENCE of a token instead of its MATCH is exactly the D2 decorative-lock
 * failure in a new costume (two workers deriving the same constant would both "hold" it).
 *
 * SAME RULE FOR THE STATUS GUARD. The D1 guard ($6) is mandatory; the re-entry widening ($9)
 * is a SECOND disjunct that carries the full `claim_id = $7 AND claim_expires_at > now()`
 * match with it — so `reentryStatuses` is unreachable by a caller that does not already hold
 * the live claim, which is precisely what claimConfig.reentryStatuses claims. It still cannot
 * reach a terminal status: completed/cancelled are in neither list.
 *
 * NOTE ON `claim_expires_at <= now()` (the spec's prose writes `<`): "expired" here and
 * "live" (`> now()`) in the fence predicates are exact complements, so the instant a lease
 * lands exactly on now() belongs to exactly one of them. With `<` that instant would be
 * NEITHER claimable nor writable — a one-microsecond hole. Same semantics, no gap.
 */
const CLAIM_SQL = `
UPDATE tasks
   SET claim_id = CASE
                    WHEN claim_id = $7::uuid AND claim_expires_at > now() THEN claim_id
                    ELSE $3::uuid
                  END,
       claim_actor = $4,
       claim_expires_at = now() + ($5::int || ' seconds')::interval,
       status = 'in_progress',
       assigned_to = $4,
       started_at = COALESCE(started_at, now())
 WHERE id = $1::uuid
   AND project_id = $2::uuid
   AND archived_at IS NULL
   AND (
         status = ANY($6::text[])
         OR (claim_id = $7::uuid AND claim_expires_at > now() AND status = ANY($9::text[]))
       )
   AND (
         claim_id IS NULL
         OR claim_expires_at <= now()
         OR (claim_id = $7::uuid AND claim_expires_at > now())
       )
   AND ($8::int IS NULL OR version = $8::int)
RETURNING id::text AS id, version, claim_id::text AS claim_id, claim_actor,
          claim_expires_at, status
`;

/** Extend a LIVE claim you hold. Requires the matching token AND an un-expired lease. */
const RENEW_SQL = `
UPDATE tasks
   SET claim_expires_at = now() + ($4::int || ' seconds')::interval
 WHERE id = $1::uuid
   AND project_id = $2::uuid
   AND archived_at IS NULL
   AND claim_id = $3::uuid
   AND claim_expires_at > now()
RETURNING id::text AS id, version, claim_id::text AS claim_id, claim_actor,
          claim_expires_at, status
`;

/**
 * Release a claim you hold. Deliberately does NOT require the lease to still be live: if the
 * token still matches, nobody else has taken over, so letting the (possibly late) holder clean
 * up is strictly better than leaving a dead claim on the row. If someone DID take over, the
 * token no longer matches and this is a typed claim-lost.
 *
 * STATUS IS DELIBERATELY LEFT ALONE (it stays `in_progress`, since claiming set it there).
 * Release gives back OWNERSHIP, it does not roll back the work's lifecycle state — guessing
 * a status to revert to would silently rewrite history the holder may have advanced. The
 * consequence the next worker sees: a released task is `in_progress`, so a default claim
 * (`allowedStatuses: ['todo']`) returns `wrong-status` — reclaim it with
 * `allowedStatuses: ['todo','in_progress']`, or set the status back explicitly before
 * releasing. This is stated in the task_release examples (handlers/navigation.ts).
 */
const RELEASE_SQL = `
UPDATE tasks
   SET claim_id = NULL, claim_actor = NULL, claim_expires_at = NULL
 WHERE id = $1::uuid
   AND project_id = $2::uuid
   AND claim_id = $3::uuid
RETURNING id::text AS id, version, claim_actor, status
`;

const PROBE_SQL = `
SELECT id::text AS id, project_id::text AS project_id, status, version, assigned_to,
       claim_id::text AS claim_id, claim_actor, claim_expires_at, archived_at,
       (claim_id IS NOT NULL AND claim_expires_at > now()) AS claim_live
  FROM tasks
 WHERE id = $1::uuid
`;

const EVENT_INSERT_SQL = `
INSERT INTO task_claim_events
  (task_id, project_id, event_type, outcome, actor, claim_id, previous_claim_id,
   old_version, new_version, reason, lease_seconds, expires_at, metadata)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9, $10, $11, $12, $13::jsonb)
RETURNING id::text AS id
`;

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * Claim-fence predicate (SPEC §6.5, widened by an earlier task) — shared by task_update /
 * bulk / archive
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Build the WHERE fragment that fences an ordinary task write.
 *
 * POPULATION: this fences EVERY mutating write, not a curated field list.
 * The first build fenced only `status`/`assignedTo` ("ownership fields") and that shape was
 * the hole: a caller carrying a FORGED claimId that touched only `progress`/`metadata` was
 * accepted and persisted during someone else's live claim, and an invalid token on an
 * unclaimed task was silently ignored. A field list is a population the next field addition
 * silently escapes (CLASSES.md C3); the whole statement is the choke point, so the whole
 * statement is fenced. There is deliberately NO `touchesOwnership()` predicate anymore.
 *
 *   • token presented → `claim_id = $n AND claim_expires_at > now()`. The token is an
 *     OWNERSHIP ASSERTION and is validated on every write regardless of fields: you must
 *     hold the LIVE claim it names. A stale token is how a mid-flight worker DISCOVERS it
 *     lost (SPEC §6.6 — we cannot interrupt it, only refuse its late writes).
 *   • no token        → `(claim_id IS NULL OR claim_expires_at <= now())`. A live claim
 *     blocks the write; a dead one does not (an expired lease is not ownership).
 *
 * BEARER POLICY — DECIDED, do not relitigate (an earlier task pin; b3bfd5f3 accepted residual):
 * the claim token is a BEARER SECRET. A VALID token presented by a DIFFERENT resolved actor
 * IS authorized — the actor string is attribution, never the lock key (D2: binding exclusion
 * to a free-form varchar with no registry is a decorative lock; two workers sharing a name
 * would both "hold" it). Token secrecy is enforced where it belongs: no read surface
 * publishes it (mapTask, case 4b).
 *
 * The fence is a PREDICATE ON THE SAME SINGLE UPDATE (conditional mutation, never
 * check-then-update): zero rows updated ⇒ zero mutation, and the typed classification
 * happens on a follow-up read (fenceRejection). Returns an empty clause when fencing does
 * not apply, so the caller's SQL is byte-identical to today's whenever the feature is off —
 * the Lesson-025 "legacy == today" invariant.
 */
export function claimFenceClause(
  opts: { claimId?: string; force?: boolean },
  nextParamIndex: number,
): { clause: string; params: any[] } {
  if (!TASK_CLAIM_CONFIG.enabled || opts.force) return { clause: '', params: [] };
  if (opts.claimId) {
    return {
      clause: ` AND claim_id = $${nextParamIndex}::uuid AND claim_expires_at > now()`,
      params: [opts.claimId],
    };
  }
  return { clause: ' AND (claim_id IS NULL OR claim_expires_at <= now())', params: [] };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * Service
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

class TaskClaimServiceImpl {
  constructor(private pool: Pool = db) {}

  /* ── helpers ──────────────────────────────────────────────────────────────────────── */

  /** Read the row's claim/status state for a typed conflict answer. */
  async probe(taskId: string, executor: Pool | PoolClient = this.pool): Promise<TaskProbe> {
    const r = await executor.query(PROBE_SQL, [taskId]);
    if (r.rows.length === 0) return { found: false };
    const row = r.rows[0];
    return {
      found: true,
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      version: row.version,
      assignedTo: row.assigned_to,
      claimId: row.claim_id,
      claimActor: row.claim_actor,
      claimExpiresAt: row.claim_expires_at,
      archivedAt: row.archived_at,
      claimLive: row.claim_live,
    };
  }

  /**
   * Insert an audit event. THROWS on failure — the caller decides whether that is fatal.
   * The claim WINNER path lets it throw inside the transaction (audit failure ⇒ the claim
   * rolls back, SPEC §6.4); every other caller wraps it in `recordEventBestEffort`.
   */
  async recordEvent(
    executor: Pool | PoolClient,
    e: {
      taskId: string;
      projectId?: string | null;
      eventType: TaskClaimEventType;
      outcome: ClaimOutcome;
      actor?: string | null;
      claimId?: string | null;
      previousClaimId?: string | null;
      oldVersion?: number | null;
      newVersion?: number | null;
      reason?: ClaimConflictReason | null;
      leaseSeconds?: number | null;
      expiresAt?: Date | string | null;
      metadata?: Record<string, any>;
    },
  ): Promise<string> {
    const r = await executor.query(EVENT_INSERT_SQL, [
      e.taskId,
      e.projectId ?? null,
      e.eventType,
      e.outcome,
      e.actor ?? null,
      e.claimId ?? null,
      e.previousClaimId ?? null,
      e.oldVersion ?? null,
      e.newVersion ?? null,
      e.reason ?? null,
      e.leaseSeconds ?? null,
      e.expiresAt ?? null,
      JSON.stringify(e.metadata ?? {}),
    ]);
    return r.rows[0].id;
  }

  /**
   * Observability-grade audit write: losers, fence rejections, force overrides. Failure is
   * logged and swallowed — losing one of these to a crash is acceptable, and an audit hiccup
   * must never break the caller's operation (the house ActivityRepo stance). The WINNER event
   * deliberately does NOT use this path.
   */
  private async recordEventBestEffort(
    executor: Pool | PoolClient,
    e: Parameters<TaskClaimServiceImpl['recordEvent']>[1],
  ): Promise<void> {
    try {
      await this.recordEvent(executor, e);
    } catch (error) {
      logger.error(
        'Failed to record task claim event',
        error instanceof Error ? error : new Error('Unknown error'),
        { component: 'TaskClaimService', operation: 'recordEvent', metadata: { taskId: e.taskId, eventType: e.eventType } },
      );
    }
  }

  /** A typed refusal built from a probe (the shared shape of every conflict answer). */
  private refuse(taskId: string, reason: ClaimConflictReason, message: string, p?: TaskProbe): ClaimRefused {
    return {
      claimed: false,
      taskId,
      reason,
      message,
      currentAssignee: p?.assignedTo ?? null,
      currentActor: p?.claimActor ?? null,
      currentStatus: p?.status ?? null,
      currentVersion: p?.version ?? null,
      expiresAt: p?.claimExpiresAt ? new Date(p.claimExpiresAt).toISOString() : null,
    };
  }

  /**
   * Classify WHY a guarded claim matched 0 rows. Order is deliberate: the most specific and
   * most actionable answer first. `held` outranks `wrong-status` because a task the winner
   * just claimed is BOTH in_progress and held — and "someone holds it" is the useful answer.
   */
  private classifyClaimConflict(
    taskId: string,
    projectId: string,
    p: TaskProbe,
    allowedStatuses: string[],
    expectedClaimId?: string,
    expectedVersion?: number,
  ): ClaimRefused {
    if (!p.found || p.projectId !== projectId) {
      return this.refuse(taskId, 'not-found', `No task ${taskId} in this project.`);
    }
    if (p.archivedAt) {
      return this.refuse(taskId, 'archived', `Task ${taskId} is archived (soft-deleted) and cannot be claimed. Restore it first.`, p);
    }
    if (p.claimLive && p.claimId !== expectedClaimId) {
      return this.refuse(
        taskId,
        'held',
        `Task ${taskId} is already claimed by '${p.claimActor ?? 'unknown'}'` +
          (p.claimExpiresAt ? ` until ${new Date(p.claimExpiresAt).toISOString()}` : '') + '.',
        p,
      );
    }
    if (!allowedStatuses.includes(String(p.status))) {
      return this.refuse(
        taskId,
        'wrong-status',
        `Task ${taskId} has status '${p.status}', which is not claimable ` +
          `(allowed: ${allowedStatuses.join(', ')}). A completed or cancelled task is NOT re-opened by a claim.`,
        p,
      );
    }
    if (expectedVersion !== undefined && p.version !== expectedVersion) {
      return this.refuse(
        taskId,
        'version-stale',
        `Task ${taskId} is at version ${p.version}, not the expected ${expectedVersion} — it changed underneath you. Re-read and retry.`,
        p,
      );
    }
    // The row satisfied every condition by the time we probed — it changed in between (e.g.
    // the winner released instantly). Honest answer: a retryable conflict, not a fake success.
    return this.refuse(taskId, 'conflict', `Task ${taskId} changed while the claim was being evaluated. Retry.`, p);
  }

  /** Validate leaseSeconds against the configured floor/ceiling (SPEC §6.3 condition 3). */
  private resolveLease(leaseSeconds?: number): { ok: true; lease: number } | { ok: false; message: string } {
    const cfg = TASK_CLAIM_CONFIG;
    if (leaseSeconds === undefined) return { ok: true, lease: cfg.defaultLeaseSeconds };
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < cfg.minLeaseSeconds || leaseSeconds > cfg.maxLeaseSeconds) {
      return {
        ok: false,
        message:
          `leaseSeconds must be an integer between ${cfg.minLeaseSeconds} and ${cfg.maxLeaseSeconds} ` +
          `(got ${leaseSeconds}). A 0-second lease would be instantly stealable, which is why this is ` +
          `rejected rather than silently clamped.`,
      };
    }
    return { ok: true, lease: leaseSeconds };
  }

  private disabled(taskId: string): ClaimRefused {
    return this.refuse(
      taskId,
      'disabled',
      'Task claiming is disabled in this environment (MANDREL_TASK_CLAIM_ENABLED=false). ' +
        'Nothing was changed. Enable the flag to use claim/renew/release.',
    );
  }

  /* ── claim ────────────────────────────────────────────────────────────────────────── */

  /**
   * Acquire (or idempotently re-affirm) the claim on a task.
   *
   * @param claimId  OPTIONAL — the token you ALREADY hold, for an idempotent retry. It is a
   *                 PREDICATE OPERAND ONLY: presenting it can re-affirm the claim it matches
   *                 (so a retry never mints a second token for the same work), but it is never
   *                 written as the row's token and presenting a non-matching one buys nothing
   *                 — not a chosen lock key, not the re-entry status widening.
   */
  async claim(args: {
    taskId: string;
    projectId: string;
    actor: string;
    allowedStatuses?: string[];
    expectedVersion?: number;
    leaseSeconds?: number;
    claimId?: string;
  }): Promise<ClaimResult> {
    const { taskId, projectId, actor } = args;
    if (!TASK_CLAIM_CONFIG.enabled) return this.disabled(taskId);

    const lease = this.resolveLease(args.leaseSeconds);
    if (!lease.ok) return this.refuse(taskId, 'lease-out-of-bounds', lease.message);

    // D1 — the status guard. The caller may widen it, but it is NEVER absent, and it can never
    // widen PAST claimConfig.claimableStatuses (the ceiling): a caller naming a
    // terminal status here is silently dropped, never honoured. Both the default and the
    // caller-supplied list are filtered through THIS SAME constant so neither path can carry
    // its own drifting literal — that divergence is exactly what let a caller resurrect a
    // completed task by simply naming it (measured on prod 2026-09-19).
    const requested = args.allowedStatuses?.length ? args.allowedStatuses : TASK_CLAIM_CONFIG.defaultAllowedStatuses;
    const ceiling = TASK_CLAIM_CONFIG.claimableStatuses;
    // RE-ENTRY (SPEC §8 case 7 vs D1): a successful claim sets status='in_progress', so an
    // idempotent retry would be refused by the default ['todo'] guard. The extra statuses are
    // handed to SQL as a SEPARATE list ($9), never merged in here: merging would widen the
    // guard for anyone who merely ATTACHES a token, and the widening must be gated on the
    // token MATCHING a live claim (the CLAIM_SQL predicate does that gating). Passing them
    // separately is what keeps `reentryStatuses` unreachable without holding the claim.
    const reentryStatuses = [...TASK_CLAIM_CONFIG.reentryStatuses];
    const allowedStatuses = requested.filter((s) => ceiling.includes(s));

    // THE TOKEN TO MINT — always fresh, always server-side. It is a CANDIDATE, not a verdict:
    // CLAIM_SQL's CASE writes it only when this is NOT a live-claim re-entry. A client-supplied
    // token can never be written (it is a predicate operand only) — a client-chosen fencing
    // token is a forgeable lock.
    const freshToken = randomUUID();

    const client = await this.pool.connect();
    try {
      // Isolation PINNED (SPEC §6.3 condition 2): under REPEATABLE READ the loser of a race
      // gets a serialization ERROR instead of a clean rowCount 0.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

      // Read the pre-image for the audit's old_version / previous_claim_id. This is a
      // DIAGNOSTIC read only — it is NOT part of the decision (the decision is the single
      // guarded UPDATE below), so it cannot reintroduce a check-then-act race.
      const before = await this.probe(taskId, client);

      const res = await client.query(CLAIM_SQL, [
        taskId,
        projectId,
        freshToken,
        actor,
        lease.lease,
        allowedStatuses,
        args.claimId ?? null,
        args.expectedVersion ?? null,
        reentryStatuses,
      ]);

      if (res.rowCount === 1) {
        const row = res.rows[0];
        // RE-ENTRY IS WHAT THE DATABASE DECIDED, not what the caller asserted: the row kept the
        // presented token, so the CASE matched a LIVE claim held by this caller. Deriving it
        // from the pre-image + the mere PRESENCE of args.claimId would report a fresh
        // acquisition-with-a-token as a re-entry.
        const reentered = Boolean(args.claimId && row.claim_id === args.claimId);
        // WINNER EVENT — INSIDE the transaction, NOT swallowed. If this throws, the catch
        // below rolls the claim back: an unauditable claim is not a claim (SPEC §6.4).
        await this.recordEvent(client, {
          taskId,
          projectId,
          eventType: reentered ? TASK_CLAIM_EVENT.reentered : TASK_CLAIM_EVENT.won,
          outcome: 'won',
          actor,
          claimId: row.claim_id,
          previousClaimId: before.claimId ?? null,
          oldVersion: before.version ?? null,
          newVersion: row.version,
          leaseSeconds: lease.lease,
          expiresAt: row.claim_expires_at,
          metadata: {
            allowedStatuses,
            reentryStatuses,
            previousStatus: before.status ?? null,
            expectedVersion: args.expectedVersion ?? null,
          },
        });
        await client.query('COMMIT');
        return {
          claimed: true,
          taskId: row.id,
          claimId: row.claim_id,
          actor: row.claim_actor,
          version: row.version,
          status: row.status,
          expiresAt: new Date(row.claim_expires_at).toISOString(),
          leaseSeconds: lease.lease,
          reentered,
        };
      }

      // Loser: nothing was written, so end the transaction before the diagnostic probe.
      await client.query('ROLLBACK');
      const after = await this.probe(taskId, client);
      // The statuses this caller was ACTUALLY allowed to claim from — the re-entry widening
      // only applied if it really held the live claim, so the refusal message must not promise
      // a widening the predicate never granted it.
      const effectiveAllowed =
        args.claimId && after.claimLive && after.claimId === args.claimId
          ? Array.from(new Set([...allowedStatuses, ...reentryStatuses]))
          : allowedStatuses;
      const refusal = this.classifyClaimConflict(taskId, projectId, after, effectiveAllowed, args.claimId, args.expectedVersion);
      // Loser events are best-effort observability (SPEC §6.4).
      await this.recordEventBestEffort(client, {
        taskId,
        projectId,
        eventType: TASK_CLAIM_EVENT.rejected,
        outcome: 'rejected',
        actor,
        claimId: args.claimId ?? null,
        previousClaimId: after.claimId ?? null,
        oldVersion: after.version ?? null,
        newVersion: after.version ?? null,
        reason: refusal.reason,
        leaseSeconds: lease.lease,
        expiresAt: after.claimExpiresAt ?? null,
        metadata: { allowedStatuses: effectiveAllowed, expectedVersion: args.expectedVersion ?? null },
      });
      return refusal;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the transaction is already gone — nothing to undo */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /* ── renew ────────────────────────────────────────────────────────────────────────── */

  /** Extend the lease on a claim you hold. Typed `claim-lost` when the token no longer matches. */
  async renew(args: { taskId: string; projectId: string; claimId: string; leaseSeconds?: number }): Promise<ClaimResult> {
    const { taskId, projectId, claimId } = args;
    if (!TASK_CLAIM_CONFIG.enabled) return this.disabled(taskId);

    const lease = this.resolveLease(args.leaseSeconds);
    if (!lease.ok) return this.refuse(taskId, 'lease-out-of-bounds', lease.message);

    const res = await this.pool.query(RENEW_SQL, [taskId, projectId, claimId, lease.lease]);
    if (res.rowCount === 1) {
      const row = res.rows[0];
      await this.recordEventBestEffort(this.pool, {
        taskId,
        projectId,
        eventType: TASK_CLAIM_EVENT.renewed,
        outcome: 'ok',
        actor: row.claim_actor,
        claimId: row.claim_id,
        previousClaimId: row.claim_id,
        newVersion: row.version,
        leaseSeconds: lease.lease,
        expiresAt: row.claim_expires_at,
        metadata: { via: 'renew' },
      });
      return {
        claimed: true,
        taskId: row.id,
        claimId: row.claim_id,
        actor: row.claim_actor,
        version: row.version,
        status: row.status,
        expiresAt: new Date(row.claim_expires_at).toISOString(),
        leaseSeconds: lease.lease,
        reentered: true,
      };
    }

    const p = await this.probe(taskId);
    const refusal = this.classifyLifecycleConflict(taskId, projectId, p, claimId);
    await this.recordEventBestEffort(this.pool, {
      taskId,
      projectId,
      eventType: TASK_CLAIM_EVENT.renewRejected,
      outcome: 'rejected',
      claimId,
      previousClaimId: p.claimId ?? null,
      newVersion: p.version ?? null,
      reason: refusal.reason,
      metadata: { via: 'renew' },
    });
    return refusal;
  }

  /* ── release ──────────────────────────────────────────────────────────────────────── */

  /** Give the claim back. Typed `claim-lost` when the token no longer matches. */
  async release(args: { taskId: string; projectId: string; claimId: string }): Promise<ReleaseResult> {
    const { taskId, projectId, claimId } = args;
    if (!TASK_CLAIM_CONFIG.enabled) return this.disabled(taskId);

    const res = await this.pool.query(RELEASE_SQL, [taskId, projectId, claimId]);
    if (res.rowCount === 1) {
      const row = res.rows[0];
      await this.recordEventBestEffort(this.pool, {
        taskId,
        projectId,
        eventType: TASK_CLAIM_EVENT.released,
        outcome: 'ok',
        actor: row.claim_actor,
        claimId,
        previousClaimId: claimId,
        newVersion: row.version,
        metadata: { statusAtRelease: row.status },
      });
      return { released: true, taskId: row.id, claimId, version: row.version };
    }

    const p = await this.probe(taskId);
    const refusal = this.classifyLifecycleConflict(taskId, projectId, p, claimId);
    await this.recordEventBestEffort(this.pool, {
      taskId,
      projectId,
      eventType: TASK_CLAIM_EVENT.releaseRejected,
      outcome: 'rejected',
      claimId,
      previousClaimId: p.claimId ?? null,
      newVersion: p.version ?? null,
      reason: refusal.reason,
      metadata: { via: 'release' },
    });
    return refusal;
  }

  /** Shared conflict classification for renew/release (both key on "do you still hold it?"). */
  private classifyLifecycleConflict(taskId: string, projectId: string, p: TaskProbe, claimId: string): ClaimRefused {
    if (!p.found || p.projectId !== projectId) {
      return this.refuse(taskId, 'not-found', `No task ${taskId} in this project.`);
    }
    if (p.archivedAt) {
      return this.refuse(taskId, 'archived', `Task ${taskId} is archived (soft-deleted).`, p);
    }
    return this.refuse(
      taskId,
      'claim-lost',
      `Claim lost on task ${taskId}: '${claimId}' is no longer the live claim ` +
        (p.claimLive ? `(it is now held by '${p.claimActor ?? 'unknown'}').` : '(it expired or was released).') +
        ' Re-claim before continuing.',
      p,
    );
  }

  /* ── fence support for the ordinary write paths ───────────────────────────────────── */

  /**
   * Turn "the guarded write matched 0 rows" into the right typed failure. Returns null when
   * the row genuinely does not exist (the caller raises its own not-found, preserving
   * today's contract).
   *
   * CLASSIFICATION — read from the row's post-hoc state, most specific first:
   *   no token,   live claim          → held            (you never asserted ownership)
   *   token,      live claim ≠ token  → claim-mismatch  (someone else provably owns it NOW)
   *   token,      dead claim = token  → claim-expired   (your own lease ran out; nobody took over)
   *   token,      anything else       → claim-lost      (released / superseded / never issued)
   * The residual no-token/no-live-claim combination (the claim died between the UPDATE and
   * this probe) stays `held` — the refusal happened because a claim was live at write time,
   * and that is the honest thing to tell the caller.
   */
  async fenceRejection(
    taskId: string,
    presentedClaimId: string | undefined,
    executor: Pool | PoolClient = this.pool,
    via: string = 'task_update',
  ): Promise<TaskClaimFencedError | null> {
    const p = await this.probe(taskId, executor);
    if (!p.found) return null;
    let reason: FenceRejectionReason;
    if (!presentedClaimId) {
      reason = 'held';
    } else if (p.claimLive) {
      reason = 'claim-mismatch';
    } else if (p.claimId === presentedClaimId) {
      reason = 'claim-expired';
    } else {
      reason = 'claim-lost';
    }
    const err = new TaskClaimFencedError(
      taskId,
      reason,
      p.claimActor ?? null,
      p.claimExpiresAt ? new Date(p.claimExpiresAt) : null,
      presentedClaimId,
    );
    // A refused token is at minimum a stale worker and at worst a FORGERY ATTEMPT — surface
    // it in the log with the tool + task, never silently (an earlier task item 6; the full
    // audit surface is a separate task). The token VALUE is deliberately not logged.
    if (presentedClaimId) {
      logger.warn(`Task claim fence rejected a presented claimId (${reason})`, {
        component: 'TaskClaimService',
        operation: 'fenceRejection',
        metadata: { taskId, via, reason, holder: p.claimActor ?? null, claimLive: p.claimLive ?? false },
      });
    }
    await this.recordEventBestEffort(executor, {
      taskId,
      projectId: p.projectId ?? null,
      eventType: TASK_CLAIM_EVENT.fenceRejected,
      outcome: 'rejected',
      actor: p.claimActor ?? null,
      claimId: presentedClaimId ?? null,
      previousClaimId: p.claimId ?? null,
      newVersion: p.version ?? null,
      reason,
      expiresAt: p.claimExpiresAt ?? null,
      metadata: { via },
    });
    return err;
  }

  /**
   * Audit a deliberate `force: true` override of a live claim (the human escape hatch).
   *
   * Takes the PRE-IMAGE (probed BEFORE the write) rather than probing itself: by the time the
   * override has committed, the claim it overrode may be gone, and an audit that reads the
   * post-image would record "nothing was overridden" for exactly the event we most need.
   */
  async recordForceOverride(
    taskId: string,
    via: string,
    actor: string | undefined,
    preImage: TaskProbe,
    executor: Pool | PoolClient = this.pool,
  ): Promise<void> {
    const p = preImage;
    if (!p.found || !p.claimLive) return; // nothing was overridden — do not manufacture an event
    await this.recordEventBestEffort(executor, {
      taskId,
      projectId: p.projectId ?? null,
      eventType: TASK_CLAIM_EVENT.forceOverride,
      outcome: 'ok',
      actor: actor ?? null,
      claimId: p.claimId ?? null,
      previousClaimId: p.claimId ?? null,
      newVersion: p.version ?? null,
      expiresAt: p.claimExpiresAt ?? null,
      metadata: { via, overroteActor: p.claimActor ?? null },
    });
  }

  /** Audit an implicit lease extension / claim clear performed by a fenced holder write. */
  async recordHolderWrite(
    taskId: string,
    claimId: string,
    cleared: boolean,
    via: string,
    executor: Pool | PoolClient = this.pool,
  ): Promise<void> {
    const p = await this.probe(taskId, executor);
    await this.recordEventBestEffort(executor, {
      taskId,
      projectId: p.projectId ?? null,
      eventType: cleared ? TASK_CLAIM_EVENT.cleared : TASK_CLAIM_EVENT.renewed,
      outcome: 'ok',
      actor: p.claimActor ?? null,
      claimId,
      previousClaimId: claimId,
      newVersion: p.version ?? null,
      expiresAt: p.claimExpiresAt ?? null,
      metadata: { via, statusAfter: p.status ?? null },
    });
  }

  /* ── audit reads + retention ──────────────────────────────────────────────────────── */

  /**
   * Read a task's claim history, newest first (the tool-contract read path — no SQL for
   * consumers).
   *
   * ⚠️ NOT TOOL-EXPOSED, AND THE ROWS CARRY `claim_id` / `previous_claim_id`. A future audit
   * TOOL built on this MUST redact them the way the task read model does (handlers/tasks.ts
   * mapTask): publishing a live token to a reader turns the fence into a bearer capability
   * anyone can pick up — the exact bug this whole module exists to kill. Expired/superseded
   * tokens are harmless, but "is it still live?" is a question the audit row cannot answer on
   * its own, so redact by default.
   */
  async listEvents(taskId: string, limit = 50): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT id::text AS id, task_id::text AS task_id, event_type, outcome, actor,
              claim_id::text AS claim_id, previous_claim_id::text AS previous_claim_id,
              old_version, new_version, reason, lease_seconds, expires_at, metadata, occurred_at
         FROM task_claim_events
        WHERE task_id = $1::uuid
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2`,
      [taskId, limit],
    );
    return r.rows;
  }

  /**
   * RETENTION (SPEC §6.4). Deletes claim events older than `days` (default: the configured
   * window). Every claim ATTEMPT writes a row, so a hot contended board grows this table
   * fast — this is the stated pruning mechanism. Scheduling it on a timer/cron is a NAMED
   * FOLLOW-UP, deliberately out of scope for this task; the function is callable + tested so
   * it is a mechanism, not a stub.
   */
  async pruneEvents(days: number = TASK_CLAIM_CONFIG.eventRetentionDays): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM task_claim_events WHERE occurred_at < now() - ($1::int || ' days')::interval`,
      [days],
    );
    return r.rowCount ?? 0;
  }
}

export const taskClaimService = new TaskClaimServiceImpl();
export type TaskClaimService = TaskClaimServiceImpl;
