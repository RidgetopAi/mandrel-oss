/**
 * mcpPassthrough.route.test.ts — behavioural proof of the /api/mcp trust boundary
 *.
 *
 * The app under test mounts the REAL `src/routes/index.ts` aggregator at `/api` — the
 * same object server.ts mounts — so the family-wide `router.use(authenticateToken)`,
 * the read allow-list, the arguments-project authorization and route ordering are all
 * the shipped objects. Only the DB doors and the upstream socket are stubbed:
 *   - AuthService        (JWT/session verification → role-keyed fixture users)
 *   - ProjectAccessService (the grant table)
 *   - McpProxyService    (the upstream forward — doubles as the NON-DELEGATION PROBE:
 *     asserting it was NEVER CALLED is what "the call did not leave the boundary"
 *     means, stronger than any status code)
 *
 * Populations probed (C3): missing token · write tool · scope-switch tool · unknown
 * tool · empty-ish tool name · non-admin without grant · non-admin with grant · admin
 * bypass · unresolvable project ref · access check THROWS (the could-not-measure branch
 * must not forward) · no project ref at all (the happy read path).
 */
import request from 'supertest';
import express, { Express } from 'express';

const TOKENS = {
  admin: 'admin.aaa.bbb',
  user: 'user.aaa.bbb',
};

const baseUser = {
  id: 'u-fixture',
  username: 'someone',
  email: 'someone@example.com',
  theme: 'dark' as const,
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

/**
 * The REAL authenticateToken runs; only its DB calls are stubbed. (The X-Project-ID
 * HEADER door is app-level projectContextMiddleware, mounted by server.ts before this
 * router — it has its own behavioural suite, projectScopeEnforcement.test.ts. This
 * suite exercises the ARGUMENTS door, which lives in the route itself.)
 */
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) => {
      const kind = (Object.keys(TOKENS) as Array<keyof typeof TOKENS>).find(
        (k) => TOKENS[k] === token
      );
      return kind ? { userId: kind, tokenId: `t-${kind}` } : null;
    },
    validateSession: async () => true,
    findUserById: async (userId: string) => ({
      ...baseUser,
      id: userId,
      username: userId === 'admin' ? 'the-admin' : 'the-user',
      role: userId === 'admin' ? 'admin' : 'user',
    }),
  },
}));

jest.mock('../services/projectAccess', () => ({
  ProjectAccessService: {
    userHasProjectAccess: jest.fn(),
    resolveProjectId: jest.fn(),
    listAccessibleProjectIds: jest.fn(),
    grantAccess: jest.fn(),
    revokeAccess: jest.fn(),
  },
}));

