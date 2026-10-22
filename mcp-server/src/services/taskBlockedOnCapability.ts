/**
 * THE COLUMN-PRESENCE PROBE — what makes migration 093 order-independent across 8 live
 * instances (SCOPE §8.6: "Code must tolerate the ABSENT column").
 *
 * ═══ WHY THIS EXISTS ═══
 * P5.5 is the tranche's only schema migration. A fleet roll and a migration run are two
 * separate acts on eight separate instances, so for some window SOME instance is running
 * new code against a pre-093 database. Without this probe that window is a 500: Postgres
 * answers `column "blocked_on" does not exist` (SQLSTATE 42703) and the whole
 * `project_briefing` call fails — not the section, the CALL. A customer would lose their
 * entire briefing because a column they have never heard of has not been added yet.
 *
 * With it, the reader ASKS FIRST and the deploy order is free in both directions. That
 * property is asserted by an executed test against a database that genuinely does not have
 * the migration (src/tests/blockedOnAbsentColumn.contract.test.ts) — not by this paragraph.
 *
 * ═══ THREE STATES, NOT TWO (CLASSES.md C1) ═══
 * `present` / `absent` / `unknown`. An instrument that crosses a process boundary can always
 * return "I could not measure", and code that folds that onto one of the first two is the
 * bug — it is worse than a wrong answer because the output still looks measured.
 *
 * Here the third state is real and reachable: the pool can be down, the role can lack
 * `information_schema` visibility, a statement timeout can fire. `unknown` gets its OWN
 * branch in every consumer: the section degrades to the fallback AND says it could not
 * determine whether the column exists, which is a different sentence from "the column is
 * not there". A reader who is told the wrong one goes and runs the wrong remedy.
 *
 * ═══ WHERE THE MECHANISM LIVES NOW ═══
 * The probe ITSELF moved to services/taskColumnPresence.ts when migration 098 needed the
 * identical thing for `closed_at`. Two copies of one rule is the C5 shape this codebase keeps
 * paying for, and specifically it is how you get a cache that is cleared in one place and not
 * the other. This file is now a NAMED READER over that shared probe: it owns the 093 QUESTION
 * (which columns, which TTL, what the answer means to a briefing) and no longer owns the
 * catalog read. Its public API is unchanged byte-for-byte.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  BLOCKED_ON_COLUMN,
  DUE_AT_COLUMN,
  READ_BLOCKED_ON_CAPABILITY_TTL_MS,
  BLOCKED_ON_MIGRATION,
} from '../config/blockedOnConfig.js';
import {
  readTaskColumnPresence,
  clearTaskColumnPresenceCache,
  type ColumnPresence,
} from './taskColumnPresence.js';

/**
 * Re-exported, not redeclared. Every consumer that imported `ColumnPresence` from here keeps
 * working, and there is exactly ONE declaration of the three-state type in the tree.
 */
export type { ColumnPresence };

/** The 093 question, as a value: the columns that migration adds, asked about together. */
const BLOCKED_ON_COLUMNS: readonly string[] = [BLOCKED_ON_COLUMN, DUE_AT_COLUMN];

export interface TaskBlockedOnCapability {
  /** Is `tasks.blocked_on` there? */
  blockedOn: ColumnPresence;
  /** Is `tasks.due_at` there? */
  dueAt: ColumnPresence;
  /**
   * Why the probe returned `unknown`, verbatim from the driver. Null unless something is
   * `unknown`. Carried as a FIELD so a caller can render the reason rather than inventing
   * one (an earlier decision RULING 6 — the display may only assert what a record carries).
   */
  probeError: string | null;
}

/** Both columns present — the state after migration 093 has run. */
export const CAPABILITY_PRESENT: TaskBlockedOnCapability = Object.freeze({
  blockedOn: 'present',
  dueAt: 'present',
  probeError: null,
});

/** Neither column present — a pre-093 database. NOT an error; a legitimate deploy state. */
export const CAPABILITY_ABSENT: TaskBlockedOnCapability = Object.freeze({
  blockedOn: 'absent',
  dueAt: 'absent',
  probeError: null,
});

/** Drop the memoized answer (for a test, or after a migration is applied in-process). */
export function clearTaskBlockedOnCapabilityCache(pool: Pool = db): void {
  clearTaskColumnPresenceCache(pool, BLOCKED_ON_COLUMNS);
}

/**
 * Does this database have migration 093's columns?
 *
 * NEVER THROWS — see the shared probe. Every failure path returns `unknown` with the
 * driver's own message in `probeError`, and `unknown` is never folded onto `absent`.
 */
