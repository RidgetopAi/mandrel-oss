/**
 * THE `/tasks/bulk-update` WIRE CONTRACT — the route's half (part 3).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * The frontend client `api.tasks.bulkUpdate(ids, updates)` posted
 *
 *     {"ids":["task-1","task-2"],"updates":{"status":"completed"}}
 *
 * — MEASURED off the wire, not read off the source: a vitest adapter capture in
 * `frontend/src/api/domains/tasksBulkUpdateShape.seam.test.ts` prints the exact bytes.
 * This route requires the OTHER shape, a per-item array, and answers the object form with
 * `400 Updates must be an array`. So the UI's only bulk-update affordance could not
 * succeed, and the first person to wire a Kanban bulk action would have found out at
 * runtime.
 *
 * WHICH SIDE WAS WRONG, AND WHY THIS FILE GUARDS THE ROUTE RATHER THAN CHANGING IT. The
 * route is the deployed contract: it is what `POST /tasks/bulk-update` has always meant
 * (per-item {id, status}, the Kanban drag-and-drop shape), it broadcasts one SSE event per
 * moved task, and it already has tests. The client was written by analogy with
 * `contexts.bulkUpdate`, whose route genuinely does take {ids, updates} — a different
 * endpoint with a different meaning. The CLIENT was corrected; this file pins the route so
 * the correction cannot silently un-happen from the other side.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE
 * ════════════════════════════════════════════════════════════════════════════════════
 * Both bodies, both directions, at the real controller:
 *   1. the OLD client body is REJECTED 400 (the shape must stay illegal, or a regressed
 *      client would look fine here while failing in the browser);
 *   2. the NEW client body is ACCEPTED and reaches `TaskService.bulkUpdateStatus` with the
 *      items intact (accepting it while dropping the items would be the same bug quieter);
 *   3. a per-item entry missing `status` is REJECTED, so "is an array" is not the whole of
 *      the contract this file claims to pin;
 *   4. an EMPTY array is accepted — the empty population, asserted rather than assumed.
 * The controller is driven directly, with `TaskService.bulkUpdateStatus` stubbed: this file
 * is about the wire shape, and a DB in the path would only add ways to be red.
 */

import { TaskService } from '../services/task';
import { attachResolvedScope } from './helpers/projectScope';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TaskController } = require('../controllers/task');

/** A minimal express `res` double that records what the controller decided. */
const res = () => {
  const r: any = { statusCode: 200, body: undefined };
  r.status = jest.fn((code: number) => {
    r.statusCode = code;
    return r;
  });
  r.json = jest.fn((payload: unknown) => {
    r.body = payload;
    return r;
  });
  return r;
};

/**
 * THE EXACT BYTES the frontend client used to put on the wire, captured by the adapter
 * probe named in the header. Kept as the literal object rather than a description of one.
 */
const OLD_CLIENT_BODY = { ids: ['task-1', 'task-2'], updates: { status: 'completed' } };

/** The shape the corrected client posts, and the shape this route has always required. */
const NEW_CLIENT_BODY = {
  updates: [
    { id: 'task-1', status: 'completed' },
    { id: 'task-2', status: 'completed' },
  ],
};

describe('POST /tasks/bulk-update wire contract', () => {
  afterEach(() => jest.restoreAllMocks());

  it('REJECTS the object form the old client posted — 400, and nothing is written', async () => {
    const spy = jest.spyOn(TaskService, 'bulkUpdateStatus');
    const r = res();

    await TaskController.bulkUpdateTasks(attachResolvedScope({ body: OLD_CLIENT_BODY, user: { username: 'b', id: 'u-b', role: 'admin' } }), r);

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ success: false, error: 'Updates must be an array' });
    // A rejected body must never reach the service.
    expect(spy).not.toHaveBeenCalled();
  });

  it('ACCEPTS the per-item array form AND passes the items through intact', async () => {
    const spy = jest
      .spyOn(TaskService, 'bulkUpdateStatus')
      .mockResolvedValue({ tasks: [], skipped: [] } as never);
    const r = res();

    await TaskController.bulkUpdateTasks(attachResolvedScope({ body: NEW_CLIENT_BODY, user: { username: 'b', id: 'u-b', role: 'admin' } }), r);

    expect(r.statusCode).not.toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(NEW_CLIENT_BODY.updates);
  });

  it('REJECTS an array whose items lack `status` — "is an array" is not the whole contract', async () => {
    const spy = jest.spyOn(TaskService, 'bulkUpdateStatus');
    const r = res();

    await TaskController.bulkUpdateTasks(
      attachResolvedScope({ body: { updates: [{ id: 'task-1' }] }, user: { username: 'b', id: 'u-b', role: 'admin' } }),
      r,
    );

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ error: 'Each update must have id and status' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('ACCEPTS an EMPTY array — the empty population, asserted not assumed', async () => {
    const spy = jest
      .spyOn(TaskService, 'bulkUpdateStatus')
      .mockResolvedValue({ tasks: [], skipped: [] } as never);
    const r = res();

    await TaskController.bulkUpdateTasks(attachResolvedScope({ body: { updates: [] }, user: { username: 'b', id: 'u-b', role: 'admin' } }), r);

    expect(r.statusCode).not.toBe(400);
    expect(spy.mock.calls[0][0]).toEqual([]);
  });
});
