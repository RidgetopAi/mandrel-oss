/**
 * The pool is REPLACED, not spied on: this file must not reach `database/connection`, or
 * dbTestGateCoverage correctly classifies it as a DB suite and demands the `describeDb`
 * gate — and these tests need no database. The factory is hoisted above the imports by
 * jest, hence the mandatory `mock` prefix on the closed-over fn.
 */
const mockPoolQuery = jest.fn();
jest.mock('../database/connection', () => ({
  db: { query: (...args: any[]) => mockPoolQuery(...args) },
}));

import { TaskService, UpdateTaskRequest, PunchIncompleteRequestError } from '../services/task';
import { allProjects } from '../services/projectListScope';
import { attachResolvedScope } from './helpers/projectScope';
import { McpService } from '../services/mcp';

/**
 * an earlier task — `TaskService.updateTask` and `TaskService.bulkUpdateStatus` must DELEGATE
 * to the mcp-server `task_update` / `task_bulk_update` tools, completing the class fix that
 * `taskCreateDelegation.test.ts` pins for `createTask`.
 *
 * These are UNIT tests: `McpService.callTool` and `TaskService.getTaskById` are mocked, and
 * the pool is mocked for the bulk pre-read, so no DB and no MCP server are needed. They
 * assert the DELEGATION, the arg mapping, the project scoping, the 404/no-op/error paths,
 * and the bulk grouping + partial-failure contract.
 *
 * WHAT THEY DELIBERATELY DO NOT ASSERT: the `completed_at` lifecycle and the assignee
 * TRANSITION STAMP. Those rules moved WITH the write. They now live in exactly one place
 * each — the DB trigger + CHECK (migration 094, exercised by completedAtUnforgettable.db
 * .test.ts) and mcp-server/src/config/assigneeStamp.ts (exercised by mcp-server's own
 * assigneeTransitionStamp contract test, which covers the single AND the bulk site). Adding
 * a copy of those assertions here would rebuild the second source of truth this task
 * deleted, one layer up.
 */
