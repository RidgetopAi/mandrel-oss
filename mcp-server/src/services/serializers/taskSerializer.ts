/**
 * THE task wire record. See recordSerializer.ts for the class and the mark.
 *
 * Emits the UNION of what task_details, task_list, and the task_create/task_update echoes
 * each hand-enumerated before this existed, so every existing key keeps its name and value.
 *
 * ABSENT-WHEN-ABSENT is preserved from handlers/tasks.mapTask: `closedAt`, `blockedOn`,
 * `dueAt`, `archivedAt` and `branchMembership` are emitted only when the read model carries
 * the key — a projection that never selected the column and a column holding NULL are
 * different facts ("nobody measured" vs "nothing recorded") and are not collapsed here.
 */
import type { Task } from '../../handlers/tasks.js';
import { recordUrl } from '../../config/commandUrlConfig.js';
import { BRANCH_TAG_PREFIX } from '../../config/membershipSourceConfig.js';
import { markSerialized, toIso } from './recordSerializer.js';

export interface SerializeTaskOptions {
  /**
   * `row` is the LIST projection: identical to `full` minus `metadata`, which is unbounded
   * (task notes append to metadata.noteLog) and belongs on the per-record read, not on a
   * 100-row board. Stated here — the only place a list row may omit a stored field.
   */
  view?: 'full' | 'row';
  /** Route-specific additions (write reports, applied-field lists). Merged BEFORE marking. */
  extras?: Record<string, unknown>;
}

/** The fields `view:'row'` omits, exported so the value guard can exclude exactly these. */
export const TASK_ROW_VIEW_OMITS: readonly (keyof Task)[] = Object.freeze(['metadata']);

export function serializeTask(task: Task, opts: SerializeTaskOptions = {}): Record<string, unknown> {
  const view = opts.view ?? 'full';
  const membership = task.branchMembership;
  const record: Record<string, unknown> = {
    id: task.id,
    // STRUCTURED PERMALINK — the same recordUrl the text block carries.
    url: recordUrl(task.id),
    title: task.title,
    type: task.type,
    status: task.status,
    // THE PUNCH LIST LANE (migration 101) — SOURCE OF TRUTH over
    // `status`. On BOTH views (unlike `metadata`, which `row` omits): stage is a small,
    // bounded enum, not an unbounded log, so there is no reason to strip it from a list.
    stage: task.stage,
    priority: task.priority,
    assignedTo: task.assignedTo ?? null,
    createdBy: task.createdBy ?? null,
    tags: task.tags,
    dependencies: task.dependencies,
    description: task.description ?? null,
    progress: task.progress ?? null,
    ...(view === 'full' ? { metadata: task.metadata } : {}),
    createdAt: toIso(task.createdAt),
    updatedAt: toIso(task.updatedAt),
    startedAt: toIso(task.startedAt),
    completedAt: toIso(task.completedAt),
    ...('closedAt' in task ? { closedAt: toIso(task.closedAt) } : {}),
    ...('blockedOn' in task ? { blockedOn: task.blockedOn ?? null } : {}),
    ...('dueAt' in task ? { dueAt: toIso(task.dueAt) } : {}),
    ...('archivedAt' in task ? { archivedAt: toIso(task.archivedAt) } : {}),
    // BOTH BRANCH CARRIERS, NEVER MERGED. `branchMembership` is
    // the declared spine (task_list's historical key); `branch` is the same object under
    // task_details' historical key — one fact, both names preserved. `branchTags` is the
    // workstream slug(s) on the record, a different question, reported separately.
    ...(membership !== undefined ? { branchMembership: membership ?? null, branch: membership ?? null } : {}),
    branchTags: task.tags.filter((t) => t.startsWith(BRANCH_TAG_PREFIX)),
    // ATOMIC TASK CLAIM. No `claimId` — mapTask withholds the fencing token
    // at the choke point; only task_claim returns it, to the caller that won it.
    version: task.version ?? null,
    claimActor: task.claimActor ?? null,
    claimExpiresAt: toIso(task.claimExpiresAt),
    claimLive: task.claimLive === true,
    ...(opts.extras ?? {}),
  };
  return markSerialized('task', record);
}
