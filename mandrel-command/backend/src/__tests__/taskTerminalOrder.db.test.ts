/**
 * taskTerminalOrder.db.test.ts — `TaskService.getTasks` orders a TERMINAL column
 * (status='completed' — Tasks board's Done, Punch board's Merged/Deployed) by
 * completed_at DESC, newest first, while a QUEUE column (still open) keeps the
 * existing priority-first order.
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_terminalorder_d186ff4f
 *   eval "$(bash scripts/provision-test-db.sh ci_terminalorder_d186ff4f --print-env)"
 *   npx jest taskTerminalOrder --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_terminalorder_d186ff4f --drop
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../database/connection';
import { TaskService } from '../services/task';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeDb('TaskService.getTasks — terminal columns sort by completion time', () => {
  let projectId: string;
  const createdTaskIds: string[] = [];

  /**
   * Raw INSERT (not through TaskService) so the fixture cannot inherit a bug from the
   * code under test. `completedAt` is written directly — migration 099's trigger only
   * stamps a NULL completed_at, so an explicit value on an INSERT born completed is
   * honored verbatim (the same "caller-supplied value wins" rule the migration documents).
   *
   * `completedAt: null` on a `status: 'completed'` row simulates a LEGACY unstamped row.
   * The INSERT alone cannot produce one — migration 099's trigger stamps CURRENT_TIMESTAMP
   * on any INSERT born completed with no supplied value — so a follow-up UPDATE nulls it
   * back out. That UPDATE does not change `status`, so it is not a transition and the
   * trigger leaves it untouched (migration 099: "every other update falls through
   * untouched" / "an explicit correction ... including setting it to NULL ... is HONORED").
   */
  async function seedTask(opts: {
    title: string;
    priority: 'urgent' | 'high' | 'medium' | 'low';
    status: 'todo' | 'completed';
    completedAt?: string | null;
  }): Promise<string> {
    const id = uuidv4();
    createdTaskIds.push(id);
    await db.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority, completed_at)
       VALUES ($1, $2, $3, 'seeded by taskTerminalOrder.db.test', 'general', $4, $5, $6)`,
      [id, projectId, opts.title, opts.status, opts.priority, opts.completedAt ?? null],
    );
    if (opts.status === 'completed' && opts.completedAt === null) {
      await db.query(`UPDATE tasks SET completed_at = NULL WHERE id = $1`, [id]);
    }
    return id;
  }

  const listTitles = async () =>
    (await TaskService.getTasks({ scope: projectsScope([projectId]) })).tasks.map((t) => t.title);

  beforeAll(async () => {
    projectId = uuidv4();
    await db.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, 'taskTerminalOrder fixture', 'active', NOW())`,
      [projectId, `terminalorder-d186ff4f-${projectId.slice(0, 8)}`],
    );
  });

  afterAll(async () => {
    if (createdTaskIds.length) {
      await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
    }
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await db.end();
  });

  it('a low-priority row completed TODAY outranks an urgent row completed three weeks ago', async () => {
    await seedTask({
      title: 'old-urgent-completed',
      priority: 'urgent',
      status: 'completed',
      completedAt: '2026-08-14T10:00:00Z',
    });
    await seedTask({
      title: 'recent-low-completed',
      priority: 'low',
      status: 'completed',
      completedAt: '2026-09-12T08:02:00Z',
    });

    const titles = await listTitles();
    const recentIdx = titles.indexOf('recent-low-completed');
    const oldIdx = titles.indexOf('old-urgent-completed');
    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    // Priority-first would rank urgent above low; completion-time-first must invert that.
    expect(recentIdx).toBeLessThan(oldIdx);
  });

  it('a QUEUE row (still open) keeps priority-first order, unaffected by completion time', async () => {
    await seedTask({ title: 'queue-low-todo', priority: 'low', status: 'todo' });
    await seedTask({ title: 'queue-urgent-todo', priority: 'urgent', status: 'todo' });

    const titles = await listTitles();
    const urgentIdx = titles.indexOf('queue-urgent-todo');
    const lowIdx = titles.indexOf('queue-low-todo');
    expect(urgentIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(urgentIdx).toBeLessThan(lowIdx);
  });

  it('a legacy completed row with no completed_at stamp sorts to the BOTTOM of Done, never invented to the top', async () => {
    await seedTask({
      title: 'legacy-unstamped-completed',
      priority: 'urgent',
      status: 'completed',
      completedAt: null,
    });
    await seedTask({
      title: 'stamped-old-completed',
      priority: 'low',
      status: 'completed',
      completedAt: '2026-08-01T00:00:00Z',
    });

    const titles = await listTitles();
    const legacyIdx = titles.indexOf('legacy-unstamped-completed');
    const stampedIdx = titles.indexOf('stamped-old-completed');
    expect(legacyIdx).toBeGreaterThanOrEqual(0);
    expect(stampedIdx).toBeGreaterThanOrEqual(0);
    // NULLS LAST: even a stamped row from a month ago outranks the unstamped legacy row.
    expect(stampedIdx).toBeLessThan(legacyIdx);
  });
});
