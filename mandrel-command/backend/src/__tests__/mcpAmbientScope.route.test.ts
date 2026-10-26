/**
 * mcpAmbientScope.route.test.ts — behavioural proof that the /api/mcp passthrough's
 * deny-by-default now covers the AMBIENT (ref-less) path (Reviewer
 * nit 1 on an earlier change).
 *
 * THE GAP THIS PINS SHUT: the arguments door only authorized project refs that were
 * PRESENT. A tool call with NO ref forwarded unbound, and the proxy sends no
 * X-Connection-ID — so the mcp-server scoped it to the shared header-less connection
 * slot. A ZERO-GRANT authenticated user calling `context_get_recent {}` read whatever
 * project that slot pointed at.
 *
 * THE RULE UNDER TEST (routes/mcp.ts resolveScopeBinding — stated there, proven here):
 *   explicit authorized ref → bind · conflicting refs → 400 · global tool → unbound ·
 *   authorized X-Project-ID → bind · single grant → bind · zero grants → 403 ·
 *   multi-grant/admin ref-less → 400 naming the fix · grants lookup throws → 500.
 *
 * The app mounts the REAL projectContextMiddleware + the REAL routes/index.ts
 * aggregator exactly as server.ts does, so the X-Project-ID door in these tests is the
 * shipped object, not a shim. Only the DB doors and the upstream socket are stubbed.
 * "The upstream call carried the binding" is asserted here at the McpProxyService seam
 * (the 4th argument); the WIRE half — that the argument becomes a real
 * X-Mandrel-Project header on the outgoing request — is proven against a live capture
 * server in mcpProxyBinding.test.ts.
 */
import request from 'supertest';
import express, { Express } from 'express';

const TOKEN_BY_KIND: Record<string, string> = {
  admin: 'admin.aaa.bbb',
  uzero: 'uzero.aaa.bbb', // authenticated, ZERO grant rows — the headline population
  usolo: 'usolo.aaa.bbb', // exactly one grant
  umulti: 'umulti.aaa.bbb', // two grants
};

