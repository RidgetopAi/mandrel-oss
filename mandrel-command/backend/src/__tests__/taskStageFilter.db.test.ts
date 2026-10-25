/**
 * taskStageFilter.db.test.ts — `TaskService.getTasks({ stage })` (migration 101,
 * Punch List lane A).
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_stagefilter_1e53f00d
 *   eval "$(bash scripts/provision-test-db.sh ci_stagefilter_1e53f00d --print-env)"
 *   npx jest taskStageFilter --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_stagefilter_1e53f00d --drop
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../database/connection';
import { TaskService } from '../services/task';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeDb('TaskService.getTasks — the stage filter (DB integration, migration 101)', () => {
  let projectId: string;
  const createdTaskIds: string[] = [];

  async function seedTask(stage: string | null, title: string): Promise<string> {
    const id = uuidv4();
    createdTaskIds.push(id);
    // Raw INSERT naming `stage` directly (not through TaskService) so the fixture cannot
    // inherit a bug from the code under test.
    //
    // A NULL stage can only be seeded via status='cancelled': migration 101's trigger
    // (tasks_stage_status_sync, rule d) backfills stage='ready' on ANY INSERT with
    // status='todo' and no stage supplied — a `stage: null` request against status='todo'
    // would silently become 'ready' at the DB layer, which is the DB doing its job, not a
    // fixture bug. `cancelled` is the one status the trigger leaves stage untouched on.
    await db.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority, stage)
       VALUES ($1, $2, $3, 'seeded by taskStageFilter.db.test', 'general', $5, 'medium', $4)`,
      [id, projectId, title, stage, stage === null ? 'cancelled' : 'todo'],
    );
    return id;
  }

  const listTitles = async (stage: string | string[]) =>
    (await TaskService.getTasks({ scope: projectsScope([projectId]), stage })).tasks.map((t) => t.title);

  beforeAll(async () => {
    projectId = uuidv4();
    await db.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, 'taskStageFilter fixture', 'active', NOW())`,
      [projectId, `stagefilter-1e53f00d-${projectId.slice(0, 8)}`],
    );
  });

  afterAll(async () => {
    if (createdTaskIds.length) {
      await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
    }
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await db.end();
  });

  it('filters by a single stage', async () => {
    await seedTask('ready', 'stage-ready-task');
    await seedTask('draft', 'stage-draft-task');

    const titles = await listTitles('ready');
    expect(titles).toContain('stage-ready-task');
    expect(titles).not.toContain('stage-draft-task');
  });

  it('filters by an array of stages', async () => {
    const titles = await listTitles(['ready', 'draft']);
    expect(titles).toContain('stage-ready-task');
    expect(titles).toContain('stage-draft-task');
  });

  it('a row with NULL stage never matches ANY stage filter', async () => {
    await seedTask(null, 'stage-null-task');
    const titles = await listTitles(['ready', 'draft', 'claimed', 'verifying', 'evidence', 'merged', 'deployed']);
    expect(titles).not.toContain('stage-null-task');
  });

  it('omitting the filter returns rows of every stage, including NULL', async () => {
    const { tasks: all } = await TaskService.getTasks({ scope: projectsScope([projectId]) });
    const titles = all.map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining([
      'stage-ready-task', 'stage-draft-task', 'stage-null-task',
    ]));
    // Serialized as a real field, not stripped — task_list output includes stage.
    const readyRow = all.find((t) => t.title === 'stage-ready-task');
    expect(readyRow?.stage).toBe('ready');
    const nullRow = all.find((t) => t.title === 'stage-null-task');
    expect(nullRow?.stage).toBeNull();
  });
});
