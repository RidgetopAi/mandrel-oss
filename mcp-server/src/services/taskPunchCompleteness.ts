/**
 * taskPunchCompleteness — "DRAFT SAYS WHICH FIELD IS MISSING."
 * (Migration 101, Punch List lane A.)
 *
 * ═══ THE RULE ═══
 * Setting `stage: 'ready'` (on create or update) is a claim that the task is well-formed
 * enough to be picked up: it REQUIRES a non-empty title, `metadata.punch.doneWhen`,
 * `metadata.punch.proofKind`, and a resolved project. A write that would leave the row in
 * `ready` without all four is REFUSED with a typed `PunchIncompleteError` naming exactly
 * which fields are missing — NOTHING IS WRITTEN. This does not apply to any other stage:
 * a `draft` is exactly the state a caller is IN while they are still filling those fields
 * in, so the gate would make `draft` unreachable if it fired there too.
 *
 * ═══ EVALUATED AGAINST THE MERGED STATE, NOT THE CALL'S OWN FIELDS ═══
 * On `task_update`, a caller moving an already-fleshed-out `draft` task to `ready` with
 * `{ stage: 'ready' }` alone must succeed — the punch fields were set on an earlier call
 * and still live on the row. The predicate is therefore evaluated against the MERGED
 * metadata (existing row + this call's shallow merge) and the MERGED title (this call's
 * title if supplied, else the existing row's), never against only the fields this call
 * happens to name. Getting this wrong the other way — checking only the call's own fields
 * — would make a legitimate two-step "fill it in, then flip the stage" workflow
 * unreachable, which is the exact "declared but unreachable" defect this codebase's task
 * schema comments catalogue repeatedly for other fields.
 */

import { PUNCH_GATE_STAGE, PUNCH_METADATA_KEY, type TaskStage } from '../config/taskStageConfig.js';

/** A single structured `doneWhen` clause. */
export interface PunchDoneWhenClause {
  text?: string;
  owner?: string;
  proof?: string;
}

export interface PunchFields {
  /**
   * The LEGACY shape is a bare string — still accepted (and unguarded) at every stage
   * except `ready`. The STRUCTURED shape required at `ready` is an array of
   * `{ text, owner, proof? }` clauses; `missingPunchFields` below is what enforces the
   * difference.
   */
  doneWhen?: string | PunchDoneWhenClause[] | null;
  proofKind?: string | null;
  source?: string | null;
  /** repo-relative paths/globs the change will edit — optional, non-empty strings when present. */
  touches?: string[] | null;
  /** task ids this task depends on — MIRRORED from the `dependencies` argument, never caller-set directly. */
  dependsOn?: string[] | null;
}

/** Typed refusal: nothing was written. Mirrors BlockerNotNamedError's shape (taskBlockerRequired.ts). */
export class PunchIncompleteError extends Error {
  readonly code = 'PUNCH_INCOMPLETE';

  constructor(
    public readonly tool: string,
    /** Which fields are missing, in a stable order: title, doneWhen, proofKind, project. */
    public readonly missing: readonly string[],
    /**
     * task_bulk_update ONLY: which of the targeted rows are incomplete, and what each is
     * missing — so a caller learns exactly which rows are the problem instead of just that
     * some are (same reporting shape assertBlockerNamed's bulk path uses).
     */
    public readonly rows?: readonly { taskId: string; missing: readonly string[] }[],
  ) {
    super(
      rows && rows.length > 0
        ? `${tool}: refusing to set stage='${PUNCH_GATE_STAGE}' — ${rows.length} row(s) incomplete: ` +
          rows.map((r) => `${r.taskId} (missing: ${r.missing.join(', ')})`).join('; ') +
          `. NOTHING WAS WRITTEN. [PUNCH_INCOMPLETE]`
        : `${tool}: refusing to set stage='${PUNCH_GATE_STAGE}' — missing: ${missing.join(', ')}. ` +
          `NOTHING WAS WRITTEN. A stage='${PUNCH_GATE_STAGE}' task must carry a non-empty title, ` +
          `metadata.punch.doneWhen, metadata.punch.proofKind, and a resolved project before it can ` +
          `be picked up. [PUNCH_INCOMPLETE]`,
    );
    this.name = 'PunchIncompleteError';
  }
}

/**
 * Typed refusal: `punch.dependsOn` is a SERVER-MIRRORED field, never a caller-writable one
 *. It exists so the picker sees the SAME
 * dependency list `task.dependencies` does — the form writes `dependencies`, the picker
 * reads `punch.dependsOn`, and letting the two drift is exactly what silently orphaned the
 * TreeWalker P2/P2a/P3 punches under an earlier decision. A caller that wants a dependency
 * recorded passes `dependencies` in the SAME call; nothing is written on refusal.
 */
