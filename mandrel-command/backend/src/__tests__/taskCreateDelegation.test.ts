import { TaskService, CreateTaskRequest, PunchIncompleteRequestError } from '../services/task';
import { McpService } from '../services/mcp';

/**
 * an earlier task — the Command backend's createTask must DELEGATE to the mcp-server
 * `task_create` tool (the ONE write path that mints typed graph edges + attributes the
 * actor), instead of the old raw `INSERT ... RETURNING *` that made every Command-born
 * task a graph leaf (fix the class — one write path, not two).
 *
 * These are UNIT tests: McpService.callTool is mocked so no DB / MCP server is needed
 * (createTask no longer touches the pool). They assert the DELEGATION + arg mapping +
 * the REST response adapter + the error/no-payload paths (no false 200 over a failed
 * write). `tests-are-the-rock`: we assert real behavior, not a lying stub.
 */
describe('TaskService.createTask delegates to the task_create tool', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls task_create with the DTO mapped to the tool arg names, forwards the actor, and maps structuredContent.task back to the exact REST Task shape', async () => {
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: {
        action: 'created',
        task: {
          id: 'task-uuid-1',
          url: 'https://command.example.com/r/task-uui',
          title: 'Wire the thing',
          type: 'feature',
          status: 'todo',
          priority: 'high',
          assignedTo: 'operator',
          tags: ['task:abc12345', 'scope:x'],
          dependencies: ['dep-uuid-1'],
          createdAt: '2026-07-23T12:00:00.000Z',
          // The mint report the tool returns — its PRESENCE is the proof edges are minted
          // on the delegated path (the whole point of the class fix).
          edgesMinted: 2,
          mintedBySource: { tags: 1, dependencies: 1, links: 0 },
          edgeSkips: [],
          linkWarnings: [],
        },
      },
    });

    const input: CreateTaskRequest = {
      project_id: 'proj-uuid-1',
      title: 'Wire the thing',
      description: 'do it',
      type: 'feature',
      priority: 'high',
      assigned_to: 'operator',
      dependencies: ['dep-uuid-1'],
      tags: ['task:abc12345', 'scope:x'],
      metadata: { foo: 'bar' },
    };

    const task = await TaskService.createTask(input, 'operator');

    // Delegated to the ONE write path (the tool), never raw SQL.
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, args, actor] = spy.mock.calls[0] as [string, any, string];
    expect(tool).toBe('task_create');
    expect(actor).toBe('operator');

    // DTO → tool arg-name mapping (project_id→projectId, assigned_to→assignedTo, …).
    expect(args).toEqual({
      projectId: 'proj-uuid-1',
      title: 'Wire the thing',
      description: 'do it',
      type: 'feature',
      priority: 'high',
      assignedTo: 'operator',
      dependencies: ['dep-uuid-1'],
      tags: ['task:abc12345', 'scope:x'],
      metadata: { foo: 'bar' },
    });

    // REST Task shape preserved EXACTLY (what the controller/frontend consume) — the only
    // observable change from delegation is that edges now mint (asserted via the tool call).
    expect(task).toEqual({
      id: 'task-uuid-1',
      project_id: 'proj-uuid-1',
      title: 'Wire the thing',
      description: 'do it',
      type: 'feature',
      status: 'todo',
      // THE PUNCH LIST LANE (migration 101): absent on the mocked tool response → null.
      stage: null,
      priority: 'high',
      assigned_to: 'operator',
      dependencies: ['dep-uuid-1'],
      tags: ['task:abc12345', 'scope:x'],
      metadata: { foo: 'bar' },
      created_at: '2026-07-23T12:00:00.000Z',
      updated_at: '2026-07-23T12:00:00.000Z',
    });
  });

  it('omits undefined optionals so the tool applies its own defaults, and maps an unset assignee to null', async () => {
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: {
        task: {
          id: 'task-uuid-2',
          title: 'Minimal',
          type: 'general',
          status: 'todo',
          priority: 'medium',
          assignedTo: null,
          tags: [],
          dependencies: [],
          createdAt: '2026-07-23T13:00:00.000Z',
        },
      },
    });

    const task = await TaskService.createTask({
      project_id: 'proj-uuid-1',
      title: 'Minimal',
    } as CreateTaskRequest);

    const [, args] = spy.mock.calls[0] as [string, any, string];
    // Only projectId + title sent — no type/priority/assignedTo/etc., so the tool's
    // documented defaults are the single source (no drifting copy of them here).
    expect(args).toEqual({ projectId: 'proj-uuid-1', title: 'Minimal' });
    expect(task.assigned_to).toBeNull();
    expect(task.metadata).toEqual({});
    expect(task.updated_at).toBe('2026-07-23T13:00:00.000Z'); // == created_at on fresh create
  });

  it('maps a tool error (isError → callTool.success=false) to a thrown error — never a false-success task', async () => {
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: false,
      error: 'MCP validation failed: project not found',
    });

    await expect(
      TaskService.createTask({ project_id: 'bad', title: 'x' } as CreateTaskRequest),
    ).rejects.toThrow('Failed to create task');
  });

  it('throws when the tool returns success but no task payload (no phantom 200 over a malformed write)', async () => {
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { action: 'created' },
    });

    await expect(
      TaskService.createTask({ project_id: 'p', title: 'x' } as CreateTaskRequest),
    ).rejects.toThrow('Failed to create task');
  });

  // THE PUNCH LIST LANE (migration 101).
  it('forwards stage and punch to task_create, and maps toolTask.stage back onto the REST Task', async () => {
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: {
        action: 'created',
        task: {
          id: 'task-uuid-2', title: 'Ready task', type: 'feature', status: 'todo',
          stage: 'ready', priority: 'medium', tags: [], dependencies: [],
          createdAt: '2026-09-10T00:00:00.000Z',
        },
      },
    });

    const task = await TaskService.createTask({
      project_id: 'proj-uuid-1', title: 'Ready task',
      stage: 'ready', punch: { doneWhen: 'when green', proofKind: 'test' },
    } as CreateTaskRequest);

    const [, args] = spy.mock.calls[0] as [string, any, string];
    expect(args.stage).toBe('ready');
    expect(args.punch).toEqual({ doneWhen: 'when green', proofKind: 'test' });
    expect(task.stage).toBe('ready');
  });

  it('maps a [PUNCH_INCOMPLETE] tool refusal to a typed PunchIncompleteRequestError, never the generic 500', async () => {
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { ok: false, code: 'PUNCH_INCOMPLETE', missing: ['doneWhen', 'proofKind'] },
    });

    let caught: any;
    try {
      await TaskService.createTask({
        project_id: 'proj-uuid-1', title: 'incomplete', stage: 'ready',
      } as CreateTaskRequest);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PunchIncompleteRequestError);
    expect(caught.code).toBe('PUNCH_INCOMPLETE');
    expect(caught.missing).toEqual(['doneWhen', 'proofKind']);
  });
});
