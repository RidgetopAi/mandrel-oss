/**
 * assigneeStamp — THE TRANSITION STAMP for `tasks.assigned_to` ( * Phase 2 item 1). This file is the CANONICAL declaration; the Command backend carries a
 * byte-identical mirror of the marked region below (see "TWO SURFACES").
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────
 * `assigned_to` was only ever written by `task_claim` (services/taskClaim.ts) and by a
 * caller explicitly typing a name. Most work does not claim — the coordinator or a builder moves the
 * status directly — so THE DOER IS LOST AT COMPLETION TIME. Measured on prod 2026-08-09,
 * project riverbend: of 925 live tasks, 364 are `completed` with no assignee.
 *
 * THE RULE: when an update moves a task INTO `in_progress` or `completed`, and the value
 * `assigned_to` would hold after that update is empty/whitespace, write the session actor
 * performing the update instead. Four constraints make it correct rather than merely
 * convenient, and each one is a test in the behaviour matrix:
 *
 *   1. NEVER OVERWRITE a non-empty `assigned_to`. An explicit assignment always wins —
 *      including one made in the SAME update (that is why `explicitAssignedTo` feeds the
 *      emptiness test rather than bypassing it).
 *   2. NEVER STAMP on `todo` / `blocked` / `cancelled`. Backlog with no owner is TRUE and
 *      must stay expressible; 229 of those prod rows are legitimately unowned and the
 *      board's ability to say so is the point.
 *   3. NO ACTOR ⇒ NO STAMP. Not `unknown`, not `system`, not a placeholder — a wrong name
 *      is worse than an honest blank, because a blank is visibly missing and a wrong name
 *      is silently believed.
 *   4. NO STATUS CHANGE ⇒ the column is not touched at all (a priority-only edit must not
 *      acquire an owner as a side effect).
 *
 * NOT A BACKFILL. Existing unassigned-completed rows are deliberately left alone: who did
 * them is not derivable, and a guessed attribution is worse than a blank.
 *
 * ── WHY THE EMPTINESS TEST LIVES IN SQL ───────────────────────────────────────────────
 * `assigneeAssignmentSql` emits ONE `assigned_to = CASE …` clause inside the caller's
 * existing single UPDATE. It never reads the row first. A SELECT-then-UPDATE would race:
 * two concurrent status moves could both observe an empty assignee and the loser would
 * overwrite the winner's stamp, which is exactly the "never overwrite" rule failing under
 * the only conditions that matter. The emptiness predicate is therefore Postgres's own
 * `BTRIM(COALESCE(x,'')) = ''`, evaluated against the row at write time.
 *
 * ── TWO SURFACES, ONE IMPLEMENTATION ──────────────────────────────────────────────────
 * A task's status moves via BOTH the MCP `task` tool (this service) and the Command
 * backend's REST controller (`mandrel-command/backend/src/controllers/task.ts`, whose
 * `TaskService.updateTask` is raw SQL, NOT a delegation). Implementing the stamp on one
 * would be the same two-representations-of-one-truth bug this task exists to fix.
 *
 * They cannot share a module: separate services, no shared package, and
 * `mandrel-command/backend/Dockerfile` copies only `backend/` into its runtime image, so
 * `mcp-server/src/**` does not exist at that process's runtime (the same constraint that
 * forced `backend/src/config/actorRegistry.ts` to be a mirror in Phase 1). So the region
 * between the BEGIN/END markers below is MIRRORED verbatim into
 * `mandrel-command/backend/src/config/assigneeStamp.ts` and pinned byte-for-byte by
 * `backend/src/__tests__/assigneeStampDrift.test.ts`, which reads THIS file off disk.
 *
 * ── WHAT EACH SURFACE PASSES AS `actor` ───────────────────────────────────────────────
 * Neither surface invents a derivation for this feature; each passes the actor it ALREADY
 * derived for attribution:
 *   - MCP:     `context.actor` — the per-session actor stamped on `sessions.actor`
 *              (migration 062), resolved at the edge through the actorRegistry choke point.
 *   - Command: `normalizeActor(req.user?.username)` from `backend/src/config/sessionActor.ts`,
 *              the module that already exists to keep the two surfaces from diverging on
 *              casing. That is what makes `the operator` and `operator` one actor and not two.
 */

