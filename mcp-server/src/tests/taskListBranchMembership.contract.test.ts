/**
 * task_list EXPOSES THE DECLARED BRANCH MEMBERSHIP, VIA A JOIN (step 1).
 *
 * THE MISCOUNT THIS UNBLOCKS. A task's branch is carried TWO unrelated ways — a
 * `branch:<slug>` TAG naming a workstream, and a `branch_memberships` row naming the SPINE
 * RECORD the task was written on. Only the tag was readable off a LIST, because the tag
 * happens to live in `tags`. So every branch-keyed consumer of task_list answered "which
 * branch?" from the tag alone. Measured by Reviewer by RUNNING runtime's branch-board:
 * its `no-branch open = 100`, printed under the label "drift signal", counted 14 tasks with
 * a DECLARED membership as belonging to nothing.
 *
 * ═══ WHAT IS ASSERTED, AND WHY IT IS NOT "THE KEY IS THERE" ══════════════════════════
 * A guard that asserts a key is PRESENT passes a serializer that emits `null` for every
 * row — which is precisely the failure being fixed one layer up, since a consumer reading
 * `null` counts the task as branchless. So every case below asserts the VALUE, and the
 * three states are pinned as three DIFFERENT answers:
 *
 *   key ABSENT            — the read did not join membership. Nobody measured.
 *   value `null`          — it DID join, and this task is a member of no branch. A fact.
 *   an object with a spine — the branch it was written on.
 *
 * Both directions are probed, per this batch's rule to count the DIRECTIONS mutated rather
 * than the probes: a member row must not come back hollow, AND a non-member row must not
 * come back with somebody else's spine. See src/tests/manual/membership-join-mutation-probe.sh.
 *
 * ═══ AND IT PINS THE JOIN SHUT ═══════════════════════════════════════════════════════
 * `total` comes from countTasks(), which does NOT join. A join that fanned out would make
 * the page and the total disagree — a task listed twice, another pushed off the page, and a
 * `total` that no longer describes the rows. branch_memberships_pkey is PRIMARY KEY
 * (record_id), so it cannot; that is asserted here rather than trusted, because it is the
 * property that makes joining safe at all.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { tasksHandler } from '../handlers/tasks.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { MEMBERSHIP_SOURCE } from '../config/membershipSourceConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `task-list-membership-${STAMP}`;

let projectId: string;
let spineTaskId: string;   // the branch root — itself a member of nothing
let memberTaskId: string;  // declared member of the spine
let looseTaskId: string;   // member of nothing, and carries no branch: tag either
let taggedOnlyId: string;  // carries a branch: TAG but has NO declared membership

async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  return handler(validateToolArguments(toolName, rawArgs));
}

async function listRows(): Promise<any[]> {
  const resp = await viaPublicTool('task_list', { projectId, limit: 100 }, (a) => tasksRoutes.handleList(a));
  return resp?.structuredContent?.results ?? [];
}

function row(rows: any[], id: string): any {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`task ${id} not in the list`);
  return r;
}

async function mkTask(title: string, tags: string[] = []): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, tags)
     VALUES ($1, $2, 'general', 'medium', 'todo', $3::text[]) RETURNING id::text AS id`,
    [projectId, title, tags],
  );
  return rows[0].id;
}

describe('task_list exposes declared branch membership', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'membership join guard') RETURNING id`,
      [PROJ_NAME],
    )).rows[0].id;

    spineTaskId = await mkTask('spine task');
    memberTaskId = await mkTask('declared member, NO branch: tag');
    looseTaskId = await mkTask('member of nothing, no tag');
    taggedOnlyId = await mkTask('branch: TAG only, no declared membership', ['branch:some-workstream']);

    await db.query(
      `INSERT INTO branch_memberships
         (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type, source, project_id)
       VALUES ($1, 'task', $2, 'task', $2, 'task', $3, $4)`,
      [memberTaskId, spineTaskId, MEMBERSHIP_SOURCE.recorded, projectId],
    );

    // WITNESS THE FIXTURE. Exactly one membership row exists in this project; if the insert
    // had silently not landed, "no membership" would look like a correct answer everywhere
    // below and every assertion would pass against an empty population.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM branch_memberships WHERE project_id = $1`, [projectId],
    );
    expect(rows[0].n).toBe(1);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM branch_memberships WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('a DECLARED member carries its spine — the actual id, not merely a key', async () => {
    const rows = await listRows();
    // The whole value, compared in one shot: a per-field `toBeDefined()` walk is how a
    // hollow object passes.
    expect(row(rows, memberTaskId).branchMembership).toEqual({
      spineId: spineTaskId,
      spineType: 'task',
      source: MEMBERSHIP_SOURCE.recorded,
    });
  });

  test('the spine id is the SPINE, not the task itself — a self-referential answer is hollow', async () => {
    const rows = await listRows();
    expect(row(rows, memberTaskId).branchMembership.spineId).not.toBe(memberTaskId);
    expect(row(rows, memberTaskId).branchMembership.spineId).toBe(spineTaskId);
  });

  test('a task that is a member of nothing reports null — PRESENT and empty, not absent', async () => {
    const rows = await listRows();
    const r = row(rows, looseTaskId);
    // Both halves matter and they are different claims: the key was emitted (the read DID
    // join and measured), and the measured answer is "no branch".
    expect('branchMembership' in r).toBe(true);
    expect(r.branchMembership).toBeNull();
  });

  test('THE MISCOUNT ITSELF: the two carriers disagree in both directions on one list', async () => {
    const rows = await listRows();
    const declared = row(rows, memberTaskId);
    const tagged = row(rows, taggedOnlyId);

    // Declared member, NO branch: tag — the band a tag-keyed count calls branchless.
    expect(declared.tags.some((t: string) => t.startsWith('branch:'))).toBe(false);
    expect(declared.branchMembership).not.toBeNull();

    // branch: TAG, no declared membership — the opposite band, invisible to graph traversal.
    expect(tagged.tags).toContain('branch:some-workstream');
    expect(tagged.branchMembership).toBeNull();

    // The predicate a consumer must now use — and the three counts are DIFFERENT, which is
    // the whole finding. Counting by the tag alone says 3 are branchless; counting by
    // membership alone says 3; requiring BOTH to be empty says 2. Each single-carrier count
    // is confidently wrong, and each names a different wrong set.
    const branchless = (t: any) =>
      t.branchMembership == null && !t.tags.some((x: string) => x.startsWith('branch:'));
    expect(rows.filter(branchless).map((t: any) => t.id).sort())
      .toEqual([spineTaskId, looseTaskId].sort());
    expect(rows.filter((t: any) => !t.tags.some((x: string) => x.startsWith('branch:'))).length).toBe(3);
    expect(rows.filter((t: any) => t.branchMembership == null).length).toBe(3);
  });

  test('the JOIN cannot fan out: every task appears exactly once and total matches the rows', async () => {
    // Guard the property that makes joining safe instead of trusting the PK by reputation.
    // A second membership row for one record is a PK violation, so this asserts the
    // constraint is REALLY there and not merely documented.
    await expect(db.query(
      `INSERT INTO branch_memberships
         (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type, source, project_id)
       VALUES ($1, 'task', $2, 'task', $2, 'task', $3, $4)`,
      [memberTaskId, looseTaskId, MEMBERSHIP_SOURCE.recorded, projectId],
    )).rejects.toThrow();

    const resp = await viaPublicTool('task_list', { projectId, limit: 100 }, (a) => tasksRoutes.handleList(a));
    const rows = resp.structuredContent.results;
    expect(rows.length).toBe(4);
    expect(new Set(rows.map((r: any) => r.id)).size).toBe(4);
    // `total` comes from countTasks, which does NOT join. The two must agree.
    expect(resp.structuredContent.total).toBe(4);
    expect(resp.structuredContent.returned).toBe(4);
  });

  test('the human channel names the branch too, and only when there is one', async () => {
    const resp = await viaPublicTool('task_list', { projectId, limit: 100 }, (a) => tasksRoutes.handleList(a));
    const text = resp.content[0].text as string;
    expect(text).toContain(`Branch member of: task ${spineTaskId.substring(0, 8)} (${MEMBERSHIP_SOURCE.recorded})`);
    // Exactly one row says it — absent-when-absent, not "none" printed three times.
    expect(text.split('Branch member of:').length - 1).toBe(1);
  });

  test('ABSENT-WHEN-ABSENT: a reader that does not join omits the key entirely', async () => {
    // THE THIRD STATE, and the one a `?? null` would destroy. task_create returns
    // mapTask(RETURNING *) off the tasks table alone — no membership columns in the
    // projection — so it must say NOTHING about branches rather than claim "no branch".
    // This is not a hypothetical: a create response that reported `branchMembership: null`
    // would tell a consumer the task is branchless at the exact moment nobody has looked.
    const created = await tasksHandler.createTask(projectId, 'created, never joined');
    try {
      expect('branchMembership' in created).toBe(false);
      expect(created.branchMembership).toBeUndefined();
      // The control that makes the line above mean something: the SAME task, read through
      // the joining reader, DOES carry the key — so `false` above is about the projection,
      // not about the field having quietly disappeared.
      const listed = (await listRows()).find((r: any) => r.id === created.id);
      expect('branchMembership' in listed).toBe(true);
      expect(listed.branchMembership).toBeNull();
    } finally {
      await db.query(`DELETE FROM tasks WHERE id = $1`, [created.id]);
    }
  });
});
