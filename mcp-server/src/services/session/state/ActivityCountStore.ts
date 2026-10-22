/**
 * In-memory store for session activity counts
 * Tracks task/context creation before flushing to database
 */

export interface ActivityCounts {
  tasks_created: number;
  tasks_updated: number;
  tasks_completed: number;
  contexts_created: number;
}

const sessionActivity: Map<string, ActivityCounts> = new Map();

const defaultCounts = (): ActivityCounts => ({
  tasks_created: 0,
  tasks_updated: 0,
  tasks_completed: 0,
  contexts_created: 0
});

export const ActivityCountStore = {
  /**
   * GET-AND-DELETE for ONE session, atomically.
   *
   * The value in this map is a DELTA — "activity since the last flush" — never a total.
   * Every consumer that intends to persist it must therefore take ownership of it and
   * remove it in the SAME synchronous turn, or the 30 s flush (`OperationTracker
   * .flushToDatabase`) can read and persist the same delta a second time (double count),
   * or the consumer can clear increments that arrived after its own read (lost update).
   *
   * `Map.get` + `Map.delete` with NO `await` between them is atomic on the Node event
   * loop: nothing else can run. That is the whole guarantee — do not insert an `await`
   * (or any call that might yield) between the two lines below, and do not split this
   * into a `get()` at one call site and a `clear()` at another.
   */
  consume(sessionId: string): ActivityCounts {
    const counts = sessionActivity.get(sessionId);
    sessionActivity.delete(sessionId);
    return counts || defaultCounts();
  },

  /**
   * GET-AND-DELETE for EVERY session, atomically — the flush's entry point.
   *
   * Replaces the old `getAll()` … await-loop … `clearAll()` shape, whose `clearAll()`
   * ran AFTER the awaited persistence loop and therefore deleted every increment that
   * arrived DURING the flush (a lost update, silent and unbounded). `getAll`/`clearAll`
   * were DELETED rather than left callable: a separable get + clear is the bug, and a
   * callable one is an invitation to rebuild it.
   */
  consumeAll(): Map<string, ActivityCounts> {
    const snapshot = new Map(sessionActivity);
    sessionActivity.clear();
    return snapshot;
  },

  /**
   * PUT BACK a delta that was consumed but could NOT be persisted.
   *
   * `consume` transfers ownership of the delta to the caller. If that caller's write
   * then fails, the delta exists only in its local variable and dies with the stack —
   * silently, and for tokens IRRECOVERABLY (they have no child table to recount from).
   * `restore` hands ownership back so the next periodic flush retries it.
   *
   * ADDS to whatever has accumulated since (never overwrites): activity recorded between
   * the consume and the failure is real and must not be discarded. Error path only —
   * the success path must never call this.
   */
  restore(sessionId: string, counts: ActivityCounts): void {
    const current = sessionActivity.get(sessionId) || defaultCounts();
    current.tasks_created += counts.tasks_created;
    current.tasks_updated += counts.tasks_updated;
    current.tasks_completed += counts.tasks_completed;
    current.contexts_created += counts.contexts_created;
    sessionActivity.set(sessionId, current);
  },

  incrementTasksCreated(sessionId: string): void {
    const counts = sessionActivity.get(sessionId) || defaultCounts();
    counts.tasks_created++;
    sessionActivity.set(sessionId, counts);
  },

  incrementTasksUpdated(sessionId: string, isCompleted: boolean = false): void {
    const counts = sessionActivity.get(sessionId) || defaultCounts();
    counts.tasks_updated++;
    if (isCompleted) {
      counts.tasks_completed++;
    }
    sessionActivity.set(sessionId, counts);
  },

  incrementContextsCreated(sessionId: string): void {
    const counts = sessionActivity.get(sessionId) || defaultCounts();
    counts.contexts_created++;
    sessionActivity.set(sessionId, counts);
  },

  clear(sessionId: string): void {
    sessionActivity.delete(sessionId);
  },

  has(sessionId: string): boolean {
    return sessionActivity.has(sessionId);
  },

  getSessionIds(): string[] {
    return Array.from(sessionActivity.keys());
  }
};
