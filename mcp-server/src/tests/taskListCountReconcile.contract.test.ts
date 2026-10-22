/**
 * task_list grand-total + reconcile-with-progress-summary Contract Test
 *
 * THE TWO BUGS THIS LOCKS SHUT:
 *   (a) UNDERCOUNT: task_list reported `structuredContent.total = <returned slice length>`.
 *       With the default limit (10) / max (100) slicing the result, `total` silently
 *       under-reported how many tasks actually match — distorting the board.
 *   (b) DISAGREEMENT: task_progress_summary counted ARCHIVED tasks while task_list
 *       excludes them by default, so a status-filtered task_list and the summary
 *       disagreed by exactly the archived rows.
 *
 * THE FIX (pinned here — these assertions FAIL before, PASS after):
 *   - task_list.total is the GRAND TOTAL of matching rows (COUNT with the same filter,
 *     ignoring limit/offset) + pagination metadata (returned/offset/hasMore).
 *   - paging with offset returns EVERY matching row.
 *   - task_progress_summary excludes archived by default → its per-status counts
 *     reconcile with a status-filtered task_list.total (and both agree with
 *     includeArchived:true).
 *
 * Driven through the SAME public path the bridge uses (validate → routeExecutor), on the
 * real migrated disposable ci_* DB. Test data is inserted directly (test provisioning).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = Date.now();
const PROJ_NAME = `tasklist-count-${STAMP}`;

let projectId: string;

// Non-archived: 60 todo + 50 in_progress + 20 completed = 130.
// Archived:     10 todo + 5 in_progress = 15 (excluded from defaults).
const N_TODO = 60;
const N_INPROG = 50;
const N_DONE = 20;
const N_TODO_ARCH = 10;
const N_INPROG_ARCH = 5;
const NON_ARCHIVED_TOTAL = N_TODO + N_INPROG + N_DONE; // 130
const NON_ARCHIVED_ACTIVE = N_TODO + N_INPROG; // 110 (todo + in_progress)
const INCL_ARCHIVED_ACTIVE = NON_ARCHIVED_ACTIVE + N_TODO_ARCH + N_INPROG_ARCH; // 125

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

async function seed(status: string, count: number, archived: boolean) {
  if (count <= 0) return;
  await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, archived_at)
     SELECT $1, $2 || g, 'general', 'medium', $3, ${archived ? 'now()' : 'NULL'}
     FROM generate_series(1, $4) g`,
    [projectId, `${status}${archived ? '-arch' : ''}-`, status, count]
  );
}

/** Page task_list to completion (max limit 100) and return the collected unique ids + the reported total. */
async function pageAll(extraArgs: Record<string, any>): Promise<{ ids: Set<string>; total: number; pages: number }> {
  const ids = new Set<string>();
  let offset = 0;
  let total = 0;
  let pages = 0;
  // Safety bound so a bug can't loop forever.
  for (let guard = 0; guard < 100; guard++) {
    const resp = await viaPublicTool('task_list', { projectId, limit: 100, offset, ...extraArgs });
    const sc = resp.structuredContent;
    total = sc.total;
    for (const r of sc.results) ids.add(r.id);
    pages++;
    if (!sc.hasMore) break;
    offset += sc.results.length;
    if (sc.results.length === 0) break; // defensive
  }
  return { ids, total, pages };
}

describe('task_list grand total + progress-summary reconciliation', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'tasklist count fuse') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;

    await seed('todo', N_TODO, false);
    await seed('in_progress', N_INPROG, false);
    await seed('completed', N_DONE, false);
    await seed('todo', N_TODO_ARCH, true);
    await seed('in_progress', N_INPROG_ARCH, true);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('default limit does NOT lie: total is the grand match count, not the returned slice', async () => {
    // No limit arg → validator applies the default (10). The BUG was total===returned(10).
    const resp = await viaPublicTool('task_list', { projectId });
    const sc = resp.structuredContent;
    expect(sc.returned).toBe(10); // default window
    expect(sc.total).toBe(NON_ARCHIVED_TOTAL); // 130 — the grand total, NOT 10
    expect(sc.hasMore).toBe(true);
    expect(sc.offset).toBe(0);
  });

  test('N>100: paginates correctly and returns EVERY matching row with a correct grand total', async () => {
    const { ids, total, pages } = await pageAll({});
    expect(total).toBe(NON_ARCHIVED_TOTAL); // 130
    expect(ids.size).toBe(NON_ARCHIVED_TOTAL); // every row reachable via paging
    expect(pages).toBeGreaterThan(1); // > one page (proves the >100 cap is paged, not truncated)
  });

  test('status-filtered query returns every matching row and total == count', async () => {
    const { ids, total } = await pageAll({ statuses: ['todo', 'in_progress'] });
    expect(total).toBe(NON_ARCHIVED_ACTIVE); // 110
    expect(ids.size).toBe(NON_ARCHIVED_ACTIVE); // every matching row returned across pages
  });

  test('task_list total reconciles with task_progress_summary on the same filter (default: archived excluded)', async () => {
    const listResp = await viaPublicTool('task_list', { projectId, statuses: ['todo', 'in_progress'], limit: 100 });
    const listTotal = listResp.structuredContent.total;

    const sumResp = await viaPublicTool('task_progress_summary', { projectId, groupBy: 'status' });
    const groups = sumResp.structuredContent.groupedProgress as any[];
    const byGroup = new Map(groups.map((g) => [g.group, g.totalTasks]));
    const summaryActive = (byGroup.get('todo') ?? 0) + (byGroup.get('in_progress') ?? 0);

    expect(listTotal).toBe(NON_ARCHIVED_ACTIVE); // 110
    expect(summaryActive).toBe(NON_ARCHIVED_ACTIVE); // 110 — the two tools AGREE
    expect(listTotal).toBe(summaryActive);
  });

  test('reconciliation holds with includeArchived:true too (both count archived)', async () => {
    const listResp = await viaPublicTool('task_list', {
      projectId, statuses: ['todo', 'in_progress'], limit: 100, includeArchived: true,
    });
    const listTotal = listResp.structuredContent.total;

    const sumResp = await viaPublicTool('task_progress_summary', {
      projectId, groupBy: 'status', includeArchived: true,
    });
    const groups = sumResp.structuredContent.groupedProgress as any[];
    const byGroup = new Map(groups.map((g) => [g.group, g.totalTasks]));
    const summaryActive = (byGroup.get('todo') ?? 0) + (byGroup.get('in_progress') ?? 0);

    expect(listTotal).toBe(INCL_ARCHIVED_ACTIVE); // 125
    expect(summaryActive).toBe(INCL_ARCHIVED_ACTIVE); // 125
    expect(listTotal).toBe(summaryActive);
  });
});