describe('TaskService.updateTask delegates to task_update', () => {
  const ROW = {
    id: 'task-uuid-1',
    project_id: 'proj-uuid-1',
    title: 'Before',
    description: 'before',
    type: 'feature',
    status: 'todo',
    priority: 'low',
    assigned_to: null,
    dependencies: [],
    tags: ['a'],
    metadata: {},
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    archived_at: null,
  } as any;

  afterEach(() => jest.restoreAllMocks());

  /** Mock the read-before / read-after pair; returns the callTool spy. */
  function stubRow(row: any = ROW) {
    jest.spyOn(TaskService, 'getTaskById').mockResolvedValue(row);
  }

  it('maps the DTO to the tool arg names, scopes the write to the ROW\'s project, forwards the actor, and returns the re-read row', async () => {
    stubRow();
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { action: 'updated', task: { id: 'task-uuid-1', status: 'completed' } },
    });

    const updates: UpdateTaskRequest = {
      title: 'After',
      description: 'after',
      status: 'completed',
      priority: 'high',
      assigned_to: 'operator',
      tags: ['a', 'b'],
      metadata: { note: 1 },
    };
    const task = await TaskService.updateTask('task-uuid-1', updates, 'operator');

    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, args, actor] = spy.mock.calls[0] as [string, any, string];
    expect(tool).toBe('task_update');
    expect(actor).toBe('operator');
    // PROJECT SCOPE: the write names the ROW's project, never an ambient slot.
    expect(args).toEqual({
      taskId: 'task-uuid-1',
      projectId: 'proj-uuid-1',
      title: 'After',
      description: 'after',
      status: 'completed',
      priority: 'high',
      assignedTo: 'operator',
      tags: ['a', 'b'],
      metadata: { note: 1 },
    });
    // The response body is the re-read row — the tool returns applied fields, not the record.
    expect(task).toEqual(ROW);
  });

  it('sends ONLY the fields the caller supplied, so an omitted field is left alone', async () => {
    stubRow();
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { task: { id: 'task-uuid-1' } },
    });

    await TaskService.updateTask('task-uuid-1', { priority: 'urgent' });

    const [, args] = spy.mock.calls[0] as [string, any];
    expect(args).toEqual({
      taskId: 'task-uuid-1',
      projectId: 'proj-uuid-1',
      priority: 'urgent',
    });
  });

  it('returns null (the controller\'s 404) for a task that does not exist, WITHOUT delegating', async () => {
    jest.spyOn(TaskService, 'getTaskById').mockResolvedValue(null);
    const spy = jest.spyOn(McpService, 'callTool');

    expect(await TaskService.updateTask('nope', { status: 'completed' })).toBeNull();
    // Absence must never reach the write path — that is what keeps "no such task" (404)
    // distinguishable from "the write failed" (500).
    expect(spy).not.toHaveBeenCalled();
  });

  // ── `type` IS NOW A SUPPORTED EDIT (batch 5, merge b26128e) ──────────────────────
  // These two cases used to assert the OPPOSITE: that a `type` edit was REFUSED with
  // /Cannot update type/, and that an echo of the current type was dropped from the tool
  // args. Both were correct for lane F alone — `task_update` declared no `type`, its zod
  // runs strict, so forwarding one would have failed the whole call and refusing beat
  // silently discarding it. Lane K then added `type` to taskSchemas.update, a `type = $n`
  // SET clause in handleUpdate, and the re-embed trigger set, and the merge removed the
  // `type` arm of the refusal accordingly.
  //
  // So the refusal these cases asserted no longer exists, and they were asserting a
  // superseded contract, not guarding anything. They are replaced rather than deleted, and
  // by a STRONGER condition: the old pair could only observe that the field never reached
  // the tool, which is also what a silent drop looks like. The pair below observes the
  // field ARRIVING, with its value, which distinguishes forwarding from dropping — the
  // exact confusion the refusal was invented to prevent. The tool's own acceptance of the
  // param is guarded on the other side of the wire by
  // mcp-server/src/tests/taskUpdateType.contract.test.ts; it is not restated here.
  //
  // `dependencies` is genuinely still absent from task_update, so its refusal case below
  // is UNCHANGED and still load-bearing.
  it('FORWARDS a `type` edit to task_update — lane K made it a supported field', async () => {
    stubRow();
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { task: { id: 'task-uuid-1' } },
    });

    await TaskService.updateTask('task-uuid-1', { type: 'bug' });

    const [tool, args] = spy.mock.calls[0] as [string, any];
    expect(tool).toBe('task_update');
    // The VALUE, not merely the key: a forward that sent the stale current value would
    // satisfy a presence check and still lose the caller's edit.
    expect(args.type).toBe('bug');
    expect(args.type).not.toBe(ROW.type);
    // …and a `type`-only edit is a real edit, so it must not trip the empty-edit refusal.
    expect(args).toEqual({ taskId: 'task-uuid-1', projectId: 'proj-uuid-1', type: 'bug' });
  });

  it('forwards a `type` that matches the current value too — no echo carve-out survives', async () => {
    stubRow();
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { task: { id: 'task-uuid-1' } },
    });

    await TaskService.updateTask('task-uuid-1', { type: ROW.type, status: 'blocked' });

    const [, args] = spy.mock.calls[0] as [string, any];
    // The carve-out existed ONLY to keep an unsupported field from failing a strict call.
    // With the field supported, re-sending the current value is an ordinary no-op write and
    // special-casing it would be a second, divergent rule about what an edit is.
    expect(args.type).toBe(ROW.type);
    expect(args.status).toBe('blocked');
  });

  it('REFUSES a `dependencies` edit for the same reason, and ignores an identical one', async () => {
    stubRow();
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { task: { id: 'task-uuid-1' } },
    });

    await expect(
      TaskService.updateTask('task-uuid-1', { dependencies: ['dep-1'] }),
    ).rejects.toThrow(/Cannot update dependencies/);
    expect(spy).not.toHaveBeenCalled();

    await TaskService.updateTask('task-uuid-1', { dependencies: [], status: 'blocked' });
    const [, args] = spy.mock.calls[0] as [string, any];
    expect(args).not.toHaveProperty('dependencies');
  });

  it('still throws "No updates provided" for an empty edit (unchanged message and status)', async () => {
    stubRow();
    await expect(TaskService.updateTask('task-uuid-1', {})).rejects.toThrow('No updates provided');
  });

  it('maps a transport/auth failure to a thrown error — never a false-success task', async () => {
    stubRow();
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: false,
      error: 'HTTP 401',
    });
    await expect(
      TaskService.updateTask('task-uuid-1', { status: 'completed' }),
    ).rejects.toThrow('Failed to update task');
  });

  it('throws on an IN-BAND tool error (HTTP 200 with ok:false and no task) — no phantom 200', async () => {
    // This is the claim-fence / ambiguous-id / validation shape: the bridge answers 200 and
    // the failure lives in structuredContent. Reading `success` alone would call it a win.
    stubRow();
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { ok: false, found: false },
    });
    await expect(
      TaskService.updateTask('task-uuid-1', { status: 'completed' }),
    ).rejects.toThrow('Failed to update task');
  });

  // THE PUNCH LIST LANE (migration 101).
  it('forwards stage and punch to task_update', async () => {
    stubRow();
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { task: { id: 'task-uuid-1' } },
    });

    await TaskService.updateTask('task-uuid-1', {
      stage: 'ready', punch: { doneWhen: 'x', proofKind: 'browser' },
    });

    const [, args] = spy.mock.calls[0] as [string, any];
    expect(args.stage).toBe('ready');
    expect(args.punch).toEqual({ doneWhen: 'x', proofKind: 'browser' });
  });

  it('maps a [PUNCH_INCOMPLETE] tool refusal to a typed PunchIncompleteRequestError, never the generic 500', async () => {
    stubRow();
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { ok: false, code: 'PUNCH_INCOMPLETE', missing: ['proofKind'] },
    });

    let caught: any;
    try {
      await TaskService.updateTask('task-uuid-1', { stage: 'ready' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PunchIncompleteRequestError);
    expect(caught.code).toBe('PUNCH_INCOMPLETE');
    expect(caught.missing).toEqual(['proofKind']);
  });
});

