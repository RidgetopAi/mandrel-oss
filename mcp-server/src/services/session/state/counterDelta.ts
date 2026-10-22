/**
 * IS THIS CONSUMED DELTA EMPTY? — the one predicate that gates every counter write.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * Three call sites decide "is there anything to persist for this session" before writing:
 *   1. OperationTracker.flushToDatabase   (activity delta, 30 s loop)
 *   2. TokenTracker.flushToDatabase       (token delta, 30 s loop)
 *   3. SessionLifecycleService.endSession (both halves, one statement)
 * All three used to answer it by ENUMERATING FIELDS BY HAND, and one of them was already
 * wrong: the activity gate read `tasks_created || tasks_updated || contexts_created` and
 * omitted `tasks_completed` — the fourth field, which it then passed to the write.
 *
 * That omission is not a missed write. `ActivityCountStore.consumeAll()` has ALREADY
 * removed the delta from the store by the time the gate runs (get-and-delete — see
 * `ActivityCountStore.consume`), so a delta the gate skips is DESTROYED, silently and
 * unrecoverably. Skipping is the destructive branch, not the cheap one.
 *
 * It was harmless in practice only because `incrementTasksUpdated` happens to bump
 * `tasks_updated` alongside `tasks_completed`, so the omitted field never travelled alone.
 * That is an implicit coupling between two unrelated functions, not a guarantee: it holds
 * today and can be broken by an edit that has no reason to look here. `restore()` already
 * accepts an arbitrary `ActivityCounts` and can hand back a delta of any shape.
 *
 * ── THE SHAPE ──────────────────────────────────────────────────────────────────────────
 * The predicate is derived from the DELTA OBJECT ITSELF — every own value must be 0 for it
 * to be empty. There is no field list to keep in sync, so a counter added to
 * `ActivityCounts` / `TokenUsage` / `SessionCounterDelta` is covered the moment it exists,
 * with nothing to remember. A hand-written disjunction is an allow-list: it protects the
 * fields its author had in mind and silently drops the next one.
 *
 * FAILS OPEN, ON PURPOSE. Anything this cannot prove to be zero counts as non-empty and
 * gets written. The two error directions are not symmetric: a spurious write costs one
 * no-op `+ 0` UPDATE, while a spurious skip destroys a consumed delta. When in doubt,
 * write.
 *
 * THE COMPILER IS PART OF THE GUARD. `T extends Record<keyof T, number>` accepts only
 * all-numeric delta types, so adding a non-numeric field to one of them is a compile
 * error AT THE GATE — a loud RED at the exact line that would otherwise mis-handle it,
 * rather than a value this function quietly judges non-zero.
 *
 * ── WHY THERE IS A GATE AT ALL ─────────────────────────────────────────────────────────
 * Deleting it is not equivalent. `SessionRepo.applyCounterDelta` also sets
 * `last_activity_at = NOW()`, so writing an all-zero delta would report activity that did
 * not happen — on every 30 s tick, for every session that has an empty entry (which
 * `restore()` can create). The gate is a correctness boundary, not an optimisation.
 * `sessionCountRule.contract.test.ts` (F7c) holds that line.
 */
export function isEmptyDelta<T extends Record<keyof T, number>>(delta: T): boolean {
  return (Object.keys(delta) as Array<keyof T>).every((key) => delta[key] === 0);
}
