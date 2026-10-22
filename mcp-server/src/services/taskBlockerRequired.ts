/**
 * taskBlockerRequired — A BLOCK WITH NO NAMED BLOCKER IS NOT A BLOCK.
 * (gap 2.)
 *
 * ═══ WHAT WAS ACTUALLY WRONG — AND WHAT WAS NOT ═══
 * MEASURED on prod 2026-09-05: all 13 tasks with `status='blocked'` carried `blocked_on:
 * null`; after the re-triage, 6 remained and all 6 were still null. The field is documented,
 * it is first-class on `task_create` and `task_update`, and `project_briefing` selects on it
 * with a live WHERE clause. Zero rows had ever been written.
 *
 * ⚠️ THE FALSE-GREEN HYPOTHESIS WAS TESTED AND IS FALSE. The obvious fear — that the
 * briefing's "Waiting on a human" section had been rendering EMPTY this whole time while
 * looking like a working feature, so a reader saw "nothing is waiting" when the truth was
 * "nobody ever said" — does not happen. Measured against a seeded database on 2026-09-05
 * (and pinned by an executed test, src/tests/taskBlockerRequired.contract.test.ts, so this
 * paragraph is not the evidence):
 *   · with `blocked_on` NULL on every blocked task, the section returns
 *     `source: 'fallback-unpopulated'`, serves the labelled `status='blocked'` fallback, and
 *     states in-band that no task carries a value so the question has never been answered.
 *     It ALSO reports the precision of that fallback measured on the reader's own rows.
 *   · seed ONE row with `blocked_on='human'` and the source flips to `'column'` and selects
 *     exactly that row.
 * services/waitingOnHuman.ts separates "a real zero" from "nobody has populated the column"
 * with a deliberate second COUNT for precisely this reason. So the READ side is honest and
 * the surface is not false-reassuring. The defect is entirely on the WRITE side: an exact
 * selector that nothing ever feeds.
 *
 * ═══ THE FIX: FAIL CLOSED ═══
 * The task record named two defensible options — require the field when status becomes
 * `blocked`, or delete the briefing's WHERE clause as dead code. The second is off the table
 * now that the clause is measured working, and the first is what "the current state is not
 * defensible" resolves to: a documented field, a live consumer, and zero rows.
 *
 * So: moving a task to `blocked` REQUIRES a blocker to be named — either supplied on this
 * call, or already stored on the row from a previous one. This is the "unresolvable is a
 * FINDING, not a pass" shape: the write is refused with a message that names the argument and
 * lists the legal values, rather than succeeding into a state nothing can report on.
 *
 * ═══ THE TWO ABSENT DIRECTIONS, WHICH ARE THE WHOLE DESIGN ═══
 *   1. THE COLUMN IS NOT THERE (pre-093 database, or a rollback). The requirement is NOT
 *      enforced. Requiring a value that the database is incapable of storing would make
 *      `status: 'blocked'` UNSETTABLE on that instance — a fail-closed rule that closes the
 *      product. The three-state probe is honored: `present` enforces, `absent` and `unknown`
 *      do not, and `unknown` specifically must not enforce, because "I could not measure the
 *      schema" is not evidence that a caller did something wrong.
 *   2. "NO BLOCKER" MUST NOT READ AS "BLOCKER NOT RECORDED". An explicit `blockedOn: null`
 *      does NOT satisfy the requirement — treating "the caller mentioned the field" as "the
 *      caller named a blocker" would let the rule be satisfied by the act of erasing its
 *      subject. And because a row can reach the forbidden state without its status moving at
 *      all, the gate is evaluated over the row's RESULTING status and blockers rather than
 *      over the shape of the call; see the comment on assertBlockerNamed.
 */

import type { Pool } from 'pg';
import { BLOCKED_ON_VALUES } from '../config/blockedOnConfig.js';
import { readTaskBlockedOnCapability } from './taskBlockedOnCapability.js';
import type { TaskWaitingFields } from './taskBlockedOnCapability.js';

/** The status whose whole meaning is "something else has to happen first". */
export const BLOCKED_STATUS = 'blocked';

