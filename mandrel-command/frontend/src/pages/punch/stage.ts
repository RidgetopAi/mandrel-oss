/**
 * Stage derivation — pure functions the board, card and detail all read (testable without
 * a DOM). Where a punch SITS on the board, what a draft is MISSING, and what a drop MEANS.
 */
import type { DropResult } from 'react-beautiful-dnd';
import type { Task, TaskStage, TaskStatus, PunchMeta } from '../../types/task';
import type { TaskUpdateInput } from '../tasks/hooks';
import {
  BLOCKED_LANE,
  LEGACY_STAGE_BY_STATUS,
  STAGES,
  STATUS_FOR_STAGE,
  PUNCH_REQUIRED_FIELDS,
  PICKER_EXCLUSION_TAGS,
  PUNCH_REJECT_COPY,
  type PunchColumnId,
} from './config';
import { doneWhenSatisfiesReady } from './doneWhenClauses';

/** The prefix the picker stamps its stored verdict tag with. */
const REJECT_TAG_PREFIX = 'reject:';

const STAGE_SET = new Set<string>(STAGES);

/**
 * The stage a task is AT, whether or not the backend stamped one. A real `stage` wins;
 * `null`/absent falls back to the legacy mirror of its status. `null` = not on the board
 * (a cancelled task).
 */
export function effectiveStage(task: Pick<Task, 'stage' | 'status'>): TaskStage | null {
  if (task.stage && STAGE_SET.has(task.stage)) return task.stage;
  return LEGACY_STAGE_BY_STATUS[task.status] ?? null;
}

/** The board column a task renders in: the blocked lane by status, else its stage. */
export function columnFor(task: Pick<Task, 'stage' | 'status'>): PunchColumnId | null {
  if (task.status === 'blocked') return BLOCKED_LANE;
  return effectiveStage(task);
}

/** Group tasks by column, preserving list order. Every column key exists (empty = []). */
export function groupByColumn(tasks: Task[]): Record<PunchColumnId, Task[]> {
  const groups = {} as Record<PunchColumnId, Task[]>;
  for (const c of [...STAGES, BLOCKED_LANE] as PunchColumnId[]) groups[c] = [];
  for (const t of tasks) {
    const col = columnFor(t);
    if (col) groups[col].push(t);
  }
  return groups;
}

/** The task's punch metadata, or `{}` for a task never filed as a punch. */
export function punchOf(task: Pick<Task, 'metadata'>): PunchMeta {
  return task.metadata?.punch ?? {};
}

/** True when the task carries punch metadata at all (filed via the form/chat/machine). */
export function isPunch(task: Pick<Task, 'metadata'>): boolean {
  return task.metadata?.punch != null;
}

/**
 * Which REQUIRED punch fields are absent — the client-side twin of the backend's
 * `PUNCH_INCOMPLETE.missing`, so a draft card can say what it lacks before anyone tries
 * to make it ready. Keys match the wire names. `doneWhen` defers to
 * `doneWhenSatisfiesReady` — a bare LEGACY string is never
 * satisfying, only a non-empty array of complete `{text, owner, proof?}` clauses is;
 * every other key is still the plain non-empty-string check.
 */
export function missingPunchFields(punch: PunchMeta): Array<'doneWhen' | 'proofKind'> {
  return PUNCH_REQUIRED_FIELDS.filter(({ key }) => {
    if (key === 'doneWhen') return !doneWhenSatisfiesReady(punch.doneWhen);
    const v = punch[key];
    return typeof v !== 'string' || v.trim() === '';
  }).map(({ key }) => key);
}

/** Human labels for a missing-field list ("done-when, proof"). */
export function missingLabels(missing: ReadonlyArray<string>): string {
  return PUNCH_REQUIRED_FIELDS.filter(({ key }) => missing.includes(key))
    .map(({ label }) => label)
    .join(', ');
}

/**
 * A card's picker verdict — the human wording for its `reject:*` tag, read verbatim off
 * `task.tags` (published by the picker). This function does not decide
 * WHETHER a row is excluded; it only translates the tag the picker already wrote into
 * the wording a card shows. `null` means no `reject:` tag at all — the row is pickable
 * and the card carries no badge.
 */
export function rejectReason(task: Pick<Task, 'tags' | 'metadata'>): string | null {
  const tags = task.tags ?? [];
  const rejectTag = tags.find((tag) => tag.startsWith(REJECT_TAG_PREFIX));
  if (!rejectTag) return null;
  const reason = rejectTag.slice(REJECT_TAG_PREFIX.length);

  if (reason === 'punch-incomplete') {
    const missing = missingPunchFields(punchOf(task));
    return missing.length > 0
      ? `missing: ${missingLabels(missing)}`
      : PUNCH_REJECT_COPY.punchIncompleteFallback;
  }
  if (reason === 'tag-excluded') {
    if (tags.includes(PICKER_EXCLUSION_TAGS.exhausted)) return PUNCH_REJECT_COPY.exhausted;
    if (tags.includes(PICKER_EXCLUSION_TAGS.riskGate)) return PUNCH_REJECT_COPY.riskGate;
    return PUNCH_REJECT_COPY.tagExcludedFallback;
  }
  if (reason === 'not-ready') return PUNCH_REJECT_COPY.notReady;

  // An unrecognized verdict still gets a badge — silence would misreport the row as
  // pickable, which is the one thing this feature must never do.
  return `reject: ${reason}`;
}

/** Index of a stage in the pipeline (-1 for null). Drives the detail's timeline. */
export function stageIndex(stage: TaskStage | null): number {
  return stage ? STAGES.indexOf(stage) : -1;
}

/**
 * What a completed drag MEANS, as a pure function (mirrors `statusChangeFromDrop` on the
 * Tasks board). A drop is a write only when it lands on a real column DIFFERENT from where
 * it started; cancelled, same-column and off-board drops are no-ops and must not write.
 *
 *  - onto a STAGE column: `{ stage }` — and, when leaving the blocked lane, the status
 *    that stage implies, or the card would stay blocked and snap straight back.
 *  - onto the BLOCKED lane: `{ status:'blocked' }` — the stage is untouched.
 */
export function stageChangeFromDrop(
  result: DropResult,
): { id: string; updates: TaskUpdateInput; to: PunchColumnId } | null {
  const destination = result.destination?.droppableId;
  if (!destination) return null;
  const from = result.source.droppableId;
  if (destination === from) return null;
  if (destination === BLOCKED_LANE) {
    return { id: result.draggableId, updates: { status: 'blocked' }, to: BLOCKED_LANE };
  }
  if (!STAGE_SET.has(destination)) return null;
  const stage = destination as TaskStage;
  const updates: TaskUpdateInput = { stage };
  if (from === BLOCKED_LANE) updates.status = STATUS_FOR_STAGE[stage] as TaskStatus;
  return { id: result.draggableId, updates, to: stage };
}
