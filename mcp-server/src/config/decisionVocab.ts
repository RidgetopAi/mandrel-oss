/**
 * TECHNICAL-DECISION LEARNING-LOOP VOCABULARY — the single source of truth.
 *
 * an earlier Task (item 2 of an earlier decision, THE UNIFICATION).
 *
 * THE PRINCIPLE (the operator, standing rule): NO HARDCODED VARIABLES, and no truth
 * maintained in two places. Before this module, `implementation_status` existed as
 * FOUR independent hand-written copies of the same five values:
 *
 *   1. the TS union type       `ImplementationStatus` in handlers/decisions.ts
 *   2. the zod enum            `implementationStatusEnum` in middleware/validation.ts
 *   3. the prose help text     opRegistry decision_record.humanDescriptions
 *   4. the prose help text     opRegistry decision_update.humanDescriptions
 *
 * plus the DB CHECK constraint (database/migrations/000_baseline_schema.sql,
 * `technical_decisions_implementation_status_check`). Adding the READ filter this task
 * required would have made a FIFTH and SIXTH copy. Instead every copy above now derives
 * from the arrays below, exactly as config/edgeTypes.ts already does for the typed-edge
 * vocabulary — the established pattern in this codebase for a value domain.
 *
 * `outcome_status` is included because it is the SAME duplicated pair in the SAME two
 * files (a TS union in handlers/decisions.ts + a zod enum in validation.ts). A module
 * named "the decision learning-loop vocabulary" that single-sourced only one of the two
 * learning-loop columns would ship with the hole already in it.
 *
 * WHAT IS DELIBERATELY NOT HERE (see the task report — flagged, not silently widened):
 * `decision_type` (15 values, duplicated twice inside validation.ts alone plus twice in
 * opRegistry prose), `impact_level`, and the `status` lifecycle enum are the same class
 * of duplication and should follow this pattern. They are untouched by this task.
 *
 * THE ORDER IS SEMANTIC, not alphabetical: both arrays read as the lifecycle progresses,
 * so a rendered breakdown or an advertised enum reads in the order a decision travels.
 * The DB CHECK constraint lists them in this same order.
 */

/**
 * technical_decisions.implementation_status — the BUILD lifecycle of a decision:
 * "has the thing we decided actually been done?"
 *
 * Must match `technical_decisions_implementation_status_check` in
 * database/migrations/000_baseline_schema.sql exactly. A value added here without the
 * matching migration will be accepted by the validator and REJECTED by Postgres.
 */
export const IMPLEMENTATION_STATUSES = [
  'planned',
  'in_progress',
  'implemented',
  'validated',
  'deprecated',
] as const;

export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number];

/** The DB column default (`DEFAULT 'planned'`), stated once so prose can cite it. */
export const IMPLEMENTATION_STATUS_DEFAULT: ImplementationStatus = 'planned';

/**
 * technical_decisions.outcome_status — the learning-loop RESULT: "how did it turn out?"
 * A SEPARATE column from both `status` (lifecycle) and `implementation_status` (build).
 *
 * Must match `technical_decisions_outcome_status_check` in the baseline schema.
 */
export const OUTCOME_STATUSES = [
  'unknown',
  'successful',
  'failed',
  'mixed',
  'too_early',
] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/**
 * Render a value domain as the comma-joined list the model-facing help text shows.
 * The prose in opRegistry derives from THIS so a new value cannot be advertised in one
 * tool's description and forgotten in another's (copies 3 and 4 above).
 */
export function vocabList(values: readonly string[]): string {
  return values.join(', ');
}

/**
 * technical_decisions.answer_status — THE DECISION INBOX lane.
 * A THIRD, orthogonal lifecycle from `status` (active/deprecated/…) and the
 * learning-loop pair above: "has a human actually chosen an option yet?"
 *
 *   open       — carries a question + >=2 options (each with >=1 pro and >=1 con); waiting
 *                for `decision_answer` or `decision_discuss`.
 *   discussing — kicked back for more context via `decision_discuss`; still unanswered.
 *   decided    — the DEFAULT. Every decision recorded before this column existed, and every
 *                decision recorded without stating answer_status, reads as 'decided' — so the
 *                inbox (answerStatus:'open') never surfaces legacy rows.
 *
 * Must match `technical_decisions_answer_status_check` in migration 104_decision_inbox.sql.
 */
export const ANSWER_STATUSES = ['open', 'discussing', 'decided'] as const;

export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/** The DB column default (`DEFAULT 'decided'`) — every pre-existing row reads as answered. */
export const ANSWER_STATUS_DEFAULT: AnswerStatus = 'decided';
