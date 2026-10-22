import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Env is stubbed in beforeAll (NOT at module scope) and restored in afterAll — same class
// of fix as betterAuthOAuth.integration.test.ts. process.env is shared by
// every file in the run (vitest.config pins the suite to ONE fork), so a module-scope write
// leaks into every file that runs afterwards. `AIDIS_SKIP_DATABASE='true'` was the live
// hazard here: unconditional at module scope with no cleanup, it could leak into a later
// DB-BACKED file and silently make it skip the database it is supposed to be testing.
// Every module that reads these is imported DYNAMICALLY inside the `it` blocks below, so
// stubbing in beforeAll still lands before any module-eval read.
const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_isolation_test',
  DATABASE_USER: process.env.DATABASE_USER || 'test_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'test_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: 'true',
  AIDIS_SKIP_BACKGROUND: 'true',
  AIDIS_SKIP_STDIO: 'true',
};

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const mocks = vi.hoisted(() => ({
  projectHandler: {
    initializeSession: vi.fn(),
    getCurrentProjectId: vi.fn(),
    getCurrentProject: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
  },
  switchProjectWithValidation: vi.fn(),
  contextHandler: {
    storeContext: vi.fn(),
  },
  sessionTracking: {
    trackContextStored: vi.fn(),
  },
}));

vi.mock('../handlers/project.js', () => ({
  projectHandler: mocks.projectHandler,
}));

vi.mock('../services/projectSwitchValidator.js', () => ({
  switchProjectWithValidation: mocks.switchProjectWithValidation,
}));

vi.mock('../handlers/context.js', () => ({
  contextHandler: mocks.contextHandler,
}));

vi.mock('../api/middleware/sessionTracking.js', () => ({
  SessionTrackingMiddleware: mocks.sessionTracking,
}));

describe('connection-scoped project isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes X-Connection-ID from the HTTP bridge into MCP tool execution context', async () => {
    const { HealthServer } = await import('../server/healthServer.js');
    const executor = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const healthServer = new HealthServer(executor);

    const req = {
      params: { toolName: 'project_current' },
      body: { arguments: {} },
      header: (name: string) => (name === 'X-Connection-ID' ? 'client-a' : undefined),
    };
    const res: any = {
      status: vi.fn(() => res),
      json: vi.fn(),
    };

    await (healthServer as any).handleMcpToolExpress(req, res);

    // the transport now also states WHETHER the caller presented an identity.
    // A present X-Connection-ID is one, so this call is `identified: true`.
    expect(executor).toHaveBeenCalledWith('project_current', {}, {
      connectionId: 'client-a',
      identified: true,
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
  });

  /**
   * WAS: `expect(executor).toHaveBeenCalledWith('project_current', {},
   * { connectionId: 'http-default' })` — an assertion that PINNED the bug. It said the whole
   * truth about a header-less caller is the shared literal, which is exactly the information
   * loss that let every unidentified caller share one project slot: downstream, "sent no
   * identity" and "explicitly named http-default" were the same string.
   *
   * The literal is deliberately UNCHANGED (removing it re-keys reads — guard G3), so this
   * test still asserts it. What is added is the fact the collapse used to destroy: the
   * transport now says `identified: false` alongside it. Any correct fix had to make this
   * assertion RED, which is how we knew the change landed.
   */
  it('uses a named shared HTTP fallback when the connection header is absent, and SAYS SO', async () => {
    const { HealthServer } = await import('../server/healthServer.js');
    const executor = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const healthServer = new HealthServer(executor);

    const req = {
      params: { toolName: 'project_current' },
      body: { arguments: {} },
      header: () => undefined,
    };
    const res: any = {
      status: vi.fn(() => res),
      json: vi.fn(),
    };

    await (healthServer as any).handleMcpToolExpress(req, res);

    expect(executor).toHaveBeenCalledWith('project_current', {}, {
      connectionId: 'http-default',
      identified: false,
    });
  });

  /**
   * SUBJECT: connection isolation — two connections switching projects must NOT share state,
   * i.e. each switch is routed with its OWN connectionId. That is what this asserts.
   *
   * The project IDENTIFIER form changed under routeExecutor now canonicalises
   * an explicit project argument name→UUID at the choke point before dispatch, so the handler
   * receives the resolved id rather than the raw name. `projectHandler.getProject` is
   * therefore stubbed to resolve these fixture names (previously it returned undefined, which
   * only went unnoticed because nothing consulted it on this path). The isolation assertion —
   * one switch per connection, correct connectionId, in order — is unchanged and is still the
   * thing that goes RED if connection scoping regresses.
   */
  it('routes project switches through separate session IDs per connection', async () => {
    const { routeExecutor } = await import('../routes/index.js');
    const RESOLVED: Record<string, string> = {
      'mandrel-stab': '11111111-1111-4111-8111-111111111111',
      'assistant-agent': '22222222-2222-4222-8222-222222222222',
    };
    mocks.projectHandler.getProject.mockImplementation(async (identifier: string) => {
      const id = RESOLVED[identifier];
      return id ? { id, name: identifier } : null;
    });
    mocks.switchProjectWithValidation.mockImplementation(async (project: string) => ({
      id: `${project}-id`,
      name: project,
      description: null,
      status: 'active',
      contextCount: 0,
      updatedAt: new Date('2026-05-11T00:00:00.000Z'),
    }));

    await routeExecutor('project_switch', { project: 'mandrel-stab' }, { connectionId: 'client-a' });
    await routeExecutor('project_switch', { project: 'assistant-agent' }, { connectionId: 'client-b' });

    expect(mocks.switchProjectWithValidation).toHaveBeenNthCalledWith(
      1, RESOLVED['mandrel-stab'], 'client-a'
    );
    expect(mocks.switchProjectWithValidation).toHaveBeenNthCalledWith(
      2, RESOLVED['assistant-agent'], 'client-b'
    );
  });

  it('resolves implicit context_store project from the calling connection', async () => {
    const { routeExecutor } = await import('../routes/index.js');

    mocks.projectHandler.initializeSession.mockResolvedValue(null);
    mocks.projectHandler.getCurrentProjectId.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'client-a') return 'project-a';
      if (sessionId === 'client-b') return 'project-b';
      return null;
    });
    mocks.contextHandler.storeContext.mockImplementation(async (input: any) => ({
      id: `ctx-${input.projectId}`,
      contextType: input.type,
      relevanceScore: 5,
      tags: input.tags || [],
      createdAt: new Date('2026-05-11T00:00:00.000Z'),
      content: input.content,
    }));

    await routeExecutor(
      'context_store',
      { content: 'client A memory', type: 'completion' },
      { connectionId: 'client-a' },
    );
    await routeExecutor(
      'context_store',
      { content: 'client B memory', type: 'completion' },
      { connectionId: 'client-b' },
    );

    expect(mocks.contextHandler.storeContext).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: 'project-a', content: 'client A memory' }),
    );
    expect(mocks.contextHandler.storeContext).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ projectId: 'project-b', content: 'client B memory' }),
    );
  });
});
