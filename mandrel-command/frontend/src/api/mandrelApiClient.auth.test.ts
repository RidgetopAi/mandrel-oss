/**
 * The Command UI must present its login JWT as `Authorization: Bearer <jwt>` on its MCP
 * calls. Since an earlier task those calls land on the AUTHENTICATED COMMAND BACKEND at
 * /api/mcp/* (single trust boundary — the direct browser→mcp-server path is retired),
 * so the JWT is THE credential: authenticateToken 401s without it. This proves
 * MandrelApiClient attaches the header from the canonical getValidToken() source, hits
 * the /api/mcp/* paths, and omits the header (unchanged) when no token exists.
 * (Originally written as the interim-shield proof for direct fetches.)
 */
import { MandrelApiClient } from './mandrelApiClient';

// Build a decodable, UNEXPIRED HS256 JWT (jwt-decode only decodes; the signature is not
// verified client-side, so a fixture with a real `exp` is faithful — mirrors authToken.test).
const base64url = (obj: object): string =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const makeJwt = (payload: object): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.testsig`;
const validToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, username: 'operator' });

function mockFetchOk(bodyObj: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(bodyObj), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function authHeaderFrom(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  const headers = init.headers as Record<string, string>;
  return headers.Authorization;
}

describe('MandrelApiClient attaches the login JWT on /api/mcp/* calls', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('callTool sends Authorization: Bearer <token> when a valid token is stored', async () => {
    localStorage.setItem('aidis_token', validToken);
    const fetchMock = mockFetchOk({ success: true, result: { ok: true } });

    const client = new MandrelApiClient();
    await client.callTool('mandrel_ping', {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/mcp/tools/mandrel_ping');
    expect(authHeaderFrom(fetchMock)).toBe(`Bearer ${validToken}`);
  });

  test('listTools (GET /api/mcp/tools) also carries the Bearer header', async () => {
    localStorage.setItem('aidis_token', validToken);
    const fetchMock = mockFetchOk({ success: true, tools: [] });

    const client = new MandrelApiClient();
    await client.listTools();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/mcp/tools');
    expect(authHeaderFrom(fetchMock)).toBe(`Bearer ${validToken}`);
  });

  test('no Authorization header when no token is stored (unchanged behavior)', async () => {
    const fetchMock = mockFetchOk({ success: true, result: {} });

    const client = new MandrelApiClient();
    await client.callTool('mandrel_ping', {});

    expect(authHeaderFrom(fetchMock)).toBeUndefined();
  });

  test('an expired token is NOT sent (getValidToken purges it)', async () => {
    localStorage.setItem('aidis_token', makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }));
    const fetchMock = mockFetchOk({ success: true, result: {} });

    const client = new MandrelApiClient();
    await client.callTool('mandrel_ping', {});

    expect(authHeaderFrom(fetchMock)).toBeUndefined();
  });
});
