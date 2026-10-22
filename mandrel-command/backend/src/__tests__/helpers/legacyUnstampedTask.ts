/**
 * Create a task row in the LEGACY shape: `status='completed'` with `completed_at IS NULL`.
 *
 * WHY A HELPER IS NEEDED AT ALL. Migration 094 made an ordinary
 * INSERT unable to produce that state — the BEFORE trigger `trg_tasks_completed_at_stamp`
 * stamps a row born completed. Several fixtures rely on the state, because it is the shape
 * of the 208 legacy rows measured on prod and the reason those rows must stay excluded from
 * every completed-per-day series. Reproducing it means inserting with the trigger off.
 *
 * Migration 099 DROPPED 094's `tasks_completed_needs_stamp` CHECK, so this
 * helper no longer drops and re-adds a constraint. It must not: re-adding the CHECK, even
 * NOT VALID, is exactly the defect 099 removed (a CHECK has no OLD, so every unrelated UPDATE
 * to a legacy row must either fabricate a stamp or fail 23514), and a helper that re-added it
 * would silently reinstall that defect in the test database for every suite that runs after.
 *
 * THE GUARDS THAT USE THIS ARE NOT OBSOLETE. 099 leaves the legacy rows NULL by construction,
 * so every read that must not count them still must not count them.
 *
 * Uses the SAME pool the suite uses, so the DDL and the insert share a connection pool and
 * the trigger is always re-enabled — including on failure.
 */
export async function withLegacyUnstampedTasksAllowed<T>(
  query: (sql: string, params?: any[]) => Promise<any>,
  fn: () => Promise<T>,
): Promise<T> {
  await query('ALTER TABLE tasks DISABLE TRIGGER trg_tasks_completed_at_stamp');
  try {
    return await fn();
  } finally {
    await query('ALTER TABLE tasks ENABLE TRIGGER trg_tasks_completed_at_stamp');
  }
}
