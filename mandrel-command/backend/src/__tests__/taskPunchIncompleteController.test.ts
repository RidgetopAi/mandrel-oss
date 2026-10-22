/**
 * taskPunchIncompleteController.test.ts — the CONTROLLER's half of the Punch List lane
 * (migration 101): a `PunchIncompleteRequestError` thrown by
 * `TaskService` must become a 400 carrying `code`/`missing`, never the generic 500.
 *
 * UNIT test: `TaskService.createTask` / `updateTask` are mocked so no DB / MCP server is
 * needed — this file asserts the controller's catch-block mapping specifically, the
 * counterpart to taskCreateDelegation.test.ts / taskUpdateDelegation.test.ts asserting the
 * SERVICE's mapping (mcp-server structuredContent → PunchIncompleteRequestError).
 */
import { TaskController } from '../controllers/task';
import { TaskService, PunchIncompleteRequestError } from '../services/task';

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('TaskController — PUNCH_INCOMPLETE maps to 400, not 500', () => {
  afterEach(() => jest.restoreAllMocks());

  it('POST /api/tasks: a PunchIncompleteRequestError becomes a 400 with code + missing', async () => {
    jest.spyOn(TaskService, 'createTask').mockRejectedValue(
      new PunchIncompleteRequestError(['doneWhen', 'proofKind']),
    );
    const req: any = {
      body: { title: 'x', project_id: 'proj-uuid-1', stage: 'ready' },
      user: { username: 'operator' },
    };
    const res = mockRes();

    await TaskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe('PUNCH_INCOMPLETE');
    expect(payload.missing).toEqual(['doneWhen', 'proofKind']);
  });

  it('PUT /api/tasks/:id: a PunchIncompleteRequestError becomes a 400 with code + missing', async () => {
    jest.spyOn(TaskService, 'updateTask').mockRejectedValue(
      new PunchIncompleteRequestError(['proofKind']),
    );
    const req: any = {
      params: { id: 'task-uuid-1' },
      body: { stage: 'ready' },
      user: { username: 'operator' },
    };
    const res = mockRes();

    await TaskController.updateTask(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe('PUNCH_INCOMPLETE');
    expect(payload.missing).toEqual(['proofKind']);
  });

  it('a NON-punch error on create still returns the generic 500 (no over-broad catch)', async () => {
    jest.spyOn(TaskService, 'createTask').mockRejectedValue(new Error('boom'));
    const req: any = { body: { title: 'x', project_id: 'proj-uuid-1' }, user: {} };
    const res = mockRes();

    await TaskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].code).toBeUndefined();
  });
});