/* ══════ ASSIGNEE STAMP RULE — MIRRORED REGION BEGIN ══════════════════════════════════ */

/** Tunables for the transition stamp (configs-not-hardcoded — no literal inline). */
export const ASSIGNEE_STAMP_CONFIG = {
  /**
   * The statuses whose arrival means "someone is doing / has done this", and therefore the
   * only transitions that may stamp. `todo` / `blocked` / `cancelled` are deliberately
   * absent: an unowned backlog item is a true statement about the world.
   */
  stampOnStatuses: ['in_progress', 'completed'] as ReadonlyArray<string>,
} as const;

/**
 * The actor this update may stamp with, or `null` for "do not stamp".
 *
 * `null` on any of: no status in this update, a status outside `stampOnStatuses`, a
 * blank/absent actor, or an actor too long for the column (stamping it would turn an
 * otherwise-valid status change into a raw Postgres 22001 → 500, so the honest blank wins;
 * `maxLength` is supplied by the caller from its own column-derived field-limit config).
 */
export function assigneeStampActor(
  status: string | null | undefined,
  actor: string | null | undefined,
  maxLength: number,
): string | null {
  if (status === null || status === undefined) return null;
  if (!ASSIGNEE_STAMP_CONFIG.stampOnStatuses.includes(status)) return null;
  const trimmed = typeof actor === 'string' ? actor.trim() : '';
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) return null;
  return trimmed;
}

/** One `assigned_to = …` SET clause plus the positional params it consumes, in order. */
export interface AssigneeAssignment {
  /** The SET clause, or `null` when this update must not touch `assigned_to` at all. */
  clause: string | null;
  /** Values for the `$n` placeholders in `clause`, in the order they appear. */
  params: string[];
}

/**
 * Build the `assigned_to` SET clause for ONE task UPDATE — the single place either surface
 * decides what happens to that column.
 *
 * @param status              the status this update sets, or undefined/null if unchanged.
 * @param explicitAssignedTo  the assignee this update sets. `undefined` means "not part of
 *                            this update" (fall back to the column's current value).
 * @param actor               the already-derived session actor performing the update.
 * @param maxActorLength      the column's own length cap, from the caller's field-limit config.
 * @param firstParamIndex     the next free `$n` in the caller's params array.
 */
export function assigneeAssignmentSql(
  status: string | null | undefined,
  explicitAssignedTo: string | null | undefined,
  actor: string | null | undefined,
  maxActorLength: number,
  firstParamIndex: number,
): AssigneeAssignment {
  const stamp = assigneeStampActor(status, actor, maxActorLength);
  const hasExplicit = explicitAssignedTo !== undefined;

  // Nothing to stamp: preserve the pre-existing behaviour exactly — write the explicit
  // value if there is one, otherwise leave the column alone.
  if (stamp === null) {
    if (!hasExplicit) return { clause: null, params: [] };
    return { clause: `assigned_to = $${firstParamIndex}`, params: [explicitAssignedTo as string] };
  }

  // The value this update would land on, BEFORE the stamp is considered: the caller's
  // explicit value when it supplied one, otherwise whatever the row already holds. The
  // stamp fills it in ONLY when it is empty, so a non-empty assignee — old or brand new —
  // is never overwritten.
  const params: string[] = [];
  let idx = firstParamIndex;
  let effective: string;
  if (hasExplicit) {
    effective = `$${idx}`;
    params.push(explicitAssignedTo as string);
    idx += 1;
  } else {
    effective = 'assigned_to';
  }
  const stampPlaceholder = `$${idx}`;
  params.push(stamp);

  return {
    clause:
      `assigned_to = CASE WHEN BTRIM(COALESCE(${effective}, '')) = '' ` +
      `THEN ${stampPlaceholder} ELSE ${effective} END`,
    params,
  };
}

/* ══════ ASSIGNEE STAMP RULE — MIRRORED REGION END ════════════════════════════════════ */
