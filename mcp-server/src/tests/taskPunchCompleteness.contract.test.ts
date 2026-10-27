/**
 * PUNCH LIST COMPLETENESS Contract Test (migration 101, 
 * an earlier task — the STRUCTURED punch contract).
 *
 * "DRAFT SAYS WHICH FIELD IS MISSING": setting stage='ready' requires title +
 * metadata.punch.doneWhen (a NON-EMPTY ARRAY of `{ text, owner: lane|human, proof? }`
 * clauses — owner required, proof required when owner is 'lane') + metadata.punch.proofKind
 * + a resolved project, or the write is refused with [PUNCH_INCOMPLETE] naming the EXACT
 * field path (e.g. `doneWhen[1].proof`) and NOTHING is written. Every other stage is
 * unguarded — a legacy bare-STRING doneWhen keeps working there.
 *
 * ALSO covered here: `punch.dependsOn` is mirrored from `dependencies`
 * (never caller-settable directly — refused with [PUNCH_DEPENDS_ON_DIRECT]), and
 * `metadata:{punch:{...}}` is folded into the SAME punch merge as the `punch` argument so a
 * note-only update through the `metadata` channel cannot clobber sibling punch sub-keys
 * (intake/walkthrough/merge) the picker owns.
 *
 * Exercised through the PUBLIC TOOL SURFACE (routeExecutor + validateToolArguments), not the
 * handler directly — the same discipline taskClosedAtLifecycle.contract.test.ts documents:
 * calling the handler bypasses exactly the validation/routing layer a real caller goes
 * through, so a schema regression (e.g. `punch` silently dropped from the zod schema) would
 * pass a handler-level test while being unreachable for real.
 *
 * ── MUTATION PROBE (round 2 — recorded per the punch's own clause 7) ──────
 * Run: `npx vitest run --testTimeout=60000 src/tests/taskPunchCompleteness.contract.test.ts`
 *   A. owner check deleted (services/taskPunchCompleteness.ts#missingDoneWhenClauseFields,
 *      the `if (c.owner !== 'lane' && c.owner !== 'human') missing.push(...)` line removed):
 *      RED — 2 failed | 24 passed. Failures: "a clause with NO owner is refused naming
 *      doneWhen[0].owner, nothing written" and "the same four malformed shapes are each
 *      refused, row unchanged" (task_update leg).
 *   B. metadata.punch clobber fix reverted (routes/tasks.routes.ts task_update handler:
 *      `splitMetadataPunch(args.metadata, args.punch)` swapped for the pre-fix
 *      `{ metadata: args.metadata, punch: args.punch }`, restoring the raw top-level
 *      metadata merge that used to delete sibling punch sub-keys): RED — 1 failed | 25
 *      passed. Failure: "a metadata:{punch:{doneWhen:[...]}} update leaves
 *      intake/walkthrough/merge intact".
 *   Control (both mutations reverted, working tree clean — `git status --short` empty):
 *      GREEN — 52 passed (0 failed) across this file + taskFieldsReadable +
 *      outputSchemaWireTrim + toolSurfaceGolden.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = Date.now();
const PROJ_NAME = `punch-completeness-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  return routeExecutor(toolName, validateToolArguments(toolName, rawArgs));
}

async function readRow(id: string) {
  const r = await db.query(
    `SELECT stage, status, title, metadata FROM tasks WHERE id = $1`, [id]);
  return r.rows[0] as { stage: string | null; status: string; title: string; metadata: any };
}

async function countByTitle(title: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM tasks WHERE project_id = $1 AND title = $2`,
    [projectId, title]);
  return r.rows[0].c;
}

/** A well-formed lane clause — the shape most tests need. */
const laneClause = (text: string, proof: string) => ({ text, owner: 'lane', proof });
const humanClause = (text: string) => ({ text, owner: 'human' });

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'punch completeness contract') RETURNING id`,
    [PROJ_NAME]);
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('task_create — the completeness gate', () => {
  test('stage:ready with NO punch is refused, nothing written', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'incomplete task', stage: 'ready',
    });
    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.text ?? '';
    expect(text).toContain('PUNCH_INCOMPLETE');
    expect(text).toContain('doneWhen');
    expect(text).toContain('proofKind');
    expect(await countByTitle('incomplete task')).toBe(0); // NOTHING WAS WRITTEN
  });

  test('stage:ready with doneWhen but no proofKind names only proofKind as missing', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'half task', stage: 'ready',
      punch: { doneWhen: [laneClause('when the tests pass', 'src/x.test.ts')] },
    });
    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.text ?? '';
    expect(text).toContain('proofKind');
    expect(text).not.toMatch(/missing:[^.]*doneWhen/); // doneWhen was supplied; not in the missing list
  });

  test('stage:ready with a well-formed structured doneWhen[] succeeds', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'complete task', stage: 'ready',
      punch: { doneWhen: [laneClause('when green', 'src/tests/x.test.ts')], proofKind: 'test' },
    });
    expect(res.isError).toBeFalsy();
    const taskId = res.structuredContent?.task?.id;
    expect(taskId).toBeTruthy();
    const row = await readRow(taskId);
    expect(row.stage).toBe('ready');
    expect(row.status).toBe('todo');
    expect(row.metadata.punch.doneWhen).toEqual([laneClause('when green', 'src/tests/x.test.ts')]);
    expect(row.metadata.punch.proofKind).toBe('test');
  });

  test('stage:draft is UNGUARDED — no punch required', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'a draft', stage: 'draft',
    });
    expect(res.isError).toBeFalsy();
    const taskId = res.structuredContent?.task?.id;
    const row = await readRow(taskId);
    expect(row.stage).toBe('draft');
  });
});

describe('the structured doneWhen contract — malformed shapes refused AT ready', () => {
  test('task_create: a plain STRING doneWhen is refused naming doneWhen, nothing written', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'string-doneWhen-create', stage: 'ready',
      punch: { doneWhen: 'when the tests pass', proofKind: 'test' },
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('doneWhen');
    expect(await countByTitle('string-doneWhen-create')).toBe(0);
  });

  test('task_create: an EMPTY ARRAY doneWhen is refused naming doneWhen, nothing written', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'empty-doneWhen-create', stage: 'ready',
      punch: { doneWhen: [], proofKind: 'test' },
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('doneWhen');
    expect(await countByTitle('empty-doneWhen-create')).toBe(0);
  });

  test('task_create: a clause with NO owner is refused naming doneWhen[0].owner, nothing written', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'no-owner-create', stage: 'ready',
      punch: { doneWhen: [{ text: 'no owner named' }], proofKind: 'test' },
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('doneWhen[0].owner');
    expect(await countByTitle('no-owner-create')).toBe(0);
  });

  test('task_create: a LANE clause with no proof is refused naming doneWhen[1].proof, nothing written', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'lane-no-proof-create', stage: 'ready',
      punch: {
        doneWhen: [humanClause('a human clause, fine without proof'), { text: 'a lane clause', owner: 'lane' }],
        proofKind: 'test',
      },
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('doneWhen[1].proof');
    expect(await countByTitle('lane-no-proof-create')).toBe(0);
  });

  test('task_create: a HUMAN clause with no proof is FINE (proof only required for lane)', async () => {
    const res = await viaPublicTool('task_create', {
      projectId, title: 'human-no-proof-create', stage: 'ready',
      punch: { doneWhen: [humanClause('a human will confirm this')], proofKind: 'look' },
    });
    expect(res.isError).toBeFalsy();
  });

  test('task_update: the same four malformed shapes are each refused, row unchanged', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'malformed-on-update', stage: 'draft',
    });
    const taskId = createRes.structuredContent?.task?.id;
    const before = await readRow(taskId);

    const malformed = [
      { doneWhen: 'a plain string', proofKind: 'test' },
      { doneWhen: [], proofKind: 'test' },
      { doneWhen: [{ text: 'no owner' }], proofKind: 'test' },
      { doneWhen: [{ text: 'lane, no proof', owner: 'lane' }], proofKind: 'test' },
    ];
    for (const punch of malformed) {
      const res = await viaPublicTool('task_update', { projectId, taskId, stage: 'ready', punch });
      expect(res.isError, JSON.stringify(punch)).toBe(true);
      expect(res.content?.[0]?.text ?? '').toContain('PUNCH_INCOMPLETE');
      const after = await readRow(taskId);
      expect(after.stage).toBe(before.stage); // UNCHANGED — nothing written
    }
  });
});

describe('task_create — structured doneWhen round-trips through task_details byte-for-byte', () => {
  test('a multi-clause doneWhen[] comes back identical', async () => {
    const doneWhen = [
      laneClause('the suite is green', 'mcp-server/src/tests/x.contract.test.ts'),
      humanClause('Operator eyeballs the screenshot'),
    ];
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'round-trip task', stage: 'ready',
      punch: { doneWhen, proofKind: 'test' },
    });
    expect(createRes.isError).toBeFalsy();
    const taskId = createRes.structuredContent?.task?.id;

    const details = await viaPublicTool('task_details', { projectId, taskId });
    expect(details.structuredContent?.task?.metadata?.punch?.doneWhen).toEqual(doneWhen);

    const row = await readRow(taskId);
    expect(row.metadata.punch.doneWhen).toEqual(doneWhen);
  });
});

describe('legacy STRING doneWhen — unguarded off-ready (an earlier task acceptance 3)', () => {
  test('a row at stage=claimed with a legacy string doneWhen accepts a note-only update unchanged', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'legacy-string-claimed', stage: 'claimed',
      metadata: { punch: { doneWhen: 'when it ships (legacy shape)', proofKind: 'test' } },
    });
    expect(createRes.isError).toBeFalsy();
    const taskId = createRes.structuredContent?.task?.id;
    expect((await readRow(taskId)).metadata.punch.doneWhen).toBe('when it ships (legacy shape)');

    // Note-only edit — does not touch stage, so the gate (which only fires when the
    // RESULTING stage is 'ready') never runs, and the legacy string is left alone.
    const res = await viaPublicTool('task_update', {
      projectId, taskId, notes: 'still on track',
    });
    expect(res.isError).toBeFalsy();
    const row = await readRow(taskId);
    expect(row.stage).toBe('claimed'); // untouched
    expect(row.metadata.punch.doneWhen).toBe('when it ships (legacy shape)'); // untouched
  });
});

describe('task_update — evaluated against the MERGED state, not this call alone', () => {
  test('filling punch on an earlier call, then flipping stage alone, succeeds', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'progressive fill', stage: 'draft',
    });
    const taskId = createRes.structuredContent?.task?.id;

    // Fill the punch fields WITHOUT touching stage.
    const fillRes = await viaPublicTool('task_update', {
      projectId, taskId,
      punch: { doneWhen: [laneClause('when it ships', 'src/x.test.ts')], proofKind: 'browser' },
    });
    expect(fillRes.isError).toBeFalsy();
    expect((await readRow(taskId)).stage).toBe('draft'); // still draft

    // NOW flip stage alone — must succeed off the punch fields the PRIOR call stored.
    const readyRes = await viaPublicTool('task_update', { projectId, taskId, stage: 'ready' });
    expect(readyRes.isError).toBeFalsy();
    const row = await readRow(taskId);
    expect(row.stage).toBe('ready');
    expect(row.status).toBe('todo');
  });

  test('stage:ready on a task with no punch at all is refused, nothing written', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'bare draft', stage: 'draft',
    });
    const taskId = createRes.structuredContent?.task?.id;
    const before = await readRow(taskId);

    const res = await viaPublicTool('task_update', { projectId, taskId, stage: 'ready' });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('PUNCH_INCOMPLETE');
    const after = await readRow(taskId);
    expect(after.stage).toBe(before.stage); // UNCHANGED — nothing written
  });

  test('punch is a SHALLOW MERGE — setting doneWhen alone does not erase an existing proofKind', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'merge test', stage: 'ready',
      punch: { doneWhen: [laneClause('v1', 'src/x.test.ts')], proofKind: 'test' },
    });
    const taskId = createRes.structuredContent?.task?.id;

    await viaPublicTool('task_update', {
      projectId, taskId, punch: { doneWhen: [laneClause('v2', 'src/y.test.ts')] },
    });
    const row = await readRow(taskId);
    expect(row.metadata.punch.doneWhen).toEqual([laneClause('v2', 'src/y.test.ts')]);
    expect(row.metadata.punch.proofKind).toBe('test'); // NOT erased
  });

  test('explicit null on a punch field DELETES it', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'delete test', stage: 'ready',
      punch: { doneWhen: [laneClause('v1', 'src/x.test.ts')], proofKind: 'test', source: 'chat' },
    });
    const taskId = createRes.structuredContent?.task?.id;

    await viaPublicTool('task_update', { projectId, taskId, punch: { source: null } });
    const row = await readRow(taskId);
    expect(row.metadata.punch.source).toBeUndefined();
    expect(row.metadata.punch.doneWhen).toEqual([laneClause('v1', 'src/x.test.ts')]); // siblings untouched
  });

  // CLAUSE 10: the gate keys on the MERGED row's stage, not the call's own
  // `stage` argument — a write that OMITS `stage` on a row ALREADY at `ready` must still be
  // refused if it would leave `doneWhen` malformed. Checking only `stage === 'ready'` on the
  // call left this write ungated.
  test('a write omitting `stage` on a row ALREADY at ready is refused if it would leave doneWhen malformed', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'already ready, then corrupted', stage: 'ready',
      punch: { doneWhen: [laneClause('v1', 'src/x.test.ts')], proofKind: 'test' },
    });
    const taskId = createRes.structuredContent?.task?.id;
    expect((await readRow(taskId)).stage).toBe('ready');

    // No `stage` in this call — the row is already `ready`. doneWhen becomes a bare string,
    // which is malformed AT ready (unguarded everywhere else).
    const res = await viaPublicTool('task_update', {
      projectId, taskId, punch: { doneWhen: 'just do it' },
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('PUNCH_INCOMPLETE');
    const after = await readRow(taskId);
    expect(after.metadata.punch.doneWhen).toEqual([laneClause('v1', 'src/x.test.ts')]); // UNCHANGED
  });

  test('a write omitting `stage` on a row ALREADY at ready still succeeds when doneWhen stays well-formed', async () => {
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'already ready, note-only update', stage: 'ready',
      punch: { doneWhen: [laneClause('v1', 'src/x.test.ts')], proofKind: 'test' },
    });
    const taskId = createRes.structuredContent?.task?.id;

    const res = await viaPublicTool('task_update', { projectId, taskId, notes: 'still on track' });
    expect(res.isError).toBeFalsy();
    const after = await readRow(taskId);
    expect(after.stage).toBe('ready');
    expect(after.metadata.punch.doneWhen).toEqual([laneClause('v1', 'src/x.test.ts')]);
  });
});

describe('punch.dependsOn — SERVER-MIRRORED from `dependencies`, never caller-set directly (an earlier task acceptance 4)', () => {
  test('task_create with dependencies:[id] AND punch fields mirrors dependsOn alongside them', async () => {
    const dep = await viaPublicTool('task_create', { projectId, title: 'dep target A', stage: 'draft' });
    const depId = dep.structuredContent?.task?.id;

    const res = await viaPublicTool('task_create', {
      projectId, title: 'has dep on create', stage: 'draft', dependencies: [depId],
      punch: { proofKind: 'test' },
    });
    expect(res.isError).toBeFalsy();
    const taskId = res.structuredContent?.task?.id;
    const row = await readRow(taskId);
    expect(row.metadata.punch.dependsOn).toEqual([depId]);
    expect(row.metadata.punch.proofKind).toBe('test'); // sibling punch field this call also set
  });

  // CLAUSE 11: the dependencies mirror must not SYNTHESIZE a metadata.punch
  // object on a task that has none — a plain (non-punch) task that merely names a dependency
  // gains no punch key. Supersedes the pre-clause-11 expectation that every dependencies-
  // bearing create/update got a punch object; see utils/punchMerge.ts reconcilePunchDependsOn
  // and handlers/tasks.ts's dependsOnMirrorOnly handling.
  test('task_create with dependencies:[id] ALONE (no punch fields) creates NO metadata.punch (clause 11)', async () => {
    const dep = await viaPublicTool('task_create', { projectId, title: 'dep target A2', stage: 'draft' });
    const depId = dep.structuredContent?.task?.id;

    const res = await viaPublicTool('task_create', {
      projectId, title: 'plain task with dep on create', stage: 'draft', dependencies: [depId],
    });
    expect(res.isError).toBeFalsy();
    const taskId = res.structuredContent?.task?.id;
    const row = await readRow(taskId);
    expect(row.metadata?.punch).toBeUndefined();
  });

  test('task_update with dependencies mirrors into punch.dependsOn when the row already carries a punch', async () => {
    const dep = await viaPublicTool('task_create', { projectId, title: 'dep target B', stage: 'draft' });
    const depId = dep.structuredContent?.task?.id;
    const punchy = await viaPublicTool('task_create', {
      projectId, title: 'already a punch for dep mirror', stage: 'draft',
      punch: { proofKind: 'test' },
    });
    const taskId = punchy.structuredContent?.task?.id;

    const res = await viaPublicTool('task_update', { projectId, taskId, dependencies: [depId] });
    expect(res.isError).toBeFalsy();
    const row = await readRow(taskId);
    expect(row.metadata.punch.dependsOn).toEqual([depId]);
    expect(row.metadata.punch.proofKind).toBe('test'); // pre-existing sibling untouched
  });

  // CLAUSE 11: same rule on the update path — a plain task (no existing
  // punch, and this call names no punch field) that merely gets a `dependencies` edit must
  // not gain a metadata.punch key it never had.
  test('task_update with dependencies ALONE on a plain task (no existing punch) creates NO metadata.punch (clause 11)', async () => {
    const dep = await viaPublicTool('task_create', { projectId, title: 'dep target B2', stage: 'draft' });
    const depId = dep.structuredContent?.task?.id;
    const bare = await viaPublicTool('task_create', { projectId, title: 'bare for dep mirror clause11', stage: 'draft' });
    const taskId = bare.structuredContent?.task?.id;

    const res = await viaPublicTool('task_update', { projectId, taskId, dependencies: [depId] });
    expect(res.isError).toBeFalsy();
    const row = await readRow(taskId);
    expect(row.metadata?.punch).toBeUndefined();
  });

  test('task_create: setting punch.dependsOn directly (no `dependencies`) is REFUSED, nothing written', async () => {
    const dep = await viaPublicTool('task_create', { projectId, title: 'dep target C', stage: 'draft' });
    const depId = dep.structuredContent?.task?.id;

    const res = await viaPublicTool('task_create', {
      projectId, title: 'direct-dependsOn-create', stage: 'draft', punch: { dependsOn: [depId] },
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('PUNCH_DEPENDS_ON_DIRECT');
    expect(await countByTitle('direct-dependsOn-create')).toBe(0);
  });

  test('task_update: setting punch.dependsOn directly (no `dependencies` in this call) is REFUSED, row unchanged', async () => {
    const dep = await viaPublicTool('task_create', { projectId, title: 'dep target D', stage: 'draft' });
    const depId = dep.structuredContent?.task?.id;
    const bare = await viaPublicTool('task_create', { projectId, title: 'bare for dep refuse', stage: 'draft' });
    const taskId = bare.structuredContent?.task?.id;

    const res = await viaPublicTool('task_update', {
      projectId, taskId, punch: { dependsOn: [depId] },
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('PUNCH_DEPENDS_ON_DIRECT');
    expect((await readRow(taskId)).metadata.punch?.dependsOn).toBeUndefined();
  });

  test('task_bulk_update: setting punch.dependsOn is ALWAYS refused (no `dependencies` channel exists in bulk)', async () => {
    const dep = await viaPublicTool('task_create', { projectId, title: 'dep target E', stage: 'draft' });
    const depId = dep.structuredContent?.task?.id;
    const bulkTarget = await viaPublicTool('task_create', { projectId, title: 'bulk dep refuse', stage: 'draft' });
    const bulkId = bulkTarget.structuredContent?.task?.id;

    const res = await viaPublicTool('task_bulk_update', {
      projectId, task_ids: [bulkId], punch: { dependsOn: [depId] },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('PUNCH_DEPENDS_ON_DIRECT');
    expect((await readRow(bulkId)).metadata.punch?.dependsOn).toBeUndefined();
  });
});

describe('metadata.punch clobber protection (an earlier task acceptance 5)', () => {
  test('a metadata:{punch:{doneWhen:[...]}} update leaves intake/walkthrough/merge intact', async () => {
    // Simulate a row the picker has already annotated — intake/walkthrough/merge sub-keys
    // arrive through the SAME free-form `metadata` channel the picker itself uses (metadata
    // is a permissive bag; `punch`'s own zod schema does not declare these sub-keys).
    const createRes = await viaPublicTool('task_create', {
      projectId, title: 'picker-annotated', stage: 'ready',
      metadata: {
        punch: {
          intake: { by: 'lane-1', at: '2026-09-01T00:00:00Z' },
          walkthrough: { status: 'pass', round: 2 },
          merge: { by: 'coordinator' },
        },
      },
      punch: { doneWhen: [laneClause('v1', 'src/x.test.ts')], proofKind: 'test' },
    });
    expect(createRes.isError).toBeFalsy();
    const taskId = createRes.structuredContent?.task?.id;
    const before = await readRow(taskId);
    expect(before.metadata.punch.intake).toEqual({ by: 'lane-1', at: '2026-09-01T00:00:00Z' });
    expect(before.metadata.punch.walkthrough).toEqual({ status: 'pass', round: 2 });
    expect(before.metadata.punch.merge).toEqual({ by: 'coordinator' });

    // The historically-destructive call: a note-only-looking update through the `metadata`
    // argument that touches `punch.doneWhen`. Before the fix this reached metadataMergeSql's
    // top-level `||`, which REPLACES the whole `punch` value and deletes intake/walkthrough/
    // merge. Now it is folded into the same sub-key merge the `punch` argument uses.
    const res = await viaPublicTool('task_update', {
      projectId, taskId,
      metadata: { punch: { doneWhen: [laneClause('v2', 'src/y.test.ts')] } },
    });
    expect(res.isError).toBeFalsy();

    const after = await readRow(taskId);
    expect(after.metadata.punch.intake).toEqual({ by: 'lane-1', at: '2026-09-01T00:00:00Z' });
    expect(after.metadata.punch.walkthrough).toEqual({ status: 'pass', round: 2 });
    expect(after.metadata.punch.merge).toEqual({ by: 'coordinator' });
    // AND the actual edit took effect — this is a merge-through, not a silent no-op.
    expect(after.metadata.punch.doneWhen).toEqual([laneClause('v2', 'src/y.test.ts')]);
    expect(after.metadata.punch.proofKind).toBe('test'); // sibling from the `punch` argument, untouched
  });
});

describe('task_bulk_update — refuses the WHOLE call if ANY targeted row is incomplete', () => {
  test('one complete + one incomplete row: neither is written', async () => {
    const complete = await viaPublicTool('task_create', {
      projectId, title: 'bulk complete', stage: 'draft',
      punch: { doneWhen: [laneClause('x', 'src/x.test.ts')], proofKind: 'look' },
    });
    const incomplete = await viaPublicTool('task_create', {
      projectId, title: 'bulk incomplete', stage: 'draft',
    });
    const completeId = complete.structuredContent?.task?.id;
    const incompleteId = incomplete.structuredContent?.task?.id;

    const res = await viaPublicTool('task_bulk_update', {
      projectId, task_ids: [completeId, incompleteId], stage: 'ready',
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? '').toContain('PUNCH_INCOMPLETE');

    // NEITHER row was moved — all-or-nothing, matching this tool's existing contract.
    expect((await readRow(completeId)).stage).toBe('draft');
    expect((await readRow(incompleteId)).stage).toBe('draft');
  });

  test('all rows complete: the whole sweep succeeds', async () => {
    const a = await viaPublicTool('task_create', {
      projectId, title: 'bulk a', stage: 'draft',
      punch: { doneWhen: [laneClause('x', 'src/x.test.ts')], proofKind: 'look' },
    });
    const b = await viaPublicTool('task_create', {
      projectId, title: 'bulk b', stage: 'draft',
      punch: { doneWhen: [humanClause('y')], proofKind: 'test' },
    });
    const res = await viaPublicTool('task_bulk_update', {
      projectId, task_ids: [a.structuredContent?.task?.id, b.structuredContent?.task?.id], stage: 'ready',
    });
    expect(res.isError).toBeFalsy();
    expect((await readRow(a.structuredContent?.task?.id)).stage).toBe('ready');
    expect((await readRow(b.structuredContent?.task?.id)).stage).toBe('ready');
  });
});

describe('task_list — the stage filter', () => {
  test('filters by a single stage', async () => {
    await viaPublicTool('task_create', {
      projectId, title: 'list-ready', stage: 'ready',
      punch: { doneWhen: [laneClause('x', 'src/x.test.ts')], proofKind: 'test' },
    });
    await viaPublicTool('task_create', { projectId, title: 'list-draft', stage: 'draft' });

    const res = await viaPublicTool('task_list', { projectId, stage: 'ready', limit: 100 });
    const titles = (res.structuredContent?.results ?? []).map((t: any) => t.title);
    expect(titles).toContain('list-ready');
    expect(titles).not.toContain('list-draft');
  });

  test('filters by an array of stages', async () => {
    const res = await viaPublicTool('task_list', {
      projectId, stage: ['ready', 'draft'], limit: 100,
    });
    const titles = (res.structuredContent?.results ?? []).map((t: any) => t.title);
    expect(titles).toContain('list-ready');
    expect(titles).toContain('list-draft');
  });
});
