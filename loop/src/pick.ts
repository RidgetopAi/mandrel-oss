import type { DoneWhenClause, Task } from './board.js';
import {
  CLOSED_STATUSES,
  LOOP_EXHAUSTED_TAG,
  PICKABLE_STAGE,
  PRIORITY_ORDER,
  PROOF_REQUIRED_OWNER,
  RISK_GATE_TAG,
  PUNCH_CLAUSE_OWNERS,
  PUNCH_PROOF_KINDS,
} from './config.js';

/** Tags that exclude a task from being picked. */
const EXCLUDING_TAGS: readonly string[] = [RISK_GATE_TAG, LOOP_EXHAUSTED_TAG];

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function validClause(c: unknown): c is DoneWhenClause {
  if (typeof c !== 'object' || c === null) return false;
  const { text, owner, proof } = c as Record<string, unknown>;
  if (!isNonEmptyString(text)) return false;
  if (!(PUNCH_CLAUSE_OWNERS as readonly unknown[]).includes(owner)) return false;
  return owner !== PROOF_REQUIRED_OWNER || isNonEmptyString(proof);
}

/** True when the task's punch is complete enough for a lane to act on. */
export function hasValidPunch(task: Task): boolean {
  const punch = task.metadata?.punch;
  if (!punch) return false;
  const { doneWhen, proofKind } = punch;
  if (!Array.isArray(doneWhen) || doneWhen.length === 0 || !doneWhen.every(validClause)) return false;
  return (PUNCH_PROOF_KINDS as readonly unknown[]).includes(proofKind);
}

/** Whether a task status counts as closed for dependency purposes. */
export function isClosedStatus(status: string): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(status);
}

/**
 * Pure eligibility: stage ready, valid punch, proofKind, no excluding tag, no live claim,
 * and every `dependsOn` id closed according to `isClosed`.
 */
export function isPickable(task: Task, isClosed: (id: string) => boolean): boolean {
  if (task.stage !== PICKABLE_STAGE) return false;
  if (!hasValidPunch(task)) return false;
  if (task.tags.some((t) => EXCLUDING_TAGS.includes(t))) return false;
  if (task.claimLive) return false;
  const deps = task.metadata.punch?.dependsOn ?? [];
  return deps.every(isClosed);
}

function priorityRank(priority: string): number {
  const i = (PRIORITY_ORDER as readonly string[]).indexOf(priority);
  return i === -1 ? PRIORITY_ORDER.length : i;
}

/** Eligible tasks ordered by priority, then oldest `createdAt`, then id (stable). */
export function orderPickable(tasks: readonly Task[], isClosed: (id: string) => boolean): Task[] {
  return tasks
    .filter((t) => isPickable(t, isClosed))
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

/** The single task to work next, or null. */
export function pickNext(tasks: readonly Task[], isClosed: (id: string) => boolean): Task | null {
  return orderPickable(tasks, isClosed)[0] ?? null;
}
