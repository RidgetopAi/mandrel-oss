/**
 * useRecordProjectSync — keep a record page's `?project=` pointed at the record it is
 * SHOWING (page-scope epic §A4, the `/r/<id8>` short-link case).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE WEDGE THIS EXISTS TO PREVENT
 * ════════════════════════════════════════════════════════════════════════════════════
 * Contexts, Decisions and Tasks each put a LIST and a READER on one screen. The list is
 * scoped to the page's project; the reader is addressed BY ID and is not — a by-id read is
 * authorized against the RECORD's own project by a router.param choke point
 * (backend/src/services/entityProjectScope.ts), so it happily returns a record from
 * anywhere the caller may see.
 *
 * That is the right behaviour, and it produces the wedge: follow a `/r/<id8>` link to a
 * record in project B while your default is A, and you get B's record beside A's list,
 * with no control that reconciles them — this change set DELETES the global switcher,
 * which was the only thing that could have. The user cannot see the record in its own
 * context, and cannot get there from here.
 *
 * So the page FOLLOWS THE RECORD: once the detail resolves, the topbar switch is moved to
 * the record's own project (`project.setProjectId`, an earlier punch — it used to rewrite
 * `?project=`), the list re-scopes, and the screen is coherent again.
 *
 * ── WHY THIS AND NOT "MAKE /r/ EMIT ?project=" ───────────────────────────────────────
 * The resolver could append the project to the URL it navigates to, and that would be a
 * fine addition — but it would only cover links that came THROUGH the resolver. A pasted
 * `/contexts/<uuid>`, a bookmark, a link out of another record's thread box and the Back
 * button all reach the same state without ever touching `/r/`. This hook sits at the
 * choke point every one of them passes through: the record actually rendered.
 *
 * ── WHY IT CANNOT LOOP ───────────────────────────────────────────────────────────────
 * It fires only when the record's project DIFFERS from the page's and is one the user can
 * actually select (`project.projects`). After the switch those are equal, so the
 * effect's dependencies settle. A record whose project the user cannot select is left
 * alone — `usePageProject` would ignore the value anyway, and re-asking every render for
 * something that will never be honoured is the shape that spins.
 *
 * ── WHY IT MUST NOT FIGHT THE USER (the reviewer round-2 blocker 1) ─────────────────────
 * "Cannot loop" was the only question the original version asked, and it was the wrong
 * one. The effect also listed `projectId` in its dependencies, so a PROJECT change re-ran
 * it — and the reader is route-driven (`/tasks/:id`), so it stays mounted across a
 * `?project=` change. The result, reproduced in `useRecordProjectSync.test.tsx`:
 *
 *     record from A open, page on A → user picks B → effect re-runs BECAUSE projectId
 *     changed → sees record(A) !== page(B), A is selectable → setProjectId(A)
 *
 * The user's selection was discarded on the next tick, and the selector appeared dead on
 * Contexts / Tasks / Decisions whenever a record was open. It never looped — it converged
 * immediately, on the wrong value.
 *
 * The rule is DIRECTIONALITY: the page follows the record only when the RECORD IDENTITY
 * changes — a new record opened — never on a project change. `recordProjectId` alone
 * cannot express that, because "a record from A opened" and "the same record from A is
 * still open while the user moved the page to B" are the same value. So the hook takes
 * the record's own id and remembers the last one it has already decided about; each
 * record is followed at most once, and after that the user owns the selector.
 */
import React from 'react';
import type { UsePageProject } from './usePageProject';

/**
 * @param project          the page's `usePageProject()` result
 * @param recordProjectId  the `project_id` of the record the reader is showing, or
 *                         `undefined` while it is unknown (which is NOT the same as
 *                         "no project" and must never trigger a switch — C1's third state)
 * @param recordId         the id of the record the reader is showing, or `null`/`undefined`
 *                         when nothing is open. Pass the page's STABLE selection id (the
 *                         route id / `selectedId`), not `query.data?.id` — the latter
 *                         blinks to `undefined` across a refetch, which would read as "a
 *                         different record opened" and re-follow over the user's choice.
 */
export function useRecordProjectSync(
  project: UsePageProject,
  recordProjectId: string | undefined | null,
  recordId: string | undefined | null
): void {
  const { projectId, setProjectId } = project;
  const selectable = project.projects;

  /** The last record id this hook has already decided about. Never re-decided. */
  const decidedFor = React.useRef<string | null>(null);

  React.useEffect(() => {
    // Nothing open: forget the last decision, so closing and re-opening the same record
    // follows again (a fresh open is a fresh navigation and deserves the same treatment).
    if (!recordId) {
      decidedFor.current = null;
      return;
    }
    // THE DIRECTIONALITY GUARD. This record has already been decided about, so any
    // re-run is something OTHER than a new record — most importantly the user moving the
    // selector. Leave it alone.
    if (decidedFor.current === recordId) {
      return;
    }
    // The record's project is not known YET. This is C1's third state — not "no project" —
    // so do nothing AND do not mark the record decided; the detail is still in flight and
    // this effect must run again when it lands.
    if (!recordProjectId) {
      return;
    }
    // Already coherent. Mark it decided: this is the case the defect came in through —
    // without marking here, the user's very next selector change looks like an undecided
    // record and gets reverted.
    if (recordProjectId === projectId) {
      decidedFor.current = recordId;
      return;
    }
    // The selectable list has not loaded yet, so "can the user select this project?" is
    // also unanswerable — third state again. Do not decide on an empty population.
    if (selectable.length === 0) {
      return;
    }
    decidedFor.current = recordId;
    // Only follow the record into a project this user can actually select. Otherwise the
    // value would be written to the switch and then ignored by usePageProject's
    // validation, leaving a switch that says one thing while the page shows another.
    if (!selectable.some((p) => p.id === recordProjectId)) {
      return;
    }
    setProjectId(recordProjectId);
  }, [recordId, recordProjectId, projectId, selectable, setProjectId]);
}

export default useRecordProjectSync;