const baseUser = {
  email: 'someone@example.com',
  theme: 'dark' as const,
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) => {
      const kind = Object.keys(TOKEN_BY_KIND).find((k) => TOKEN_BY_KIND[k] === token);
      return kind ? { userId: kind, tokenId: `t-${kind}` } : null;
    },
    validateSession: async () => true,
    findUserById: async (userId: string) => ({
      ...baseUser,
      id: userId,
      username: `${userId}-name`,
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
import { projectContextMiddleware } from '../middleware/project';

const PROJECT_A = '11111111-2222-3333-4444-555555555555';
const PROJECT_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

/** Grants per fixture user — the mock reads THIS, tests never re-stub per case. */
const GRANTS: Record<string, string[]> = {
  uzero: [],
  usolo: [PROJECT_A],
  umulti: [PROJECT_A, PROJECT_B],
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Exactly server.ts's mounting order: the header door BEFORE the route family.
  app.use('/api', projectContextMiddleware);
  app.use('/api', apiRoutes);
  return app;
}

const UPSTREAM_OK = {
  status: 200,
  body: JSON.stringify({ success: true, result: { content: [{ type: 'text', text: 'ok' }] } }),
  contentType: 'application/json',
};

describe('POST /api/mcp/tools/:toolName — ambient project scope (the ref-less path)', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    McpProxyService.forwardToolCall.mockResolvedValue(UPSTREAM_OK);
    ProjectAccessService.listAccessibleProjectIds.mockImplementation(
      async (userId: string) => GRANTS[userId] ?? []
    );
    app = buildApp();
  });

  it('THE HEADLINE: zero-grant user + ref-less project-scoped tool → 403, upstream NEVER called', async () => {
    const res = await request(app)
      .post('/api/mcp/tools/context_get_recent')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.uzero}`)
      .send({ arguments: {} });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Project access denied');
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('zero-grant user, EMPTY body (no arguments at all — the absent population) → 403', async () => {
    const res = await request(app)
      .post('/api/mcp/tools/context_search')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.uzero}`)
      .send({});
    expect(res.status).toBe(403);
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('single-grant user, ref-less → 200, upstream call BOUND to the granted project', async () => {
    const res = await request(app)
      .post('/api/mcp/tools/context_get_recent')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.usolo}`)
      .send({ arguments: { limit: 3 } });
    expect(res.status).toBe(200);
    expect(McpProxyService.forwardToolCall).toHaveBeenCalledWith(
      'context_get_recent',
      { arguments: { limit: 3 } },
      'usolo-name',
      PROJECT_A // the binding IS the fix — asserted, not implied
    );
  });

  it('multi-grant user, ref-less → 400 with a message NAMING the fix; upstream never called', async () => {
    const res = await request(app)
      .post('/api/mcp/tools/context_get_recent')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.umulti}`)
      .send({ arguments: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Ambiguous project scope');
    expect(res.body.message).toContain('arguments.projectId');
    expect(res.body.message).toContain('X-Project-ID');
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('admin, ref-less → 400 (all-projects has no single scope; explicit ref required)', async () => {
    const res = await request(app)
      .post('/api/mcp/tools/project_current')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .send({ arguments: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Ambiguous project scope');
    // Admin never consults the grant table — all-projects is a role property.
    expect(ProjectAccessService.listAccessibleProjectIds).not.toHaveBeenCalled();
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('authorized X-Project-ID header + ref-less → 200 bound to the header project (the UI path)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true); // the middleware door
    const res = await request(app)
      .post('/api/mcp/tools/context_get_recent')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.umulti}`)
      .set('X-Project-ID', PROJECT_B)
      .send({ arguments: {} });
    expect(res.status).toBe(200);
    expect(McpProxyService.forwardToolCall).toHaveBeenCalledWith(
      'context_get_recent',
      { arguments: {} },
      'umulti-name',
      PROJECT_B
    );
    // The grant table is not consulted on this path — the middleware already authorized.
    expect(ProjectAccessService.listAccessibleProjectIds).not.toHaveBeenCalled();
  });

  it('UNAUTHORIZED X-Project-ID header still dies at the middleware door (403, control)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/mcp/tools/context_get_recent')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.uzero}`)
      .set('X-Project-ID', PROJECT_A)
      .send({ arguments: {} });
    expect(res.status).toBe(403);
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('explicit authorized ref → 200 and the upstream call is bound to the SAME resolved id', async () => {
    ProjectAccessService.resolveProjectId.mockResolvedValue(PROJECT_A);
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/mcp/tools/context_search')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.uzero}`)
      .send({ arguments: { query: 'q', projectId: 'a-project-name' } });
    expect(res.status).toBe(200);
    expect(McpProxyService.forwardToolCall).toHaveBeenCalledWith(
      'context_search',
      { arguments: { query: 'q', projectId: 'a-project-name' } },
      'uzero-name',
      PROJECT_A
    );
  });

  it('conflicting refs (projectId + project → DIFFERENT projects, both authorized) → 400', async () => {
    ProjectAccessService.resolveProjectId
      .mockResolvedValueOnce(PROJECT_A)
      .mockResolvedValueOnce(PROJECT_B);
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/mcp/tools/context_search')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .send({ arguments: { query: 'q', projectId: 'name-a', project: 'name-b' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Conflicting project references');
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });

  it('GLOBAL tool (mandrel_ping), zero-grant user, ref-less → 200 forwarded UNBOUND', async () => {
    const res = await request(app)
      .post('/api/mcp/tools/mandrel_ping')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.uzero}`)
      .send({ arguments: { message: 'hi' } });
    expect(res.status).toBe(200);
    expect(McpProxyService.forwardToolCall).toHaveBeenCalledWith(
      'mandrel_ping',
      { arguments: { message: 'hi' } },
      'uzero-name',
      undefined // no binding — and no project data flows through this handler
    );
    expect(ProjectAccessService.listAccessibleProjectIds).not.toHaveBeenCalled();
  });

  it('grants lookup THROWS → 500, never forwarded, never a silent deny (C1)', async () => {
    ProjectAccessService.listAccessibleProjectIds.mockRejectedValue(new Error('db down'));
    const res = await request(app)
      .post('/api/mcp/tools/context_get_recent')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.usolo}`)
      .send({ arguments: {} });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Project scope resolution failed');
    expect(McpProxyService.forwardToolCall).not.toHaveBeenCalled();
  });
});