jest.mock('../services/mcpProxy', () => ({
  McpProxyService: {
    forwardToolCall: jest.fn(),
    forwardToolList: jest.fn(),
    forwardHealthz: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProjectAccessService } = require('../services/projectAccess');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { McpProxyService } = require('../services/mcpProxy');

import apiRoutes from '../routes/index';

const PROJECT_A = '11111111-2222-3333-4444-555555555555';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  return app;
}

const UPSTREAM_OK = {
  status: 200,
  body: JSON.stringify({ success: true, result: { content: [{ type: 'text', text: 'pong' }] } }),
  contentType: 'application/json',
};

describe('POST /api/mcp/tools/:toolName — the authenticated read passthrough', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    McpProxyService.forwardToolCall.mockResolvedValue(UPSTREAM_OK);
    app = buildApp();
  });

  it('401 with no token — and the upstream is never touched', async () => {
    const res = await request(app).post('/api/mcp/tools/mandrel_ping').send({ arguments: {} });
    expect(res.status).toBe(401);
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('relays an allow-listed read verbatim, attaching the actor (the happy path control)', async () => {
    const res = await request(app)
      .post('/api/mcp/tools/mandrel_ping')
      .set('Authorization', `Bearer ${TOKENS.user}`)
      .send({ arguments: { message: 'hi' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(UPSTREAM_OK.body));
    expect(McpProxyService.forwardToolCall).toHaveBeenCalledWith(
      'mandrel_ping',
      { arguments: { message: 'hi' } },
      'the-user',
      undefined // global tool - forwarded UNBOUND (ambient scope rule)
    );
    // No project ref in the args → the grant table is not consulted on this door.
    expect(ProjectAccessService.userHasProjectAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['a write tool', 'context_store'],
    ['a scope-switch tool', 'project_switch'],
    ['an unknown tool', 'tool_that_does_not_exist'],
    ['a whitespace name', '%20'],
  ])('403 for %s — deny-by-default, upstream never called', async (_label, tool) => {
    const res = await request(app)
      .post(`/api/mcp/tools/${tool}`)
      .set('Authorization', `Bearer ${TOKENS.user}`)
      .send({ arguments: {} });
    expect(res.status).toBe(403);
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('403 when arguments carry a project the user has NO grant for — upstream never called', async () => {
    ProjectAccessService.resolveProjectId.mockResolvedValue(PROJECT_A);
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/mcp/tools/context_search')
      .set('Authorization', `Bearer ${TOKENS.user}`)
      .send({ arguments: { query: 'q', projectId: PROJECT_A } });
    expect(res.status).toBe(403);
    expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user', role: 'user' }),
      PROJECT_A
    );
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('forwards when the user HAS the grant', async () => {
    ProjectAccessService.resolveProjectId.mockResolvedValue(PROJECT_A);
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/mcp/tools/context_search')
      .set('Authorization', `Bearer ${TOKENS.user}`)
      .send({ arguments: { query: 'q', projectId: PROJECT_A } });
    expect(res.status).toBe(200);
    expect(McpProxyService.forwardToolCall).toHaveBeenCalledTimes(1);
  });

  it('admin passes the same door (positive control for the role bypass)', async () => {
    ProjectAccessService.resolveProjectId.mockResolvedValue(PROJECT_A);
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/mcp/tools/context_search')
      .set('Authorization', `Bearer ${TOKENS.admin}`)
      .send({ arguments: { projectId: PROJECT_A } });
    expect(res.status).toBe(200);
    expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin', role: 'admin' }),
      PROJECT_A
    );
  });

  it('403 for an UNRESOLVABLE project reference (never "forward and hope")', async () => {
    ProjectAccessService.resolveProjectId.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/mcp/tools/context_get_recent')
      .set('Authorization', `Bearer ${TOKENS.user}`)
      .send({ arguments: { projectId: 'ghost-project' } });
    expect(res.status).toBe(403);
    expect(ProjectAccessService.userHasProjectAccess).not.toHaveBeenCalled();
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('500 (NOT forward, NOT allow) when the access check itself throws — C1: could-not-measure gets its own branch', async () => {
    ProjectAccessService.resolveProjectId.mockResolvedValue(PROJECT_A);
    ProjectAccessService.userHasProjectAccess.mockRejectedValue(new Error('db down'));
    const res = await request(app)
      .post('/api/mcp/tools/context_search')
      .set('Authorization', `Bearer ${TOKENS.user}`)
      .send({ arguments: { projectId: PROJECT_A } });
    expect(res.status).toBe(500);
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('502 with its own error body when the upstream is unreachable (not a fake tool result)', async () => {
    McpProxyService.forwardToolCall.mockRejectedValue(new Error('MCP upstream unreachable: ECONNREFUSED'));
    const res = await request(app)
      .post('/api/mcp/tools/mandrel_ping')
      .set('Authorization', `Bearer ${TOKENS.user}`)
      .send({ arguments: {} });
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/mcp/tools and /api/mcp/healthz', () => {
  let app: Express;
  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('tools list requires auth and relays upstream', async () => {
    McpProxyService.forwardToolList.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ success: true, tools: ['mandrel_ping'] }),
      contentType: 'application/json',
    });
    expect((await request(app).get('/api/mcp/tools')).status).toBe(401);
    const res = await request(app).get('/api/mcp/tools').set('Authorization', `Bearer ${TOKENS.user}`);
    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual(['mandrel_ping']);
  });

  it('healthz requires auth (the browser widget is logged-in-only) and relays upstream', async () => {
    McpProxyService.forwardHealthz.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ status: 'ok' }),
      contentType: 'application/json',
    });
    expect((await request(app).get('/api/mcp/healthz')).status).toBe(401);
    const res = await request(app).get('/api/mcp/healthz').set('Authorization', `Bearer ${TOKENS.user}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
