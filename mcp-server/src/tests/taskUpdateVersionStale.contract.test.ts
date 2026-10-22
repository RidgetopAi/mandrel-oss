/**
 * task_update's ORDINARY writes still feed task_claim's `version-stale` CAS refusal, across
 * every field 28ad3543 touched — contract test.
 *
 * THE INCIDENT. The fleet-deploy gate (2026-09-21 11:34Z, bba47deb) aborted on
 * src/tests/taskAtomicClaimStress.contract.test.ts's test 2: "a claim presented against a
 * superseded version > is refused with `version-stale`" — 0 refusals counted where the
 * contract requires at least one. GREEN on 856f7d84, RED on bba47deb; the suspect was
 * 28ad3543, which rewrote task_update's write path (mcp-server/src/handlers/tasks.ts).
 *
 * REPRODUCED. That test's `makeTask('version stale')` inserts a bare task with
 * status='todo' and no `stage`. The `tasks_sync_stage_status` trigger (migration 101)
 * backfills such a row to `stage='ready'` on INSERT. Before 28ad3543, TasksHandler
 * .updateTaskStatus's punch-completeness gate only fired when THIS CALL's own `stage`
 * argument was `'ready'` (`if (stage === PUNCH_GATE_STAGE)`), so the test's title-only
 * `task_update({ title: 'moved underneath you' })` — meant only to move the row's `version`
 * out from under the caller — sailed through untouched.
 *
 * 28ad3543 (clause 10) re-keyed that gate on the row's MERGED stage
 * instead — `const resultingStage = stage !== undefined ? stage : existingRow.stage; if
 * (resultingStage === PUNCH_GATE_STAGE) { ... assertPunchComplete(...) }` — deliberately, so
 * a metadata/punch edit against an already-`ready` row cannot leave `doneWhen` malformed
 * just because the call omits `stage`. But it also means the stress test's fixture task —
 * `ready` by trigger-side accident, not by test intent, with no `metadata.punch` — now gets
 * its title-only update REFUSED with `PUNCH_INCOMPLETE` before the UPDATE ever runs. The
 * refusal is RE-CLASSIFIED, not skipped or reordered: `task_update` fails for a DIFFERENT
 * typed reason than version-stale, so the version never bumps, and the "stale" claim the
 * test presents next is — by then — not stale at all. That's why the failure read as "0
 * version-stale refusals" rather than a `version-stale` assertion actually firing wrong:
 * the setup step that would have produced a stale read never completed.
 *
 * This exact fixture class (a bare INSERT landing at `stage='ready'`, then an ordinary
 * title/metadata/punch/dependencies-touching task_update against it) was already identified
 * and fixed in an earlier commit for taskUpdateType, taskUpdateNotesAppend, driftCleanup,
 * metadataMergeParamBind, t1Fluidity, taskClaimFenceFields, taskBlockerRequired, and the
 * SIBLING single-process file taskAtomicClaim.contract.test.ts (its own §5 "D4" test pins
 * `stage: 'draft'`). taskAtomicClaimStress.contract.test.ts was the one file in that class
 * ec095522 could not have caught: it spawns real OS processes, which the confined lane that
 * produced ec095522 cannot run (no process-group reaping) — so it never met clause 10 until
 * the authoritative full gate did.
 *
 * THIS FILE is the NON-stress, single-process proof the punch requires: it drives the same
 * task_update -> task_claim(expectedVersion) sequence directly against production code (not
 * the stress harness's subprocess plumbing), and — per clause 3 of the punch — repeats it
 * once for each field 28ad3543 changed (`stage`, `punch`, `metadata.punch`, `dependencies`)
 * so the version-bumping call is proven to survive the completeness gate regardless of which
 * of those fields it names.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `taskupd-verstale-${STAMP}`;
let projectId: string;

const SAVED_CLAIM_ENABLED = TASK_CLAIM_CONFIG.enabled;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

/** A well-formed punch — satisfies assertPunchComplete outright, so a row seeded with this
 * stays punch-complete at `stage='ready'` no matter what this file's cases do to it next. */
const COMPLETE_PUNCH = {
  doneWhen: [{ text: 'proof pasted in the commit body', owner: 'human' }],
  proofKind: 'test',
};

/**
 * Insert a task directly, so each case controls its own starting `stage`/`metadata` rather
 * than inheriting whatever `tasks_sync_stage_status` would derive from `status` alone.
 *
 * `stage` defaults to `'draft'` — NOT left to the trigger's derivation — because a bare
 * status='todo' INSERT backfills to `stage='ready'` (migration 101), which is exactly the
 * fixture accident this file exists to route around (see the file header). A case that
 * specifically wants to exercise a `ready` row passes `stage: 'ready'` and `metadata`
 * explicitly.
 */
