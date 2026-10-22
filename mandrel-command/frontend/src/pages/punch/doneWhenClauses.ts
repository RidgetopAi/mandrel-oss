/**
 * doneWhenClauses — pure helpers for the STRUCTURED `punch.doneWhen` contract.
 * One `ClauseDraft` per form row: `owner` is
 * `''` until the user picks (no default — see PunchDoneWhenClause), so a row can be
 * "started" (some content) without yet being COMPLETE (satisfies the server's ready-gate).
 *
 * These mirror `mcp-server/src/services/taskPunchCompleteness.ts`'s
 * `missingDoneWhenClauseFields` / `missingPunchFields` rules — the server is the
 * AUTHORITY (it re-checks on write), this is the client PREVIEW so the Ready button
 * can be disabled, and the missing field named, before ever asking the server.
 */
import type { PunchClauseOwner, PunchDoneWhenClause } from '../../types/task';

export interface ClauseDraft {
  text: string;
  owner: PunchClauseOwner | '';
  proof: string;
}

export const emptyClause = (): ClauseDraft => ({ text: '', owner: '', proof: '' });

function draftFromWireClause(c: PunchDoneWhenClause): ClauseDraft {
  return {
    text: c.text ?? '',
    owner: c.owner === 'lane' || c.owner === 'human' ? c.owner : '',
    proof: c.proof ?? '',
  };
}

/**
 * Seed form rows from a punch's `doneWhen`. A LEGACY STRING loads as ONE row carrying
 * the string as `text` with owner UNSET (an earlier task item 6) — the user is forced to
 * classify it before the punch can go back to `ready`. `undefined`/empty loads one blank
 * row (a form always has at least one row to fill in).
 */
export function clauseRowsFromDoneWhen(
  doneWhen: string | PunchDoneWhenClause[] | undefined | null,
): ClauseDraft[] {
  if (typeof doneWhen === 'string') {
    return doneWhen.trim() === '' ? [emptyClause()] : [{ text: doneWhen, owner: '', proof: '' }];
  }
  if (Array.isArray(doneWhen) && doneWhen.length > 0) {
    return doneWhen.map(draftFromWireClause);
  }
  return [emptyClause()];
}

/** Has the user put anything into this row at all? Gates when inline errors show — an
 * untouched blank row should not scream "required" before anyone has typed in it. */
export function clauseStarted(c: ClauseDraft): boolean {
  return c.text.trim() !== '' || c.owner !== '' || c.proof.trim() !== '';
}

export interface ClauseFieldErrors {
  text?: string;
  owner?: string;
  proof?: string;
}

/** Which fields of ONE row are missing, by name — the field-level twin of the server's
 * `doneWhen[<i>].<field>` refusal path. */
export function clauseErrors(c: ClauseDraft): ClauseFieldErrors {
  const errors: ClauseFieldErrors = {};
  if (c.text.trim() === '') errors.text = 'Text is required';
  if (c.owner !== 'lane' && c.owner !== 'human') errors.owner = 'Choose lane or human';
  if (c.owner === 'lane' && c.proof.trim() === '') errors.proof = 'Proof is required for a lane clause';
  return errors;
}

export function clauseComplete(c: ClauseDraft): boolean {
  return Object.keys(clauseErrors(c)).length === 0;
}

/** The wire shape `task_create`/`task_update` expect for `punch.doneWhen`. Assumes every
 * clause is COMPLETE — callers gate submission on `clauseComplete` first. */
export function clausesToPayload(clauses: ClauseDraft[]): PunchDoneWhenClause[] {
  return clauses.map((c) => {
    const clause: PunchDoneWhenClause = { text: c.text.trim(), owner: c.owner as PunchClauseOwner };
    if (c.owner === 'lane') clause.proof = c.proof.trim();
    return clause;
  });
}

function wireClauseComplete(clause: unknown): boolean {
  if (typeof clause !== 'object' || clause === null || Array.isArray(clause)) return false;
  const c = clause as PunchDoneWhenClause;
  if (typeof c.text !== 'string' || c.text.trim() === '') return false;
  if (c.owner !== 'lane' && c.owner !== 'human') return false;
  if (c.owner === 'lane' && (typeof c.proof !== 'string' || c.proof.trim() === '')) return false;
  return true;
}

/**
 * A short, safe-to-render display string for a punch's `doneWhen`. `PunchDetail`'s
 * read-only view predates the structured contract and only ever showed a plain string;
 * this keeps it from crashing (rendering an array of clause objects as a React child)
 * without adding new per-clause board rendering, which is out of scope for this task
 * (see an earlier task's NOT IN SCOPE).
 */
export function doneWhenDisplayText(
  doneWhen: string | PunchDoneWhenClause[] | undefined | null,
): string {
  if (typeof doneWhen === 'string') return doneWhen;
  if (Array.isArray(doneWhen)) {
    return doneWhen.map((c) => (c.text?.trim() ? c.text.trim() : '(untitled clause)')).join('; ');
  }
  return '';
}

/**
 * Does a task's WIRE `doneWhen` already satisfy the ready-gate? Mirrors
 * `taskPunchCompleteness.ts#missingPunchFields`'s doneWhen rule exactly: a bare STRING,
 * an empty array, or an array with any malformed clause is NOT satisfied — only a
 * non-empty array of complete clauses is. Used by
 * `pages/punch/stage.ts` so the draft card's "missing:" line agrees with the server.
 */
export function doneWhenSatisfiesReady(
  doneWhen: string | PunchDoneWhenClause[] | undefined | null,
): boolean {
  if (!Array.isArray(doneWhen)) return false;
  return doneWhen.length > 0 && doneWhen.every(wireClauseComplete);
}
