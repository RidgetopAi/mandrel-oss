/**
 * tasks domain — the stats un-nest seam (the one this bug slipped through).
 *
 * This is a CLIENT-LEVEL test: it exercises the REAL `tasksApi.stats` against a mocked
 * HTTP transport returning the REAL server envelope `{ success, data: { stats: {…} } }`.
 * The prior `Tasks.test.tsx` mocked `api.tasks.stats` itself — stubbing out the exact
 * broken seam (a LYING mock) — so the missing `.stats` un-nest shipped: every stats-fed
 * surface (OpsBar / progress bar / Analytics KPIs) read `by_status`/`total` one level too
 * high → `undefined` → rendered 0, while the DB was fine.
 *
 * We mock ONLY `http.get` (the transport), never the method under test, and assert the
 * returned object has `total`/`by_status` at the TOP level (i.e. the `.stats` un-nest
 * happened). MUTATION-CHECK: revert the `.stats` un-nest in `stats()` and this test fails
 * (the returned object would be `{ stats: {…} }`, so `.total` is undefined).
 *
 * The sibling analytics methods (`leadTime`/`throughput`/`completedByActor`) were verified
 * to already un-nest their own keys (`data.leadTimeData` / `data.series` / `data.actors`);
 * `stats` was the lone outlier. One un-nest is guarded here as a representative regression.
 */
import { tasksApi } from './tasks';
import { http } from '../request';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tasksApi.stats — un-nests data.stats to a flat TaskStats', () => {
  /** The REAL envelope the Command backend returns from GET /api/tasks/stats. */
  const REAL_ENVELOPE = {
    success: true,
    data: {
      stats: {
        total: 590,
        by_status: { in_progress: 3, completed: 439, todo: 145, blocked: 3 },
        by_priority: { high: 100, medium: 400, low: 90 },
        by_type: { feature: 200, bug: 90 },
        completion_rate: 74,
      },
    },
  };

  test('GETs /tasks/stats and returns total/by_status at the TOP level (un-nested)', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(REAL_ENVELOPE as never);

    const stats = await tasksApi.stats({ project_id: 'riverbend' });

    // Hit the right path, forwarding the params.
    expect(spy.mock.calls[0][0]).toBe('/tasks/stats');
    expect(spy.mock.calls[0][1]).toEqual({ params: { project_id: 'riverbend' } });

    // THE CRUX: the counts must be at the top level, NOT nested under `.stats`.
    // If the `.stats` un-nest is reverted, these read `undefined` and the test fails.
    expect(stats.total).toBe(590);
    expect(stats.by_status).toEqual({ in_progress: 3, completed: 439, todo: 145, blocked: 3 });
    expect(stats.by_status?.in_progress).toBe(3);
    expect(stats.completion_rate).toBe(74);

    // The buggy shape must NOT leak through: there is no `.stats` on the returned object.
    expect((stats as Record<string, unknown>).stats).toBeUndefined();
  });

  test('returns an empty object (never throws) when the payload has no stats key', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: {} } as never);
    const stats = await tasksApi.stats();
    expect(stats).toEqual({});
  });

  test('throws on a success:false envelope (surfaces a real failure, not a silent 0)', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({
      success: false,
      error: { message: 'boom' },
    } as never);
    await expect(tasksApi.stats()).rejects.toThrow('boom');
  });
});

/**
 * SOFT-DELETE CLIENT SEAM. `remove` is now a soft delete server-side and
 * `restore` is its undo. Both are exercised against a mocked TRANSPORT (never the method
 * under test), so a wrong path or a missing un-nest is a red — the two verbs are the only
 * way the UI can reach the archive, and a silently-wrong URL would look like a no-op.
 */
describe('tasksApi.remove / restore — the soft-delete verbs', () => {
  test('remove DELETEs /tasks/:id (soft delete server-side)', async () => {
    const spy = vi.spyOn(http, 'del').mockResolvedValue({
      success: true,
      data: { archived: true },
    } as never);

    await tasksApi.remove('abc-123');

    expect(spy.mock.calls[0][0]).toBe('/tasks/abc-123');
  });

  test('restore POSTs /tasks/:id/restore and un-nests data.task', async () => {
    const spy = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: { task: { id: 'abc-123', title: 'back from the archive', archived_at: null } },
    } as never);

    const task = await tasksApi.restore('abc-123');

    expect(spy.mock.calls[0][0]).toBe('/tasks/abc-123/restore');
    expect(task.id).toBe('abc-123');
    expect((task as Record<string, unknown>).archived_at).toBeNull();
  });

  test('restore throws on a success:false envelope (never a silent non-restore)', async () => {
    vi.spyOn(http, 'post').mockResolvedValue({
      success: false,
      error: { message: 'task not found' },
    } as never);
    await expect(tasksApi.restore('nope')).rejects.toThrow('task not found');
  });

  test('restore throws when the payload carries no task (no phantom success)', async () => {
    vi.spyOn(http, 'post').mockResolvedValue({ success: true, data: {} } as never);
    await expect(tasksApi.restore('abc-123')).rejects.toThrow('Task restore payload missing');
  });
});

describe('tasksApi.bulkMove — reads the backend\'s `updated` count', () => {
  it('POST /tasks/bulk/move → { updated, skipped, errors } becomes { moved: updated } (it read a `moved` key the backend never sent, so every move showed 0)', async () => {
    const spy = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: { updated: 2, skipped: ['t-3'], errors: [] },
    } as never);
    const out = await tasksApi.bulkMove(['t-1', 't-2', 't-3'], 'proj-c');
    expect(spy.mock.calls[0][0]).toBe('/tasks/bulk/move');
    expect(spy.mock.calls[0][1]).toEqual({ ids: ['t-1', 't-2', 't-3'], project_id: 'proj-c' });
    expect(out).toEqual({ moved: 2 });
  });
});