export class PunchDependsOnDirectError extends Error {
  readonly code = 'PUNCH_DEPENDS_ON_DIRECT';

  constructor(public readonly tool: string) {
    super(
      `${tool}: refusing to set \`punch.dependsOn\` directly — it is mirrored automatically ` +
        `from the \`dependencies\` argument. Pass \`dependencies\` in this same call instead. ` +
        `NOTHING WAS WRITTEN. [PUNCH_DEPENDS_ON_DIRECT]`,
    );
    this.name = 'PunchDependsOnDirectError';
  }
}

/**
 * Structural validation of ONE `doneWhen` clause, pushed onto `missing` by field path
 * (`doneWhen[<i>].<field>`) so a caller is told EXACTLY what to fix. Owner
 * is REQUIRED with no default; `proof` is REQUIRED only when `owner === 'lane'` (the
 * artifact a confined lane can produce — a docker dry-run or a prod-only path names
 * nothing a lane CAN produce, which is the contract defect this gate exists to catch). A
 * `human` clause carries no proof requirement.
 */
function missingDoneWhenClauseFields(clause: unknown, index: number, missing: string[]): void {
  if (typeof clause !== 'object' || clause === null || Array.isArray(clause)) {
    missing.push(`doneWhen[${index}]`);
    return;
  }
  const c = clause as PunchDoneWhenClause;
  if (typeof c.text !== 'string' || c.text.trim() === '') missing.push(`doneWhen[${index}].text`);
  if (c.owner !== 'lane' && c.owner !== 'human') missing.push(`doneWhen[${index}].owner`);
  if (c.owner === 'lane' && (typeof c.proof !== 'string' || c.proof.trim() === '')) {
    missing.push(`doneWhen[${index}].proof`);
  }
}

/**
 * Computes which required fields are missing for a would-be `stage='ready'` row. Returns
 * `[]` when complete. Pure — no throw — so both the single-row gate (`assertPunchComplete`)
 * and the bulk gate (which must collect per-row results before deciding whether to refuse
 * the whole call) share ONE definition of "complete".
 *
 * THE STRUCTURED CONTRACT: at `ready`,
 * `doneWhen` must be a NON-EMPTY ARRAY of `{ text, owner, proof? }` clauses — the legacy bare
 * STRING shape (still accepted, unguarded, at every other stage) is refused here by name, not
 * silently coerced, because a string never named an owner or a proof for the picker to read.
 * An empty array is refused the same way a missing field is — it is not "no clauses needed",
 * it is "nothing was said".
 */
export function missingPunchFields(
  resultingTitle: string | undefined | null,
  mergedMetadata: Record<string, any> | undefined | null,
  projectResolved: boolean,
): string[] {
  const punch: PunchFields = (mergedMetadata?.[PUNCH_METADATA_KEY] as PunchFields) ?? {};
  const missing: string[] = [];

  if (!resultingTitle || resultingTitle.trim() === '') missing.push('title');

  const { doneWhen } = punch;
  if (doneWhen === undefined || doneWhen === null) {
    missing.push('doneWhen');
  } else if (typeof doneWhen === 'string') {
    // Legacy shape: fine off-ready (the gate never reaches here then), refused AT ready —
    // a string cannot name an owner or a proof.
    missing.push('doneWhen');
  } else if (!Array.isArray(doneWhen) || doneWhen.length === 0) {
    missing.push('doneWhen');
  } else {
    doneWhen.forEach((clause, i) => missingDoneWhenClauseFields(clause, i, missing));
  }

  if (!punch.proofKind || String(punch.proofKind).trim() === '') missing.push('proofKind');
  if (!projectResolved) missing.push('project');

  return missing;
}

/**
 * Runs the completeness gate BEFORE the write. A no-op unless the RESULTING stage is
 * `PUNCH_GATE_STAGE` ('ready') — every other stage, and every call that does not touch
 * stage at all, is unaffected.
 *
 * @param tool          the calling tool name, for the error message.
 * @param resultingStage the stage this write would leave the row at (undefined = unchanged).
 * @param resultingTitle the title this write would leave the row at.
 * @param mergedMetadata the metadata this write would leave the row at (existing shallow-merged
 *                        with incoming — the caller has already computed this).
 * @param projectResolved whether a project could be resolved for this write.
 */
export function assertPunchComplete(
  tool: string,
  resultingStage: TaskStage | string | undefined | null,
  resultingTitle: string | undefined | null,
  mergedMetadata: Record<string, any> | undefined | null,
  projectResolved: boolean,
): void {
  if (resultingStage !== PUNCH_GATE_STAGE) return;

  const missing = missingPunchFields(resultingTitle, mergedMetadata, projectResolved);
  if (missing.length > 0) throw new PunchIncompleteError(tool, missing);
}
