/**
 * taskStageConfig — the SEVEN-STAGE PUNCH LIST LANE (migration 101).
 *
 * ONE declaration of the stage vocabulary so the validator's enum, the DB CHECK, the
 * status-derivation rules and the completeness rule all read the same list ( * one centralized definition, not N copies). The DB CHECK in migration 101 is the
 * authoritative mirror at the lowest layer; this is the application-layer copy pinned to
 * it by an executed test (taskStageStatusSync.contract.test.ts).
 */

/** The seven stages, in punch-list order. */
export const TASK_STAGES = [
  'draft',
  'ready',
  'claimed',
  'verifying',
  'evidence',
  'merged',
  'deployed',
] as const;

export type TaskStage = (typeof TASK_STAGES)[number];

/**
 * The stage that triggers the "punch is complete" gate (task_create / task_update).
 * Setting stage to this value REQUIRES title, `metadata.punch.doneWhen`,
 * `metadata.punch.proofKind`, and a resolved project — see services/taskPunchCompleteness.ts.
 */
export const PUNCH_GATE_STAGE: TaskStage = 'ready';

/** The reserved metadata key the punch fields live under: `metadata.punch`. */
export const PUNCH_METADATA_KEY = 'punch';

/** `metadata.punch.proofKind` legal values. */
export const PUNCH_PROOF_KINDS = ['test', 'browser', 'look'] as const;
export type PunchProofKind = (typeof PUNCH_PROOF_KINDS)[number];

/** `metadata.punch.source` legal values. */
export const PUNCH_SOURCES = ['form', 'chat', 'machine'] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];

/**
 * `metadata.punch.doneWhen[].owner` legal values (an earlier decision /
 * the Punch List loop decision). `lane` = a confined lane can produce the proof itself, and REQUIRES `proof`
 * (a repo-relative path or a test id — the artifact the critic opens); `human` = the clause
 * needs a person and carries no proof.
 */
export const PUNCH_CLAUSE_OWNERS = ['lane', 'human'] as const;
export type PunchClauseOwner = (typeof PUNCH_CLAUSE_OWNERS)[number];