async function makeTask(title: string, stage: string | null = 'draft', metadata: Record<string, any> | null = null): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, stage, metadata)
     VALUES ($1, $2, 'general', 'medium', 'todo', $3, COALESCE($4::jsonb, '{}'::jsonb)) RETURNING id`,
    [projectId, title, stage, metadata ? JSON.stringify(metadata) : null],
  );
  return r.rows[0].id;
}

async function readTask(taskId: string) {
  const r = await db.query(
    `SELECT status, version, stage, metadata, claim_id::text AS claim_id FROM tasks WHERE id = $1`,
    [taskId],
  );
  return r.rows[0];
}

beforeAll(async () => {
  projectId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'task_update version-stale') RETURNING id`, [PROJ_NAME])
  ).rows[0].id;
  TASK_CLAIM_CONFIG.enabled = true;
});

afterAll(async () => {
  TASK_CLAIM_CONFIG.enabled = SAVED_CLAIM_ENABLED;
  await db.query(`DELETE FROM task_claim_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`, [projectId]);
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

/**
 * Runs the shared sequence every case below needs: read v0, run `bump()` (an ordinary
 * task_update expected to SUCCEED and move the version), assert the version actually moved,
 * present the STALE version to task_claim and assert `version-stale` with nothing written,
 * then present the CURRENT version and assert it wins (the control half of clause 2).
 */
async function assertVersionStaleSurvives(taskId: string, bump: () => Promise<any>): Promise<void> {
  const before = await readTask(taskId);
  const v0 = before.version;

  const bumpResult = await bump();
  expect(bumpResult.isError, `the version-bumping task_update must succeed: ${JSON.stringify(bumpResult)}`).not.toBe(true);

  const afterBump = await readTask(taskId);
  const v1 = afterBump.version;
  expect(v1, 'the ordinary task_update must move the version — it is what makes v0 stale').toBeGreaterThan(v0);

  const stale = await viaPublicTool('task_claim', { projectId, taskId, actor: 'staleworker', expectedVersion: v0 });
  expect(stale.structuredContent.claimed).toBe(false);
  expect(stale.structuredContent.reason).toBe('version-stale');
  const afterStale = await readTask(taskId);
  expect(afterStale.claim_id, 'a rejected stale claim must not have written anything').toBeNull();
  expect(afterStale.version, 'a rejected stale claim must not have bumped the version either').toBe(v1);

  // The CONTROL (clause 2's "same call with the current version succeeds"): the guard
  // rejects STALENESS specifically, not the claim outright.
  const fresh = await viaPublicTool('task_claim', { projectId, taskId, actor: 'freshworker', expectedVersion: v1 });
  expect(fresh.structuredContent.claimed).toBe(true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// (2) THE CONTROL — an ordinary task_update bumps the version; a stale claim is refused,
//     a fresh one succeeds.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('a task_update bump feeds task_claim version-stale correctly', () => {
  test('a claim presented against a superseded version is refused `version-stale`; the same call with the current version succeeds', async () => {
    const taskId = await makeTask('version stale — control');
    await assertVersionStaleSurvives(taskId, () =>
      viaPublicTool('task_update', { projectId, taskId, title: 'moved underneath you' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// (3) THE FIELD MATRIX — the SAME sequence, once per field 28ad3543 changed. Each case's
//     version-bumping task_update NAMES that field; the assertion is that doing so still
//     succeeds (does not trip PUNCH_INCOMPLETE) and version-stale still fires correctly
//     afterward.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('the refusal survives regardless of which field the bumping call carries (an earlier task clause 10/11)', () => {
  test('the call carries `stage` (draft -> ready, off an already-complete punch)', async () => {
    const taskId = await makeTask('version stale — stage', 'draft', { punch: COMPLETE_PUNCH });
    await assertVersionStaleSurvives(taskId, () =>
      viaPublicTool('task_update', { projectId, taskId, stage: 'ready' }),
    );
  });

  test('the call carries `punch` (already `ready`, editing a punch sub-key)', async () => {
    const taskId = await makeTask('version stale — punch', 'ready', { punch: COMPLETE_PUNCH });
    await assertVersionStaleSurvives(taskId, () =>
      viaPublicTool('task_update', { projectId, taskId, punch: { touches: ['src/tests/taskUpdateVersionStale.contract.test.ts'] } }),
    );
  });

  test('the call carries `metadata.punch` (the alternate channel, same already-`ready` row)', async () => {
    const taskId = await makeTask('version stale — metadata.punch', 'ready', { punch: COMPLETE_PUNCH });
    await assertVersionStaleSurvives(taskId, () =>
      viaPublicTool('task_update', { projectId, taskId, metadata: { punch: { touches: ['src/tests/taskUpdateVersionStale.contract.test.ts'] } } }),
    );
  });

  test('the call carries `dependencies` (mirrored into punch.dependsOn on a punch-less draft row)', async () => {
    const depTarget = await makeTask('version stale — dep target');
    const taskId = await makeTask('version stale — dependencies');
    await assertVersionStaleSurvives(taskId, () =>
      viaPublicTool('task_update', { projectId, taskId, dependencies: [depTarget] }),
    );
  });
});
