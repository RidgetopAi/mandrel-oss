/**
 * TEST HELPER — bind a connection to the project the TEST chose, deterministically.
 *
 * THE DEFECT THIS CLOSES (first surfaced on an earlier task)
 * ------------------------------------------------------------------------------
 * Every project-scoped route calls `projectHandler.initializeSession(connectionId)` on entry
 * (routes/context.routes.ts, tasks.routes.ts, decisions.routes.ts, search.routes.ts,
 * links.routes.ts, branch.routes.ts, recall.routes.ts, artifact.routes.ts, project.routes.ts,
 * session.routes.ts, routes/index.ts — the action gate). For a connection that has never
 * acted, that ladder falls through to **Priority 4 — `projects[0]`** (handlers/project.ts),
 * and `listProjects` orders `ORDER BY p.updated_at DESC`.
 *
 * So an unbound connection's project is "whichever project was touched most recently ANYWHERE
 * in the database" — a property of the BOX and of the run order, not of the commit. A test
 * that lets that happen is asserting against a subject the environment picked. It is green by
 * luck, and it REDs the gate on the box instead of on the change (CLASSES.md C1/C4).
 *
 * REPRODUCED ON DEMAND, not theorised (2026-08-26, full suite, one disposable DB):
 *   control        3585 passed / 0 failed
 *   + one decoy project with a FUTURE updated_at (so it is projects[0] all run)
 *                  3581 passed / 4 failed   (autoOpenPositions x2, projectArgNormalizer,
 *                                            statsSearchCountReconcile)
 *   decoy removed, same DB   3585 passed / 0 failed
 * The four failure messages were `expected false to be true`, `expected undefined to be 2`,
 * `expected [] to deeply equal [ Array(1) ]` and `expected undefined to be truthy` — none of
 * which names the real cause. That is why the read-back below exists.
 *
 * WHY `project_switch` AND NOT `projectHandler.setCurrentProject`
 * --------------------------------------------------------------
 * `project_switch` is the PUBLIC tool a real client uses, and it sets `manualOverride`, which
 * `initializeSession` honours in its FIRST branch — above the primary-project auto-select, the
 * cached slot, the `aidis-bootstrap` default and the `projects[0]` fallback. The binding is
 * therefore deterministic by the product's own documented precedence rather than by ordering.
 * `setCurrentProject` writes the cached slot only, which Priority 1 (a project carrying
 * `metadata.is_primary`) will overwrite.
 *
 * SCOPE OF THIS HELPER: it binds ONE connection. It does not, and cannot, protect a call that
 * passes no connection at all (`routeExecutor(tool, args)` uses the shared default session
 * slot) — for those, pass the project as an explicit tool argument, which is rung 1 and beats
 * every ambient rung.
 */

import { expect } from 'vitest';
import { routeExecutor } from '../../routes/index.js';
import { projectHandler } from '../../handlers/project.js';

/** The message a RED must carry, so the next person is not sent hunting a product bug. */
export const AMBIENT_INHERITANCE_DIAGNOSIS =
  'the connection→project binding did not hold, so this run\'s ambient database chose the ' +
  'project instead of the test (initializeSession Priority 4 → projects[0], ordered by ' +
  'updated_at DESC). Fixture defect, NOT a defect in the tool under test.';

/**
 * Bind `connectionId` to `project` (name OR uuid) and PROVE the binding landed.
 *
 * The read-back is the load-bearing half: without it a silently-failed switch degrades into
 * exactly the ambient coin-flip this helper exists to remove, and the eventual failure names
 * the wrong subject.
 */
export async function bindConnectionToProject(connectionId: string, project: string): Promise<void> {
  const resp = await routeExecutor('project_switch', { project }, { connectionId });
  expect(resp.isError, `project_switch failed for connection '${connectionId}' → ${project}`).not.toBe(
    true,
  );

  // Resolve name-or-uuid the same way the product does, then assert the connection's rung-3
  // slot holds EXACTLY that id. `toBeTruthy()` would pass on a switch that landed somewhere
  // else entirely, which is the failure being guarded against.
  const wanted = await projectHandler.getProject(project);
  expect(wanted, `project '${project}' does not exist — fixture setup ran out of order`).toBeTruthy();

  const landed = await projectHandler.getInteractiveProjectId(connectionId);
  expect(
    landed,
    `connection '${connectionId}' resolves to ${landed ?? '<nothing>'}, not ` +
      `${wanted!.id} (${wanted!.name}) — ` + AMBIENT_INHERITANCE_DIAGNOSIS,
  ).toBe(wanted!.id);
}
