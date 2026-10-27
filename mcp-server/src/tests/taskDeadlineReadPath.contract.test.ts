/**
 * THE DEADLINE READ PATH — contract test. an earlier task.
 *
 * THE DEFECT. `blocked_on` and `due_at` (migration 093) were WRITABLE through task_create
 * and task_update, were RETURNED by task_create, and are populated by mapTask because
 * listTasks selects `*`. `task_details` — the per-record READ surface, the one a human or
 * an agent uses to ask "what is this task" — rendered NEITHER, in the text block or the
 * structured channel.
 *
 * MEASURED against live prod 2026-08-31 on an earlier task, which carries blocked_on='human'
 * and due_at=2026-09-15: task_details returned neither field in either channel. The
 * consequence was not cosmetic. That task is the only genuinely time-boxed item in the
 * backlog, and because its strong carriers were unreadable, its deadline was restated in
 * prose and in an `expires:` TAG — and then the tag was updated while due_at was left two
 * weeks stale, because a value you cannot read back is a value nobody reconciles.
 *
 * ⚠️ THE IMPLEMENTATION THIS ASSERTS LIVES ON BATCH-10 LANE C, NOT ON THIS BRANCH.
 * Lane D and lane C independently fixed the same read path. The two hunks sit ~18 lines
 * apart in tasks.routes.ts, so git AUTO-MERGES THEM CLEAN and the merged tree then fails to
 * compile (TS2451, duplicate `blockedOnText`) — and the obvious fix, deleting one duplicate
 * const, silently prints `Blocked on:`/`Due:` TWICE. Lane C's implementation is a strict
 * superset (it also lands the fields on task_list rows, adds dueBefore + sort:"dueAt", a
 * typed pre-093 refusal, and a class guard), so lane D withdrew its hunk and kept only this
 * test. Verified by Reviewer: this file passes UNMODIFIED against lane C's implementation,
 * because every assertion is `toContain`/field-equality and none of them pins text POSITION.
 *
 * CONSEQUENCE, STATED SO NOBODY READS IT AS A DEFECT: on lane D ALONE this file is RED, by
 * construction — it asserts a behaviour whose only implementation is on the other branch.
 * It goes green on the merge, which is the ref that ships. A test kept deliberately red in
 * isolation is worth more than a test deleted, because deleting it is how the coverage that
 * survived a de-duplication quietly stops existing.
 *
 * WHY THIS TEST DRIVES THE SHIPPED TOOL. The fields already existed in the database and in
 * the mapper; a test that asserted on either would have passed before the fix and proved
 * nothing. The only thing that was broken is what the TOOL returns, so the tool is what is
 * called (CLASSES.md C3: drive the shipped entry point).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CONN = `deadline-read-conn-${STAMP}`;
const PROJ_NAME = `deadline-read-P-${STAMP}`;
const DUE = '2026-09-15T00:00:00.000Z';

let projectId: string;
let taskWithDeadline: string;
let taskWithout: string;

async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN } as any);
}

describe('task_details returns the deadline fields', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'deadline read path') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN } as any);

    const withDeadline = await viaTool('task_create', {
      title: `waiver with a real deadline ${STAMP}`,
      type: 'devops',
      blockedOn: 'human',
      dueAt: DUE,
    });
    taskWithDeadline = withDeadline.structuredContent.task.id;

    const without = await viaTool('task_create', {
      title: `ordinary task ${STAMP}`,
      type: 'general',
    });
    taskWithout = without.structuredContent.task.id;
  });

  afterAll(async () => {
    await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  test('the STRUCTURED channel carries blockedOn and dueAt', async () => {
    const res = await viaTool('task_details', { taskId: taskWithDeadline });
    expect(res.structuredContent.found).toBe(true);
    expect(res.structuredContent.task.blockedOn).toBe('human');
    expect(res.structuredContent.task.dueAt).toBe(DUE);
  });

  test('the TEXT channel names them too — the human reader is the one who reconciles', async () => {
    // The text block is what an agent reads back and what a human sees in a transcript. A
    // field present only in structuredContent is invisible to the reader who would notice
    // that the deadline and the `expires:` tag disagree, which is the drift that happened.
    const res = await viaTool('task_details', { taskId: taskWithDeadline });
    const text: string = res.content[0].text;
    expect(text).toContain('Blocked on: human');
    expect(text).toContain('Due: 2026-09-15');
  });

  test('a task with NO deadline says nothing rather than inventing one', async () => {
    // The absent population, which is where a read path usually starts lying. `dueAt: null`
    // is the honest answer for a projected-but-empty column; a rendered `Due:` line with an
    // empty value, or a fabricated date, would be worse than the original omission.
    const res = await viaTool('task_details', { taskId: taskWithout });
    expect(res.structuredContent.task.dueAt).toBeNull();
    expect(res.structuredContent.task.blockedOn).toBeNull();
    expect(res.content[0].text).not.toContain('Due:');
    expect(res.content[0].text).not.toContain('Blocked on:');
  });

  test('a deadline set by task_UPDATE is readable too, not just one set at create', async () => {
    // Both write paths, per CLASSES.md C5. an earlier change's deadline was set by an update.
    await viaTool('task_update', { taskId: taskWithout, dueAt: '2026-12-01T00:00:00.000Z', blockedOn: 'external' });
    const res = await viaTool('task_details', { taskId: taskWithout });
    expect(res.structuredContent.task.dueAt).toBe('2026-12-01T00:00:00.000Z');
    expect(res.structuredContent.task.blockedOn).toBe('external');
  });
});