export async function readTaskBlockedOnCapability(
  pool: Pool = db,
  nowMs: number = Date.now(),
): Promise<TaskBlockedOnCapability> {
  const reading = await readTaskColumnPresence(
    BLOCKED_ON_COLUMNS,
    pool,
    READ_BLOCKED_ON_CAPABILITY_TTL_MS(),
    nowMs,
  );
  return {
    blockedOn: reading.presence[BLOCKED_ON_COLUMN],
    dueAt: reading.presence[DUE_AT_COLUMN],
    probeError: reading.probeError,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// THE WRITE GATE — a supplied field is never silently dropped
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two migration-093 fields a write path may carry. `undefined` means THE CALLER SAID
 * NOTHING (and the statement will not name the column at all); `null` means THE CALLER
 * EXPLICITLY CLEARED IT (and the statement will name it, setting NULL). Those are different
 * intents and the write path keeps them different — which is why this is `| null` rather
 * than a plain optional.
 */
export interface TaskWaitingFields {
  blockedOn?: string | null;
  dueAt?: Date | string | null;
}

/** Thrown when a caller supplies a 093 field on a database that cannot store it. */
export class BlockedOnColumnUnavailableError extends Error {
  constructor(
    public readonly tool: string,
    public readonly presence: ColumnPresence,
    public readonly probeError: string | null,
  ) {
    super(
      `${tool}: this deployment cannot store \`blocked_on\`/\`due_at\` — the columns are ` +
        `${presence === 'absent' ? 'NOT PRESENT' : 'of UNDETERMINED presence'} in this ` +
        `database (migration ${BLOCKED_ON_MIGRATION})` +
        (probeError ? `; the schema probe reported: ${probeError}` : '') +
        `. NOTHING WAS WRITTEN. Apply the migration, or omit these fields — every other ` +
        `field on this call would have been stored normally.`,
    );
    this.name = 'BlockedOnColumnUnavailableError';
  }
}

/**
 * REFUSE, DO NOT DROP. If a caller explicitly set `blockedOn` or `dueAt` and the columns are
 * not there, the write fails with a typed error naming the migration.
 *
 * WHY REFUSING IS RIGHT HERE WHILE WARN-AND-STORE IS RIGHT FOR TAGS (SCOPE §8.6 asks for
 * both, and they look contradictory until you ask who is harmed):
 *   - A TAG that fails validation is still STORABLE. Rejecting it would destroy a write the
 *     database was perfectly willing to accept, for every existing customer, inside a
 *     migration — so it warns and stores.
 *   - A `blocked_on` value on a pre-093 database is NOT STORABLE. The only two options are
 *     "fail loudly" and "succeed while discarding what the caller asked for". The second is
 *     worse: it returns success, the value is gone, and the customer finds out when their
 *     most valuable section silently keeps rendering the low-precision fallback.
 * Nothing is written on this path — the check runs before the statement, not after.
 *
 * A no-op when the caller supplied neither field, which is every call that predates P5.5.
 */
export async function assertBlockedOnWritable(
  pool: Pool,
  fields: TaskWaitingFields,
  tool: string,
): Promise<void> {
  if (fields.blockedOn === undefined && fields.dueAt === undefined) return;
  const cap = await readTaskBlockedOnCapability(pool);
  if (fields.blockedOn !== undefined && cap.blockedOn !== 'present') {
    throw new BlockedOnColumnUnavailableError(tool, cap.blockedOn, cap.probeError);
  }
  if (fields.dueAt !== undefined && cap.dueAt !== 'present') {
    throw new BlockedOnColumnUnavailableError(tool, cap.dueAt, cap.probeError);
  }
}

/**
 * REFUSE, DO NOT DROP — the READ half.
 *
 * `task_list` grew a `dueBefore` filter and a `sort:'dueAt'` ordering. On a pre-093
 * database both name a column that is not there, and there are only three things this code
 * could do about it:
 *   · let the query run — Postgres raises 42703 and the caller's whole task_list 500s over
 *     a column they have never heard of (the exact failure the briefing probe exists to
 *     prevent);
 *   · silently ignore the filter — and return a LIST, successfully, that is not the list
 *     the caller asked for. A deadline filter that quietly matches everything answers "what
 *     is due this week" with the entire backlog and looks right;
 *   · refuse, naming the migration.
 * The second is the dangerous one and is why this is not a no-op. Same reasoning as
 * assertBlockedOnWritable, with an extra edge: a wrong READ has no later surface where
 * anyone finds out.
 *
 * A no-op when the caller asked for neither, which is every call that predates this change.
 */
export async function assertDueAtQueryable(
  pool: Pool,
  asked: { dueBefore?: unknown; sortsByDueAt?: boolean },
  tool: string,
): Promise<void> {
  if (asked.dueBefore === undefined && !asked.sortsByDueAt) return;
  const cap = await readTaskBlockedOnCapability(pool);
  if (cap.dueAt !== 'present') {
    throw new BlockedOnColumnUnavailableError(tool, cap.dueAt, cap.probeError);
  }
}
