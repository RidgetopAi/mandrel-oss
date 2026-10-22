import type { PUNCH_CLAUSE_OWNERS, PUNCH_PROOF_KINDS, TASK_STAGES } from './config.js';

export type Stage = (typeof TASK_STAGES)[number];
export type ProofKind = (typeof PUNCH_PROOF_KINDS)[number];
export type ClauseOwner = (typeof PUNCH_CLAUSE_OWNERS)[number];

export interface DoneWhenClause {
  text: string;
  owner: ClauseOwner;
  proof?: string;
}

export interface Punch {
  doneWhen?: DoneWhenClause[] | string;
  proofKind?: ProofKind | null;
  dependsOn?: string[];
  [key: string]: unknown;
}

/** A `task_list` row: the full record minus `metadata`. */
export interface TaskRow {
  id: string;
  title: string;
  stage: Stage;
  status: string;
  priority: string;
  tags: string[];
  createdAt: string;
  /** True while a claim lease is live. */
  claimLive: boolean;
}

/** A `task_details` record: a row plus `metadata`. */
export interface Task extends TaskRow {
  metadata: { punch?: Punch; [key: string]: unknown };
}

export interface Project {
  id: string;
  name: string;
}

export interface Claim {
  claimId: string;
  expiresAt: string;
}

export type ClaimRefusalReason =
  | 'held'
  | 'wrong-status'
  | 'archived'
  | 'version-stale'
  | 'not-found'
  | 'claim-lost'
  | 'disabled'
  | 'lease-out-of-bounds'
  | 'conflict'
  | (string & {});

export interface Refusal {
  ok: false;
  reason: ClaimRefusalReason;
  message?: string;
}

export type Outcome<T> = ({ ok: true } & T) | Refusal;

export interface TaskUpdate {
  stage?: Stage;
  notes?: string;
  /**
   * Top-level `punch` argument: the server keeps only the contract keys (see the golden's
   * `topLevelPunchKeys`) and silently drops the rest. Loop-owned keys go through `loopPunch`.
   */
  punch?: Partial<Record<keyof Punch, unknown>>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Writes loop-owned punch keys (lane, branch, sha, verdict, ...) through `metadata.punch`; null clears a key. */
export function loopPunch(punch: Record<string, unknown>): Pick<TaskUpdate, 'metadata'> {
  return { metadata: { punch } };
}

/** A new task. Dependencies are full task ids. */
export interface NewTask {
  title: string;
  description: string;
  stage: Stage;
  tags: string[];
  dependencies: string[];
  punch: Punch;
}

/** The loop's whole view of a Mandrel board. */
export interface Board {
  listProjects(): Promise<Project[]>;
  /** Rows only — no metadata; call `get` for the punch. */
  listStage(stage: Stage): Promise<TaskRow[]>;
  get(id: string): Promise<Task | null>;
  /** `allowedStatuses` widens the statuses the claim may start from (server default: todo only). */
  claim(id: string, allowedStatuses?: readonly string[]): Promise<Outcome<Claim>>;
  renew(id: string, claimId: string): Promise<Outcome<Claim>>;
  release(id: string, claimId: string): Promise<Outcome<object>>;
  /** Creates a task; returns the stored record. */
  create(task: NewTask): Promise<Task>;
  /** Requires the live `claimId` of the holder. */
  update(id: string, update: TaskUpdate, claimId: string): Promise<Outcome<{ task: Task }>>;
  /** Ends the connection to the server; every command calls it when done. */
  close(): Promise<void>;
}
