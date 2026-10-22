/**
 * Task domain types for the Command "live thread" Tasks screen. `Task` reuses the
 * generated `TaskEntity` but pins `status` to the REAL Postgres enum the Command
 * backend stores + queries (`todo | in_progress | blocked | completed | cancelled`) —
 * the generated model is stale (it lists `pending`, which the DB never uses). Grounded
 * against `backend/src/services/task.ts` (the source of truth for the enum).
 */
import type { TaskEntity } from '../api/generated/models/TaskEntity';

/** The real task status enum stored by the backend (NOT the stale generated `pending`). */
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

/**
 * THE PUNCH-LIST STAGE (lane A). A second axis next to `status`:
 * where the item is in the build pipeline, draft → deployed. `null` on a LEGACY task the
 * backfill has not touched — the board derives a stage from `status` then (see
 * `pages/punch/stage.ts`), so it is never empty. Byte-identical to the backend enum.
 */
export type TaskStage =
  | 'draft'
  | 'ready'
  | 'claimed'
  | 'verifying'
  | 'evidence'
  | 'merged'
  | 'deployed';

/** How a punch will be proven done (the Walkthrough critic reads this later). */
export type PunchProofKind = 'test' | 'browser' | 'look';

/**
 * Who owns proving a `doneWhen` clause:
 * `lane` is a confined build lane (must name a `proof` — a repo path or test id it can
 * actually produce); `human` is a person (no proof requirement). No default — a caller
 * must classify every clause.
 */
export type PunchClauseOwner = 'lane' | 'human';

/**
 * One structured `doneWhen` clause. `proof` is required by the server only when
 * `owner === 'lane'` — see `mcp-server/src/services/taskPunchCompleteness.ts`, mirrored
 * client-side in `pages/punch/doneWhenClauses.ts`.
 */
export interface PunchDoneWhenClause {
  text?: string;
  owner?: PunchClauseOwner;
  proof?: string;
}

/**
 * `metadata.punch` — what makes a task a PUNCH (one board item). `proofKind` how it is
 * proven; `source` who filed it. All optional on the wire because a `draft` may be
 * incomplete — `stage:'ready'` is where the backend requires them (HTTP 400
 * `PUNCH_INCOMPLETE`).
 *
 * `doneWhen` is a union: the STRUCTURED array of `{text, owner, proof?}`
 * clauses is the shape `ready` requires; a bare STRING is the LEGACY shape — still
 * readable off an un-migrated row, but refused by the server the moment the row is at or
 * moving to `ready`. This form never WRITES the string shape (`pages/punch/PunchForm.tsx`).
 */
export interface PunchMeta {
  doneWhen?: string | PunchDoneWhenClause[];
  proofKind?: PunchProofKind;
  source?: 'form' | 'chat' | 'machine';
  /** repo-relative paths/globs the change will edit — optional. */
  touches?: string[];
}

export type Task = Omit<TaskEntity, 'status'> & {
  status: TaskStatus;
  project_name?: string;
  /** Pipeline stage (lane A). Absent/`null` on a legacy row — derive, never assume. */
  stage?: TaskStage | null;
  /** The task's JSONB metadata; `punch` is the only key this client reads. */
  metadata?: { punch?: PunchMeta; [key: string]: unknown } | null;
  /**
   * SOFT-DELETE marker. `null`/absent = live; a timestamp = the task was
   * deleted — which now means ARCHIVED, matching MCP `task_delete` on the same row rather
   * than the old hard `DELETE FROM tasks`. Archived tasks are hidden from the default
   * board/list and are RESTORABLE; the drawer reads this to offer Restore over Delete.
   */
  archived_at?: string | null;
};

/**
 * One typed graph edge touching a task — the TreeWalker "build story" moat, served by
 * GET /api/tasks/:id/links. A REAL `links`-table row (structure), NOT the task's
 * `dependencies` array and NOT a semantic list. `direction: 'outgoing'` reads forward
 * from this task; 'incoming' points at it (rendered with the reverse label).
 * `otherKind` is the target's kind for colour/label — a context's `context_type`
 * (milestone/handoff/…), or 'decision'/'task'. Identical shape to `ContextLink`.
 */
export interface TaskLink {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherType: 'context' | 'decision' | 'task';
  otherTitle: string;
  otherKind: string;
}

/** The task statistics shape returned by GET /api/tasks/stats (real counts only). */
export interface TaskStats {
  total?: number;
  by_status?: Record<string, number>;
  by_priority?: Record<string, number>;
  by_type?: Record<string, number>;
  completion_rate?: number;
  /**
   * Count of SOFT-DELETED (archived) tasks in scope. Served alongside —
   * never inside — `total`/`by_status`, which are live-only. Feeds the Archived filter
   * chip's count from the uncapped `/api/tasks/stats` COUNT, never a hardcoded number.
   */
  archived?: number;
}

/**
 * The lead-time (cycle-time) analytics returned by GET /api/tasks/stats' sibling
 * GET /api/tasks/lead-time. REAL: computed server-side from `completed_at - created_at`
 * over completed tasks (see TaskService.getLeadTimeDistribution). `stats.averageLeadTime`
 * is the Avg-cycle-time KPI; `totalTasks === 0` means no completed tasks yet (honest empty,
 * never a fabricated number). Times are in DAYS.
 */
export interface TaskLeadTime {
  distribution: Array<{ leadTimeDays: number; count: number; label?: string }>;
  stats: {
    totalTasks: number;
    averageLeadTime: number;
    medianLeadTime: number;
    p90LeadTime: number;
  };
}

/**
 * One point of the per-day THROUGHPUT series returned by GET /api/tasks/throughput.
 * REAL server-side counts: tasks COMPLETED that day (`completed_at`) + CREATED that day
 * (`created_at`), zero-filled continuously across the range window. An empty array means
 * ZERO activity of either kind in the window (honest empty, never fabricated).
 */
export interface ThroughputPoint {
  day: string;
  completed: number;
  created: number;
}

/**
 * One bar of the COMPLETED-BY-ACTOR breakdown returned by GET /api/tasks/completed-by-actor.
 * REAL `GROUP BY assigned_to` count of tasks completed in the range window, count DESC.
 * A null/blank assignee is a real `"unassigned"` bucket; an empty array = nothing completed
 * in the window (honest empty).
 */
export interface CompletedByActor {
  actor: string;
  count: number;
}

/**
 * One assignee SUGGESTION from `GET /api/tasks/actor-options`.
 *
 * SUGGESTIONS, NEVER A WHITELIST: `tasks.assigned_to` is free-form varchar and nothing on
 * either surface rejects an unlisted value. The list self-populates from the built-in
 * first-party registry plus whoever has actually held a session or a task in scope, which
 * is why it works for a customer who never configures a roster.
 */
export interface ActorOption {
  /** The canonical spelling to offer. */
  actor: string;
  /** Principal kind when the actor is first-party, else null. */
  kind: 'human' | 'agent' | 'automation' | null;
  /** Live tasks in scope assigned to it (case-insensitively). */
  taskCount: number;
  /** Sessions in scope stamped with it (case-insensitively). */
  sessionCount: number;
  /** Which sources contributed this option. */
  sources: Array<'builtin' | 'tasks' | 'sessions'>;
  /** Other spellings seen in scope for the same case-insensitive key — the drift, made visible. */
  variants: string[];
}