describe('TaskService.bulkUpdateStatus delegates to task_bulk_update', () => {
  beforeEach(() => mockPoolQuery.mockReset());
  afterEach(() => jest.restoreAllMocks());

  /**
   * Mock the two raw READS the method still performs: the project pre-read and the row
   * read-back. Both are reads; the guard in taskWritePathSingleOwner.test.ts asserts
   * separately that no WRITE remains in this method.
   */
  function stubReads(rows: Array<{ id: string; project_id: string }>) {
    mockPoolQuery.mockImplementation((sql: any, params: any) => {
      if (String(sql).includes('SELECT id, project_id')) {
        const asked: string[] = params[0];
        return Promise.resolve({ rows: rows.filter((r) => asked.includes(r.id)) });
      }
      const asked: string[] = params[0];
      return Promise.resolve({
        rows: asked.map((id) => ({ ...rows.find((r) => r.id === id), status: 'x' })),
      });
    });
  }

  it('sends ONE atomic call per (project, status) group and forwards the actor', async () => {
    stubReads([
      { id: 'a', project_id: 'p1' },
      { id: 'b', project_id: 'p1' },
      { id: 'c', project_id: 'p2' },
    ]);
    const spy = jest.spyOn(McpService, 'callTool').mockImplementation(
      async (_tool: string, args: any) => ({
        success: true,
        data: { updatedTaskIds: args.task_ids, errors: [] },
      }),
    );

    const result = await TaskService.bulkUpdateStatus(
      [
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'completed' },
        { id: 'c', status: 'completed' },
      ],
      allProjects,
      'operator',
    );

    // Two projects, one status → TWO groups, not three per-id calls.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['task_bulk_update', 'task_bulk_update']);
    expect(spy.mock.calls.map((c) => (c[1] as any).projectId).sort()).toEqual(['p1', 'p2']);
    expect((spy.mock.calls[0][1] as any).task_ids).toEqual(['a', 'b']);
    expect((spy.mock.calls[0][1] as any).status).toBe('completed');
    expect(spy.mock.calls[0][2]).toBe('operator');
    expect(result.tasks.map((t: any) => t.id)).toEqual(['a', 'b', 'c']);
    expect(result.skipped).toEqual([]);
  });

  it('the COMMON CASE — one board, one column — is exactly ONE atomic call', async () => {
    // This is the claim that the Kanban drag kept its old all-or-nothing behaviour.
    stubReads([
      { id: 'a', project_id: 'p1' },
      { id: 'b', project_id: 'p1' },
    ]);
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { updatedTaskIds: ['a', 'b'], errors: [] },
    });

    await TaskService.bulkUpdateStatus([
      { id: 'a', status: 'in_progress' },
      { id: 'b', status: 'in_progress' },
    ], allProjects);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('splits by STATUS too, so a mixed drag does not send one status for two columns', async () => {
    stubReads([
      { id: 'a', project_id: 'p1' },
      { id: 'b', project_id: 'p1' },
    ]);
    const spy = jest.spyOn(McpService, 'callTool').mockImplementation(
      async (_t: string, args: any) => ({
        success: true,
        data: { updatedTaskIds: args.task_ids, errors: [] },
      }),
    );

    await TaskService.bulkUpdateStatus([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'todo' },
    ], allProjects);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => (c[1] as any).status)).toEqual(['completed', 'todo']);
  });

  it('reports an id that does not exist instead of failing the batch for everyone else', async () => {
    stubReads([{ id: 'a', project_id: 'p1' }]);
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { updatedTaskIds: ['a'], errors: [] },
    });

    const result = await TaskService.bulkUpdateStatus([
      { id: 'a', status: 'completed' },
      { id: 'ghost', status: 'completed' },
    ], allProjects);
    expect(result.tasks.map((t: any) => t.id)).toEqual(['a']);
    expect(result.skipped).toEqual([{ id: 'ghost', reason: "not found in the caller's project scope" }]);
  });

  it('PARTIAL FAILURE: a failed group does not roll back a succeeded one, and is reported', async () => {
    stubReads([
      { id: 'a', project_id: 'p1' },
      { id: 'c', project_id: 'p2' },
    ]);
    jest.spyOn(McpService, 'callTool').mockImplementation(async (_t: string, args: any) =>
      args.projectId === 'p2'
        ? { success: false, error: 'HTTP 403: not your project' }
        : { success: true, data: { updatedTaskIds: args.task_ids, errors: [] } },
    );

    const result = await TaskService.bulkUpdateStatus([
      { id: 'a', status: 'completed' },
      { id: 'c', status: 'completed' },
    ], allProjects);
    expect(result.tasks.map((t: any) => t.id)).toEqual(['a']);
    expect(result.skipped).toEqual([{ id: 'c', reason: 'HTTP 403: not your project' }]);
  });

  it('a row the tool DECLINED (e.g. a live claim) is skipped-and-reported, never counted as applied', async () => {
    stubReads([
      { id: 'a', project_id: 'p1' },
      { id: 'b', project_id: 'p1' },
    ]);
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      // The tool confirms only `a`; `b` is refused because someone holds its claim.
      data: { updatedTaskIds: ['a'], errors: ['b: claimed by builder'] },
    });

    const result = await TaskService.bulkUpdateStatus([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
    ], allProjects);
    expect(result.tasks.map((t: any) => t.id)).toEqual(['a']);
    expect(result.skipped).toEqual([{ id: 'b', reason: 'b: claimed by builder' }]);
  });

  it('TOTAL failure still throws the original message — the controller\'s 500 is unchanged', async () => {
    stubReads([{ id: 'a', project_id: 'p1' }]);
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: false,
      error: 'connect ECONNREFUSED',
    });

    await expect(
      TaskService.bulkUpdateStatus([{ id: 'a', status: 'completed' }], allProjects),
    ).rejects.toThrow('Failed to bulk update task statuses');
  });

  it('an in-band tool rejection (200 with ok:false) counts as a failure, not a silent success', async () => {
    stubReads([{ id: 'a', project_id: 'p1' }]);
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { ok: false, error: 'Bulk update aborted: task not found' },
    });

    await expect(
      TaskService.bulkUpdateStatus([{ id: 'a', status: 'completed' }], allProjects),
    ).rejects.toThrow('Failed to bulk update task statuses');
  });

  it('an empty request is a no-op that touches neither the pool nor the tool', async () => {
    const spy = jest.spyOn(McpService, 'callTool');
    expect(await TaskService.bulkUpdateStatus([], allProjects)).toEqual({ tasks: [], skipped: [] });
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * THE CONTROLLER-TO-SERVICE ACTOR HOP.
 *
 * This is the ONE thing the deleted `assigneeTransitionStamp.db.test.ts` proved that lives
 * on the COMMAND side and therefore does not move to the mcp-server with the write: that
 * these routes derive the actor from the LOGGED-IN PRINCIPAL and pass it down, rather than
 * dropping it or inventing one. Everything that happens to the actor AFTER it is handed to
 * the tool (the transition-stamp rule itself) is now asserted once, in
 * mcp-server/src/tests/assigneeTransitionStamp.contract.test.ts, over both the single and
 * the bulk site.
 *
 * If this hop broke, the delegated write would silently attribute every UI action to
 * nobody — which is exactly the defect (`364 of 925 completed tasks with no assignee`) the
 * stamp was introduced to fix, reintroduced one layer up. So it is asserted here, at the
 * controller, with no DB and no MCP server in the way.
 */
describe('the task routes forward the logged-in principal as the stamp actor', () => {
  const { TaskController } = require('../controllers/task'); // eslint-disable-line @typescript-eslint/no-var-requires

  const res = () => {
    const r: any = {};
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    return r;
  };

  afterEach(() => jest.restoreAllMocks());

  const TASK = { id: 't1', project_id: 'p1', status: 'completed' } as any;

  it.each([
    ['PUT /tasks/:id', (req: any, r: any) => TaskController.updateTask(req, r)],
    ['POST /tasks/:id/assign', (req: any, r: any) => TaskController.assignTask(req, r)],
    ['POST /tasks/:id/status', (req: any, r: any) => TaskController.updateTaskStatus(req, r)],
  ])('%s passes normalizeActor(req.user.username) to TaskService.updateTask', async (_name, invoke) => {
    const spy = jest.spyOn(TaskService, 'updateTask').mockResolvedValue(TASK);
    jest.spyOn(TaskService, 'getTaskById').mockResolvedValue(TASK);

    await invoke(
      {
        params: { id: 't1' },
        // Mixed case + surrounding space: the normaliser is part of the claim, because
        // `Operator ` and `operator` becoming two actors is the bug it exists to prevent.
        user: { username: '  Operator  ' },
        body: { status: 'completed', assigned_to: 'operator' },
      },
      res(),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toBe('operator');
  });

  it('POST /tasks/bulk-update passes it to bulkUpdateStatus', async () => {
    const spy = jest
      .spyOn(TaskService, 'bulkUpdateStatus')
      .mockResolvedValue({ tasks: [], skipped: [] });

    await TaskController.bulkUpdateTasks(
      attachResolvedScope({ body: { updates: [{ id: 't1', status: 'completed' }] }, user: { username: 'Operator', id: 'u-operator', role: 'admin' } }),
      res(),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toBe('operator');
  });

  it('an UNAUTHENTICATED request yields undefined, never a placeholder name', async () => {
    // The negative control. A placeholder here would write a fake doer into the row, which
    // is worse than the empty column the rule deliberately leaves.
    const spy = jest.spyOn(TaskService, 'updateTask').mockResolvedValue(TASK);
    await TaskController.updateTask(
      { params: { id: 't1' }, body: { status: 'completed' } },
      res(),
    );
    expect(spy.mock.calls[0][2]).toBeUndefined();
  });
});
