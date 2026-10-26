/**
 * The Command backend's CLASSIFIER for the internal better-auth sign-in.
 *
 * The one place an HTTP answer from the mcp-server becomes a sign-in verdict. Its job is to
 * keep "the person is wrong" apart from "I could not check" (CLASSES C1): only better-auth's
 * own `no-match` verdict — or `not-enabled`, meaning this instance has no better-auth sign-in —
 * may become `no-match`. A 404 (wrong path, version skew), every transport failure, every 5xx,
 * and a refusal of OUR service credential must become `unavailable`, which the login route
 * answers 503, never 401.
 *
 * Driven against a real local HTTP server that plays the mcp-server, through the SHIPPED
 * function and the SHIPPED target resolution (MANDREL_MCP_URL) and auth header (MCP_AUTH_TOKEN).
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

type Reply = { status: number; body?: unknown; delayMs?: number };
let reply: Reply = { status: 200 };
const seen: Array<{ url?: string; auth?: string; body: string }> = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    const send = () => {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });
});

let mod: typeof import('../services/betterAuthSignIn');
const SERVICE_TOKEN = 'svc-token-for-classifier-test';
const saved = { url: process.env.MANDREL_MCP_URL, token: process.env.MCP_AUTH_TOKEN, to: process.env.MANDREL_DASHBOARD_SIGNIN_TIMEOUT_MS };

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  process.env.MANDREL_MCP_URL = `http://127.0.0.1:${port}`;
  process.env.MCP_AUTH_TOKEN = SERVICE_TOKEN;
  process.env.MANDREL_DASHBOARD_SIGNIN_TIMEOUT_MS = '300';
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../services/betterAuthSignIn');
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of [['MANDREL_MCP_URL', saved.url], ['MCP_AUTH_TOKEN', saved.token], ['MANDREL_DASHBOARD_SIGNIN_TIMEOUT_MS', saved.to]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  seen.length = 0;
});

const OK_BODY = { result: 'ok', user: { id: 'ba-1', email: 'c@x.test' }, session: { id: 'sess-1', expiresAt: '2030-01-01T00:00:00Z' } };

describe('signInThroughBetterAuth — the four verdicts', () => {
  it('calls the internal path with the static service token and the credentials', async () => {
    reply = { status: 200, body: OK_BODY };
    await mod.signInThroughBetterAuth('c@x.test', 'pw', '203.0.113.9');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/internal/dashboard-auth/sign-in');
    expect(seen[0].auth).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(JSON.parse(seen[0].body)).toEqual({ email: 'c@x.test', password: 'pw', clientIp: '203.0.113.9' });
  });

  it.each<[string, string, Reply]>([
    ['200 ok', 'ok', { status: 200, body: OK_BODY }],
    ['200 no-match', 'no-match', { status: 200, body: { result: 'no-match' } }],
    ['200 not-enabled (OAuth off: no better-auth sign-in here)', 'no-match', { status: 200, body: { result: 'not-enabled' } }],
    ['404 (no such route: path drift / version skew)', 'unavailable', { status: 404, body: {} }],
    ['429', 'rate-limited', { status: 429, body: { result: 'rate-limited' } }],
    ['401 (our service token refused)', 'unavailable', { status: 401, body: {} }],
    ['403', 'unavailable', { status: 403, body: {} }],
    ['503 (could not check)', 'unavailable', { status: 503, body: { result: 'unavailable' } }],
    ['500', 'unavailable', { status: 500, body: {} }],
    ['200 with an unknown verdict', 'unavailable', { status: 200, body: { result: 'maybe' } }],
    ['200 ok but no session id', 'unavailable', { status: 200, body: { result: 'ok', user: { id: 'x', email: 'y' } } }],
    ['200 with an empty body', 'unavailable', { status: 200 }],
    ['a reply slower than the timeout', 'unavailable', { status: 200, body: OK_BODY, delayMs: 1500 }],
  ])('%s → %s', async (_label, kind, r) => {
    reply = r;
    const v = await mod.signInThroughBetterAuth('c@x.test', 'pw');
    expect(v.kind).toBe(kind);
    if (kind === 'ok') expect(v).toEqual({ kind: 'ok', authUserId: 'ba-1', email: 'c@x.test', authSessionId: 'sess-1' });
  });

  it('connection refused → unavailable (never no-match)', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((r) => dead.close(() => r()));
    const prev = process.env.MANDREL_MCP_URL;
    process.env.MANDREL_MCP_URL = `http://127.0.0.1:${port}`;
    try {
      expect((await mod.signInThroughBetterAuth('c@x.test', 'pw')).kind).toBe('unavailable');
    } finally {
      process.env.MANDREL_MCP_URL = prev;
    }
  });
});
