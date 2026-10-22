/**
 * taskClosedAtCapability — the NAMED READER for migration 098's `tasks.closed_at`, over the
 * shared probe in taskColumnPresence.ts. (gap 1.)
 *
 * ═══ WHY A READ GATE AND NO WRITE GATE ═══
 * This is the asymmetry worth understanding before reading the code, because it is what
 * makes migration 098 order-independent across a fleet roll:
 *
 *   THE WRITE SIDE NEEDS NO GATE AT ALL. `closed_at` is written exclusively by migration
 *   098's trigger. No handler, no route, and no service names the column in an INSERT or an
 *   UPDATE. So on a database that has not run 098, the application's write statements are
 *   BYTE-IDENTICAL to what they were before — the pre-098 window is not merely tolerated,
 *   it is unreachable. Compare migration 093, where the application DID have to write
 *   `blocked_on` and therefore needed `assertBlockedOnWritable` to refuse rather than drop.
 *
 *   THE READ SIDE STILL NEEDS ONE, for exactly one reason: a caller can ASK a `closedAfter`
 *   question, and a WHERE clause naming a column that is not there is SQLSTATE 42703 — not a
 *   degraded filter, a failed `task_list`.
 *
 * ═══ WHY IT REFUSES INSTEAD OF DROPPING THE FILTER ═══
 * Three things this code could do about an unrunnable `closedAfter`:
 *   · let it run — Postgres raises 42703 and the caller's whole `task_list` 500s over a
 *     column they have never heard of;
 *   · silently ignore it — and return a LIST, successfully, that is not the list the caller
 *     asked for. "What closed since Monday" answered with the entire backlog LOOKS RIGHT,
 *     and a wrong read has no later surface where anyone finds out;
 *   · refuse, naming the migration.
 * The second is the dangerous one and is why this is not a no-op. Identical reasoning to
 * assertDueAtQueryable, which exists one file over for the identical reason.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  CLOSED_AT_COLUMN,
  CLOSED_AT_MIGRATION,
  READ_CLOSED_AT_CAPABILITY_TTL_MS,
} from '../config/taskLifecycleConfig.js';
import {
  readTaskColumnPresence,
  clearTaskColumnPresenceCache,
  type ColumnPresence,
} from './taskColumnPresence.js';

/** The 098 question, as a value. */
const CLOSED_AT_COLUMNS: readonly string[] = [CLOSED_AT_COLUMN];

export interface TaskClosedAtCapability {
  /** Is `tasks.closed_at` there? Three-state — `unknown` is never folded onto `absent`. */
  closedAt: ColumnPresence;
  /** The driver's own message when something is `unknown`; null otherwise. */
  probeError: string | null;
}

/** Drop the memoized answer (for a test, or after a migration is applied in-process). */
export function clearTaskClosedAtCapabilityCache(pool: Pool = db): void {
  clearTaskColumnPresenceCache(pool, CLOSED_AT_COLUMNS);
}

/** Does this database have migration 098's column? NEVER THROWS — see the shared probe. */
export async function readTaskClosedAtCapability(
  pool: Pool = db,
  nowMs: number = Date.now(),
): Promise<TaskClosedAtCapability> {
  const reading = await readTaskColumnPresence(
    CLOSED_AT_COLUMNS,
    pool,
    READ_CLOSED_AT_CAPABILITY_TTL_MS(),
    nowMs,
  );
  return { closedAt: reading.presence[CLOSED_AT_COLUMN], probeError: reading.probeError };
}

/** Thrown when a caller asks a `closed_at` question of a database that cannot answer it. */
export class ClosedAtColumnUnavailableError extends Error {
  constructor(
    public readonly tool: string,
    public readonly presence: ColumnPresence,
    public readonly probeError: string | null,
  ) {
    super(
      `${tool}: this deployment cannot answer a \`closedAfter\` question — ` +
        `\`tasks.${CLOSED_AT_COLUMN}\` is ` +
        `${presence === 'absent' ? 'NOT PRESENT' : 'of UNDETERMINED presence'} in this ` +
        `database (migration ${CLOSED_AT_MIGRATION})` +
        (probeError ? `; the schema probe reported: ${probeError}` : '') +
        `. NO LIST WAS RETURNED, deliberately: silently dropping the filter would have ` +
        `answered your question with every task in the project, which looks correct. ` +
        `Apply the migration, or omit \`closedAfter\`.`,
    );
    this.name = 'ClosedAtColumnUnavailableError';
  }
}

/**
 * REFUSE, DO NOT DROP — the read half. A no-op when the caller asked no `closed_at`
 * question, which is every call that predates migration 098.
 */
export async function assertClosedAtQueryable(
  pool: Pool,
  asked: { closedAfter?: unknown },
  tool: string,
): Promise<void> {
  if (asked.closedAfter === undefined) return;
  const cap = await readTaskClosedAtCapability(pool);
  if (cap.closedAt !== 'present') {
    throw new ClosedAtColumnUnavailableError(tool, cap.closedAt, cap.probeError);
  }
}