/** Thrown when a task is moved to `blocked` without a blocker being named. */
export class BlockerNotNamedError extends Error {
  constructor(
    public readonly tool: string,
    /** How many of the targeted rows carry no blocker. 1 on the single-task path. */
    public readonly unnamedCount: number,
    /**
     * Ids the caller supplied that name NO EXISTING TASK. Empty when the caller named nothing
     * at all. The two are different mistakes and get different sentences: telling someone who
     * DID name a dependency to "name a dependency" sends them to re-do the thing they just did.
     */
    public readonly danglingDependencies: readonly string[] = [],
  ) {
    super(
      (danglingDependencies.length > 0
        ? `${tool}: refusing to set status='${BLOCKED_STATUS}' — the dependenc${
            danglingDependencies.length === 1 ? 'y you named does' : 'ies you named do'
          } NOT EXIST: ${danglingDependencies.join(', ')}. NOTHING WAS WRITTEN.\n\n` +
          `A dependency is accepted as a blocker because it names WHICH task, so "is this ` +
          `blocker still valid?" can be answered by asking whether that task is still open. ` +
          `An id that names nothing cannot be asked while LOOKING answered, which is worse ` +
          `than naming nothing at all. Check the id with task_list, or name a party instead.` +
          `\n\n`
        : `${tool}: refusing to set status='${BLOCKED_STATUS}' without naming what it is ` +
          `WAITING ON (${unnamedCount} task(s) affected). NOTHING WAS WRITTEN — every other ` +
          `field on this call would have been stored normally.\n\n`) +
        `NAME EITHER ONE — pick the one that is TRUE; they are different questions:\n` +
        `  · \`dependencies: ["<task id>"]\`  — A TASK has to land first. The common case, and ` +
        `the one that stays auditable: it names WHICH task, so "is this blocker still valid?" ` +
        `is answered by asking whether that task is still open.\n` +
        `  · \`blockedOn: "<${BLOCKED_ON_VALUES.join('|')}>"\`  — A PARTY has to act next.\n\n` +
        `⚠️ DO NOT REACH FOR \`blockedOn\` IF YOU ARE WAITING ON A TASK. There is deliberately ` +
        `no enum value meaning "another task", and picking the nearest one is worse than ` +
        `leaving it blank: \`project_briefing\`'s "Waiting on a human" selects ` +
        `\`blocked_on='human'\`, so a forced value puts a FALSE ENTRY in the surface a human ` +
        `reads first. Use \`dependencies\`.\n\n` +
        `WHY THIS IS REFUSED RATHER THAN STORED: a blocked task that names nothing cannot ` +
        `answer "is this blocker still valid?" from structured data — it has to be read out ` +
        `of prose, one task at a time. That is how 25 tasks (16% of the open backlog) sat ` +
        `behind a freeze that had expired 9 days earlier, and how 7 of those sat blocked on ` +
        `nothing at all.`,
    );
    this.name = 'BlockerNotNamedError';
  }
}

/**
 * Did THIS CALL name a blocker, through EITHER channel?
 *
 * `undefined` means the caller said nothing; `null` (or `[]`) means the caller explicitly
 * CLEARED that channel. Only a non-empty value counts — see absent direction 2 for why an
 * explicit clear is a refusal rather than an answer.
 */
function callNamesParty(waiting: TaskWaitingFields): boolean {
  return typeof waiting.blockedOn === 'string' && waiting.blockedOn.trim() !== '';
}

/**
 * How many of these ids name a task THAT ACTUALLY EXISTS.
 *
 * ⚠️ EXISTENCE IS NOT IMPLIED BY RESOLUTION, and that gap is the whole reason this function
 * exists. `resolveEntityId` returns any well-formed full UUID UNCHECKED (utils/idResolver.ts)
 * — it only hits the database for SHORT ids, which it must, to expand them. So a caller
 * passing a complete UUID that names nothing sails through the route's resolver and lands in
 * the column. MEASURED at the tool surface: task_update with
 * dependencies:['ffffffff-ffff-ffff-ffff-ffffffffffff'] returned "Task updated successfully!
 * New Status: blocked" and stored the dangling id.
 *
 * That defeats the ONLY thing this channel is for. `dependencies` is accepted as a blocker
 * because it names WHICH task, so "is this blocker still valid?" is answered by asking whether
 * that task is still open. An id that names nothing cannot be asked, while READING as though
 * it had been answered — a wrong value silently believed, which is the exact failure that
 * disqualified `blocked_on` for this case.
 *
 * CHECKED HERE, IN THE GATE, AND DELIBERATELY NOT IN `resolveEntityId`: the full-UUID
 * pass-through predates this work and is shared by every id-taking tool. Tightening it is a
 * fleet-wide behaviour change and is not this task's to make.
 */
