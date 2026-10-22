/**
 * sessionStartBodyGovernsProject — WHAT DECIDES A NEW SESSION'S PROJECT.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE CLAIM THIS EXISTS TO KEEP TRUE
 * ════════════════════════════════════════════════════════════════════════════════════
 * `frontend/src/pages/sessions/NewSessionModal.tsx` tells its reader that the BODY's
 * `projectId` is what scopes the write, and that `X-Project-ID` is not what makes it
 * land. That used to be the opposite claim, and the opposite claim was false — the
 * header is a per-request pin honoured by THIS backend's own routes, and it reads as
 * though it governs everywhere.
 *
 * A comment that is merely accurate today is not a guard: nothing tells the next author
 * that adding `X-Project-ID` to `mcpProxyHeaders` silently makes a paragraph in the UI
 * wrong. So the paragraph is pinned here, at the proxy boundary that actually decides
 * it.
 *
 * ── THE TWO ASSERTIONS, AND WHY BOTH ─────────────────────────────────────────────────
 * "The header does not govern" and "the body governs" are different facts, and only
 * asserting the first would pass a proxy that forwards neither — which would break the
 * feature while agreeing with the comment.
 *
 * The population is EVERY proxied route on this router, not just `/start`: the header is
 * dropped by a shared header builder, so a route added later inherits the behaviour and
 * inherits this assertion with it.
 *
 * DB-free: AuthService and global fetch are mocked, exactly as in sessionsProxyToken.
 */

import request from 'supertest';
import express, { Express } from 'express';

const VALID_TOKEN = 'aaa.bbb.ccc';
const SERVICE_TOKEN = 'test-internal-mcp-service-token-9f8e7d';

/** The project the BROWSER pinned on the request. It must not survive the proxy. */
const HEADER_PROJECT = 'aaaaaaaa-1111-4111-8111-111111111111';
/** The project the FORM named. It must arrive at the mcp-server unchanged. */
const BODY_PROJECT = 'bbbbbbbb-2222-4222-8222-222222222222';

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) =>
      token === VALID_TOKEN ? { userId: 'user-1', tokenId: 'token-1' } : null,
    validateSession: async () => true,
    findUserById: async () => ({
      id: 'user-1',
      username: 'coordinator',
      email: 'coordinator@example.com',
      role: 'admin',
      theme: 'dark',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    }),
  },
}));

const mockFetch = jest.fn(async () => ({
  status: 200,
  ok: true,
  json: async () => ({ success: true, data: {} }),
}));

const UUID = '11111111-1111-4111-8111-111111111111';
/** Every route on this router that reaches the mcp-server over fetch. */
const PROXY_ROUTES: Array<{ name: string; method: 'get' | 'post'; path: string }> = [
  { name: 'GET  /api/v2/sessions (list)', method: 'get', path: '/api/v2/sessions' },
  { name: 'GET  /api/v2/sessions/active', method: 'get', path: '/api/v2/sessions/active' },
  { name: 'POST /api/v2/sessions/start', method: 'post', path: '/api/v2/sessions/start' },
  { name: 'GET  /api/v2/sessions/:id/files', method: 'get', path: `/api/v2/sessions/${UUID}/files` },
  {
    name: 'POST /api/v2/sessions/:id/sync-files',
    method: 'post',
    path: `/api/v2/sessions/${UUID}/sync-files`,
  },
  { name: 'POST /api/v2/sessions/:id/end', method: 'post', path: `/api/v2/sessions/${UUID}/end` },
];

let app: Express;

beforeAll(() => {
  process.env.MCP_AUTH_TOKEN = SERVICE_TOKEN;
  delete process.env.ALLOW_DEV_AUTH_BYPASS;
  process.env.NODE_ENV = 'test';

  (global as unknown as { fetch: unknown }).fetch = mockFetch;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sessionRoutesV2 = require('../routes/sessionsProxy').default;

  app = express();
  app.use(express.json());
  app.use('/api/v2/sessions', sessionRoutesV2);
});

beforeEach(() => mockFetch.mockClear());

/** The header names actually put on the outbound request, lowercased for comparison. */
function outboundHeaderNames(): string[] {
  const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
  return Object.keys((init.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase());
}

describe('the browser X-Project-ID does NOT reach the mcp-server', () => {
  it.each(PROXY_ROUTES)('$name drops it', async ({ method, path }) => {
    const agent = request(app);
    const res = await agent[method](path)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-ID', HEADER_PROJECT)
      .send({});

    expect(res.status).not.toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Asserted by NAME, not by value: a proxy that forwarded the header under any
    // casing, or forwarded a different project in it, both fail here.
    expect(outboundHeaderNames()).not.toContain('x-project-id');

    // The control: the headers the proxy IS responsible for are present, so "no
    // x-project-id" cannot be passing because the header set is empty.
    expect(outboundHeaderNames()).toContain('authorization');
  });
});

describe("the BODY's projectId is what reaches the mcp-server", () => {
  it('forwards the form-named project verbatim, even against a conflicting header', async () => {
    await request(app)
      .post('/api/v2/sessions/start')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-ID', HEADER_PROJECT)
      .send({ projectId: BODY_PROJECT, title: 'from the modal' });

    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(body.projectId).toBe(BODY_PROJECT);
    // Stated three ways so no failure mode reads as a pass: it named the form's
    // project, not the header's, and not "no project" (which mcp-server auto-detects).
    expect(body.projectId).not.toBe(HEADER_PROJECT);
    expect(body.projectId).toBeDefined();
  });

  it('forwards NO project when the form named none, rather than substituting the header', async () => {
    // The "auto-detect / unassigned" case. The header is present and would be a
    // tempting fallback; substituting it here is precisely the behaviour the modal's
    // header paragraph must not be able to start describing again by accident.
    await request(app)
      .post('/api/v2/sessions/start')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('X-Project-ID', HEADER_PROJECT)
      .send({ title: 'no project named' });

    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.projectId).toBeUndefined();
  });
});