async function countRealTasks(pool: Pool, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  // SOFT-DELETE-EXEMPT: an ARCHIVED task still exists and can still be un-archived, so it is
  // a real answer to "which task are you waiting on". Excluding archived rows would refuse a
  // legitimate blocker; the question here is existence, not visibility.
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM tasks WHERE id = ANY($1)`,
    [ids as string[]],
  );
  return rows[0].n;
}

/**
 * Is the caller explicitly CLEARING a blocker channel on this write? `null`/`[]` only —
 * `undefined` means they said nothing about that field.
 */
function clearsBlocker(waiting: TaskWaitingFields, deps?: readonly string[] | null): boolean {
  // Either channel being explicitly emptied can strand the row, so both are watched. An
  // `undefined` is silence and changes nothing; `null`/`[]` is an erasure.
  return waiting.blockedOn === null || deps === null || (Array.isArray(deps) && deps.length === 0);
}

/**
 * THE GATE. Call BEFORE the write statement — nothing is written on the refusing path.
 *
 * A no-op unless the write could leave a row BLOCKED WITH NO BLOCKER — i.e. unless it moves
 * something to `blocked` or explicitly clears a blocker. That covers every call which predates
 * this rule, and the overwhelming majority of calls that do not.
 *
 * @param taskIds the rows this write targets. Empty on `task_create` (no row exists yet, so
 *   there is no stored value to fall back on and the call must name one itself).
 */
export async function assertBlockerNamed(
  pool: Pool,
  status: string | undefined,
  waiting: TaskWaitingFields,
  taskIds: readonly string[],
  tool: string,
  /**
   * The `dependencies` this call sets, if it sets them. `undefined` = the caller said nothing
   * (the column is not in the SET clause); `[]`/`null` = the caller CLEARED them. Resolved to
   * full UUIDs by the route before it reaches here, exactly as the create path resolves them.
   */
  deps?: readonly string[] | null,
): Promise<void> {
  // THE QUESTION IS ABOUT THE ROW'S END STATE, NOT ABOUT THIS CALL'S SHAPE. That distinction
  // is the whole correctness of this gate. The first cut keyed on "is this call moving to
  // blocked", and there are FOUR doors into "blocked with no blocker" — a rule that
  // enumerates call shapes will always miss one:
  //   (a) move to blocked, name nothing;
  //   (b) move to blocked, explicitly CLEAR a channel;
  //   (c) leave the STATUS KEY OFF ENTIRELY on an already-blocked row, and clear a channel;
  //   (d) name a blocker in a channel that cannot express the truth — the `blocked_on` enum
  //       has no value meaning "another task" — which is why `dependencies` is a second,
  //       equal channel rather than a nicety. See the header.
  // So the predicate below is evaluated over the row's RESULTING status and RESULTING
  // blockers, per row, in SQL — which covers all of them by construction rather than by
  // enumeration, and covers a fifth nobody has thought of yet.
  //
  // ── HOW EACH DOOR WAS ACTUALLY FOUND (corrected; the earlier version of this comment
  //    claimed more than was true, which is the exact class it was warning about) ──
  //   (b) WAS caught by this file's contract test, on the first run.
  //   (c) WAS NOT. It was reasoned about here and left UNASSERTED, and the reviewer proved the
  //       gap by mutation: deleting the `!clearing` term below left the suite GREEN 14/14,
  //       because the test named for door (c) passed `status:'blocked'` explicitly and so
  //       exercised door (b) again. Door (c) is now asserted by a test that OMITS the status
  //       key ("ABSENT: clearing … with NO status key at all"). A one-token term on a
  //       customer-visible breaking rule had nothing holding it.
  //   (d) WAS NOT found here either — it came from the coordinator's fleet measurement (75b1ea3d).
  //
  // ⚠️ F6, STATED RATHER THAN LEFT IMPLIED: this gate is APP-LAYER and NON-TRANSACTIONAL.
  // It SELECTs, then the caller's UPDATE runs as a separate statement, so two concurrent
  // writes can interleave and land the forbidden state — B clears the blocker between A's
  // check and A's write. It is a guard against the ordinary mistake, not a serializable
  // invariant. The DB-level version is deliberately NOT built: the only constraint shape
  // available for it is a CHECK, and a CHECK has no OLD, so it would inherit exactly the
  // fabrication defect that forced the `closed_at` CHECK to be deleted in migration 098
  // PART 1d — it would refuse or corrupt writes to the legacy rows that already carry this
  // state. Fixing the race is not worth re-creating that class.
  const clearing = clearsBlocker(waiting, deps);
  const movingToBlocked = status === BLOCKED_STATUS;
  /** Ids the caller supplied that name no existing task. Drives the actionable message. */
  let danglingIds: string[] = [];

  // THE PARTY CHANNEL satisfies every door at once, whatever the status does, and asks no
  // existence question — 'human' names a role, not a row.
  if (callNamesParty(waiting)) return;

  // THE TASK CHANNEL counts only if it names tasks that EXIST. A supplied array that resolves
  // to nothing real is treated as naming NOTHING, so the call falls through to the refusal
  // below rather than being accepted on the strength of an id that answers no question.
  const suppliedDeps = Array.isArray(deps) ? deps : null;
  if (suppliedDeps && suppliedDeps.length > 0) {
    if (await countRealTasks(pool, suppliedDeps) > 0) return;
    // Fall through, but remember WHY: the caller did name something, it just does not exist.
    // Reporting "name a blocker" to someone who named one is unactionable.
    danglingIds = [...suppliedDeps];
  }
  // ═══ CREATE AND UPDATE ARE DIFFERENT QUESTIONS, AND CONFLATING THEM COST A FULL SUITE ═══
  // On CREATE there is NO PRIOR STATE, so nothing can be "cleared": an empty `dependencies`
  // array is SILENCE, not erasure. The only question is whether this call is filing a blocked
  // row without naming anything.
  //
  // MEASURED, and this is why the branch is explicit rather than folded into one predicate:
  // `TasksHandler.createTask` declares `dependencies: string[] = []`, so EVERY create passes
  // an empty array rather than undefined. Reading that as an erasure made `clearing` true on
  // every create, which defeated the combined fast path below and sent every single
  // `task_create` — blocked or not — into the throw. 181 tests across 58 files went RED on
  // exactly that (full suite, 2026-09-05). The fast path was correct for UPDATE and silently
  // wrong for CREATE because the two share a predicate that only one of them can satisfy.
  if (taskIds.length === 0) {
    if (!movingToBlocked) return;
    const createCap = await readTaskBlockedOnCapability(pool);
    if (createCap.blockedOn !== 'present') return; // ABSENT DIRECTION 1 — see below.
    throw new BlockerNotNamedError(tool, 1, danglingIds);
  }

  // UPDATE / BULK UPDATE. Here a prior state EXISTS, so an erasure is a real way to reach the
  // forbidden state without the status moving at all — door (c).
  if (!movingToBlocked && !clearing) return;

  // ABSENT DIRECTION 1: honor the three-state probe. ONLY `present` enforces. A rule that
  // fired on `absent` would make `blocked` unsettable on a pre-093 instance — a fail-closed
  // rule that closes the product rather than a hole. One that fired on `unknown` would turn a
  // transient catalog blip into a rejected customer write, which is the third state being
  // folded onto "no" (CLASSES.md C1).
  const cap = await readTaskBlockedOnCapability(pool);
  if (cap.blockedOn !== 'present') return;

  // UPDATE / BULK UPDATE. ONE statement rather than a per-id loop, so a 500-id bulk sweep
  // costs the same as a single update; the COUNT is what the error reports, so a caller
  // learns how many rows are the problem instead of just that some are.
  //
  //   resulting status       = the supplied status, or the row's own when none was supplied
  //   resulting blocked_on    = NULL if this call clears it, else the row's own
  //   resulting dependencies  = the supplied array if this call sets one, else the row's own
  // A blocker already on the row through EITHER channel satisfies the rule — re-saving an
  // already-justified blocked task must not demand the justification again. The row is
  // counted as a problem only when BOTH channels come out empty, which is the two-channel
  // rule expressed as one predicate rather than as two passes that could disagree.
  //
  // SOFT-DELETE-EXEMPT: this counts ARCHIVED rows on purpose. It is not a report — it is a
  // per-id integrity check over the exact ids this write targets, and an archived task is
  // still an updatable row. Adding `archived_at IS NULL` would open a real evasion: archive
  // a task, move it to blocked with no blocker (now unguarded), restore it, and the forbidden
  // state is back on the board through a three-call detour. The archived-row exclusion that
  // matters for reporting (the decision_stats/decision_search split this sweep exists to
  // prevent) does not apply to a gate whose population is "the ids in this request".
  //
  // `$5::boolean` says "this call SETS dependencies", and `$6` carries what it sets. When it
  // is false the row's own `dependencies` is consulted; when true the supplied array wins —
  // including the empty array, which is how a caller strands a row by erasing the only
  // channel that was justifying it.
  const setsDeps = deps !== undefined;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM tasks
      WHERE id = ANY($1)
        AND COALESCE($2, status) = $3
        AND ($4::boolean OR blocked_on IS NULL OR btrim(blocked_on) = '')
        AND NOT EXISTS (
              SELECT 1 FROM tasks dep
               WHERE dep.id = ANY(
                 CASE WHEN $5::boolean THEN $6::uuid[] ELSE tasks.dependencies END))`,
    [
      taskIds as string[],
      status ?? null,
      BLOCKED_STATUS,
      waiting.blockedOn === null,
      setsDeps,
      setsDeps ? (deps ?? []) : null,
    ],
  );
  const unnamed: number = rows[0].n;
  if (unnamed > 0) throw new BlockerNotNamedError(tool, unnamed, danglingIds);
}
