/**
 * Per-user API tokens on the mcp-server — the VERIFY
 * half, driven against a REAL migrated database (migration 108) and the SHIPPED guards.
 *
 * WHAT THIS PROVES
 *   1. The digest rule matches the cross-service golden vector (the Command backend's twin
 *      test pins the same pair from its side).
 *   2. The shipped verifier, over a real pool: a live token resolves to its owner's
 *      username; a wrong, revoked, expired, or deactivated-owner token is 'no-match'; a
 *      bearer without the `mdl_` prefix never touches the database; a database error is
 *      'unavailable' (the third state), not 'no-match'. A token whose owner is not (or no
 *      longer) role=admin is 'no-match' (Reviewer F1): demoting the owner stops the token on
 *      the very next request, with the same 401 as a wrong token.
 *   3. last_used_at is written at most once per throttle window per token.
 *   4. Through the REAL HealthServer routes:
 *        /mcp/tools/*  (bridgeAuth, the loop's surface): live token → 200 and the tool
 *          executor receives actor = owner username, with connectionId / identified /
 *          projectBinding taken from the headers EXACTLY as for the static token; revoked /
 *          expired / wrong → 401 with byte-identical bodies.
 *        /api/v2/sessions (a static-only SERVICE mount): a live API token is REFUSED — a
 *          customer's loop token must not open the cross-project service surface.
 *   5. /mcp guards (dualBearerAuth and the opted-in static bearerAuth): live token → 200,
 *      revoked → 401, static token and OAuth still pass (regression), and a DB outage on an
 *      `mdl_` bearer is 503.
 *   6. The plaintext token never reaches the logger, console, stdout or stderr.
 *
 * POPULATION: every guard that accepts an API token (bridgeAuth, dualBearerAuth,
 * bearerAuth({apiTokens})) plus one representative of the guards that must NOT
 * (bearerAuth() on /api/v2/sessions — the other three service mounts call the identical
 * no-argument factory).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';

vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { Pool } from 'pg';
import { requireScratchDb } from './helpers/scratchTestDb.js';

const SCRATCH = requireScratchDb('APITOKEN');

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: SCRATCH.name,
  DATABASE_USER: SCRATCH.user,
  DATABASE_PASSWORD: SCRATCH.password,
  DATABASE_HOST: SCRATCH.host,
  DATABASE_PORT: SCRATCH.port,
  AIDIS_SKIP_BACKGROUND: 'true',
  AIDIS_SKIP_STDIO: 'true',
};

const STATIC_TOKEN = 'test-static-token-for-api-token-suite';

// Dedicated id prefix (`b0bf…`) so fixtures cannot collide with another suite's on the
// shared CI database.
const U_ALICE = 'b0bf0000-0000-4000-8000-b0bf000000a1';
const U_BOB = 'b0bf0000-0000-4000-8000-b0bf000000b2';
const U_GONE = 'b0bf0000-0000-4000-8000-b0bf000000c3'; // is_active = false

const mint = (): string => `mdl_${randomBytes(32).toString('base64url')}`;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const T_LIVE = mint();
const T_BOB = mint();
const T_REVOKED = mint();
const T_EXPIRED = mint();
const T_GONE_OWNER = mint();
const T_FUTURE = mint(); // expires in the future — still live
const T_WRONG = mint(); // never stored
const ALL_PLAINTEXTS = [T_LIVE, T_BOB, T_REVOKED, T_EXPIRED, T_GONE_OWNER, T_FUTURE, T_WRONG];

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let executorCalls: Array<{ tool: string; ctx: Record<string, unknown> }> = [];
let captured: string[] = [];
const restoreSpies: Array<() => void> = [];

type ApiTokenModule = typeof import('../services/apiTokenAuth.js');
type BearerModule = typeof import('../middleware/bearerAuth.js');
let tokens: ApiTokenModule;
let guards: BearerModule;

async function insertToken(
  userId: string,
  plaintext: string,
  extra: { revoked?: boolean; expiresSql?: string } = {}
): Promise<string> {
  const r = await pool.query(
    `INSERT INTO api_tokens (user_id, name, token_hash, display_prefix, revoked_at, expires_at)
     VALUES ($1, 'suite', $2, $3, ${extra.revoked ? 'now()' : 'NULL'}, ${extra.expiresSql ?? 'NULL'})
     RETURNING id`,
    [userId, sha(plaintext), plaintext.slice(0, 12)]
  );
  return r.rows[0].id;
}

const cleanup = async () => {
  await pool.query('DELETE FROM api_tokens WHERE user_id = ANY($1::uuid[])', [[U_ALICE, U_BOB, U_GONE]]);
  await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [[U_ALICE, U_BOB, U_GONE]]);
};

let liveTokenId: string;

beforeAll(async () => {
  for (const [k, v] of Object.entries(TEST_ENV)) vi.stubEnv(k, v);

  pool = new Pool({
    user: SCRATCH.user, host: SCRATCH.host, database: SCRATCH.name,
    password: SCRATCH.password, port: parseInt(SCRATCH.port, 10),
  });
  await cleanup();
  await pool.query(
    `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
     VALUES ($1,'tokalice','tokalice@x.test','$2b$04$notarealhashnotarealhashno','admin',true),
            ($2,'tokbob','tokbob@x.test','$2b$04$notarealhashnotarealhashno','admin',true),
            ($3,'tokgone','tokgone@x.test','$2b$04$notarealhashnotarealhashno','admin',false)`,
    [U_ALICE, U_BOB, U_GONE]
  );
  liveTokenId = await insertToken(U_ALICE, T_LIVE);
  await insertToken(U_BOB, T_BOB);
  await insertToken(U_ALICE, T_REVOKED, { revoked: true });
  await insertToken(U_ALICE, T_EXPIRED, { expiresSql: "now() - interval '1 minute'" });
  await insertToken(U_GONE, T_GONE_OWNER);
  await insertToken(U_ALICE, T_FUTURE, { expiresSql: "now() + interval '1 day'" });

  // Capture EVERY log surface before any product code runs a request.
  const { logger } = await import('../utils/logger.js');
  for (const level of ['error', 'warn', 'info', 'debug', 'trace'] as const) {
    const spy = vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      captured.push(args.map((a) => (a instanceof Error ? `${a.message}` : JSON.stringify(a) ?? String(a))).join(' '));
    });
    restoreSpies.push(() => spy.mockRestore());
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level];
    const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
      void orig;
    });
    restoreSpies.push(() => spy.mockRestore());
  }
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
    restoreSpies.push(() => spy.mockRestore());
  }

  tokens = await import('../services/apiTokenAuth.js');
  guards = await import('../middleware/bearerAuth.js');

  const { HealthServer } = await import('../server/healthServer.js');
  const health = new HealthServer(async (toolName: string, _args: unknown, ctx?: unknown) => {
    executorCalls.push({ tool: toolName, ctx: (ctx ?? {}) as Record<string, unknown> });
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const app = (health as unknown as { app: express.Application }).app;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 60000);

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const r of restoreSpies.reverse()) r();
    if (pool) {
      await cleanup();
      await pool.end();
    }
    const { db } = await import('../config/database.js');
    await db.end().catch(() => {});
  } finally {
    process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
    delete process.env.MCP_AUTH_TOKEN;
    vi.unstubAllEnvs();
  }
});

describe('the digest rule (cross-service contract)', () => {
  it('reproduces the golden vector the Command backend also pins', async () => {
    const { API_TOKEN_GOLDEN_VECTOR } = await import('../config/apiTokenConfig.js');
    expect(tokens.hashApiToken(API_TOKEN_GOLDEN_VECTOR.plaintext)).toBe(API_TOKEN_GOLDEN_VECTOR.sha256Hex);
  });
});

describe('createApiTokenVerifier — the shipped verifier over a real pool', () => {
  it('a live token resolves to its owner (username = the actor)', async () => {
    const r = await tokens.createApiTokenVerifier(pool)(T_LIVE);
    expect(r).toEqual({ kind: 'ok', principal: { tokenId: liveTokenId, userId: U_ALICE, principal: 'tokalice' } });
  });

  it('a token with a FUTURE expiry is still live', async () => {
    const r = await tokens.createApiTokenVerifier(pool)(T_FUTURE);
    expect(r.kind).toBe('ok');
  });

  it.each([
    ['wrong (never stored)', T_WRONG],
    ['revoked', T_REVOKED],
    ['expired', T_EXPIRED],
    ['owner deactivated', T_GONE_OWNER],
    ['empty after the prefix', 'mdl_'],
  ])('%s → no-match', async (_label, presented) => {
    expect(await tokens.createApiTokenVerifier(pool)(presented)).toEqual({ kind: 'no-match' });
  });

  it('an admin owner DEMOTED to role=user → no-match on the next check; re-promoted → ok again', async () => {
    const verify = tokens.createApiTokenVerifier(pool);
    expect((await verify(T_BOB)).kind).toBe('ok');
    await pool.query(`UPDATE admin_users SET role = 'user' WHERE id = $1`, [U_BOB]);
    try {
      expect(await verify(T_BOB)).toEqual({ kind: 'no-match' });
    } finally {
      await pool.query(`UPDATE admin_users SET role = 'admin' WHERE id = $1`, [U_BOB]);
    }
    expect((await verify(T_BOB)).kind).toBe('ok');
  });

  it('a bearer without the mdl_ prefix never reaches the database', async () => {
    const query = vi.fn(async () => {
      throw new Error('must not be called');
    });
    const r = await tokens.createApiTokenVerifier({ query } as never)(STATIC_TOKEN);
    expect(r).toEqual({ kind: 'no-match' });
    expect(query).not.toHaveBeenCalled();
  });

  it('a database error is UNAVAILABLE (the third state), never no-match', async () => {
    const query = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const r = await tokens.createApiTokenVerifier({ query } as never)(T_LIVE);
    expect(r).toEqual({ kind: 'unavailable' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('last_used_at is written at most once per window per token', async () => {
    const t = mint();
    const tid = await insertToken(U_BOB, t);
    const read = async () =>
      (await pool.query('SELECT last_used_at FROM api_tokens WHERE id = $1', [tid])).rows[0].last_used_at as Date | null;

    expect(await read()).toBeNull(); // the ZERO member: never used
    const verify = tokens.createApiTokenVerifier(pool);
    await verify(t);
    const first = await read();
    expect(first).not.toBeNull();

    await verify(t);
    await verify(t);
    expect((await read())?.getTime()).toBe(first?.getTime()); // inside the window: untouched

    await pool.query("UPDATE api_tokens SET last_used_at = now() - interval '2 minutes' WHERE id = $1", [tid]);
    const aged = await read();
    await verify(t);
    const refreshed = await read();
    expect(refreshed!.getTime()).toBeGreaterThan(aged!.getTime()); // outside the window: written
  });
});

describe('internal dashboard sign-in with OAuth OFF, real HealthServer', () => {
  // This suite's HealthServer runs with OAuth disabled, so mountOAuthRoutes mounted nothing and
  // the disabled twin answers. The route EXISTS either way: a 404 at the Command backend can
  // then only mean path drift / version skew, which it reports as could-not-check.
  const signIn = (bearer: string | null) =>
    fetch(`${baseUrl}/internal/dashboard-auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ email: 'tokalice@x.test', password: 'anything' }),
    });

  it('static service token → 200 {result:not-enabled}; an API token or no bearer → 401', async () => {
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
    const ok = await signIn(STATIC_TOKEN);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: 'not-enabled' });
    expect((await signIn(T_LIVE)).status).toBe(401);
    expect((await signIn(null)).status).toBe(401);
  });
});

describe('/mcp/tools/* (bridgeAuth — the Punch List loop surface), real HealthServer', () => {
  const callTool = (bearer: string | null, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp/tools/mandrel_ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ arguments: {} }),
    });

  const enforce = () => {
    delete process.env.MCP_BRIDGE_AUTH_ENABLED; // the production default: ENFORCE
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
  };

  it('a live API token → 200, attributed to the owner, scope headers passed through like the static path', async () => {
    enforce();
    const scope = { 'X-Connection-ID': 'loop-conn-1', 'X-Mandrel-Project': 'acme', 'X-Actor-ID': 'loop' };

    executorCalls = [];
    const viaStatic = await callTool(STATIC_TOKEN, scope);
    expect(viaStatic.status).toBe(200);
    const staticCtx = executorCalls[0].ctx;

    executorCalls = [];
    const viaToken = await callTool(T_LIVE, scope);
    expect(viaToken.status).toBe(200);
    const tokenCtx = executorCalls[0].ctx;

    // The verified principal wins over the declared X-Actor-ID (deriveActor's rule)…
    expect(staticCtx.actor).toBe('loop');
    expect(tokenCtx.actor).toBe('tokalice');
    // …and every OTHER identity field is exactly what the static path produced.
    const { actor: _a, ...staticRest } = staticCtx;
    const { actor: _b, ...tokenRest } = tokenCtx;
    expect(tokenRest).toEqual(staticRest);
    expect(tokenRest).toMatchObject({ connectionId: 'loop-conn-1', identified: true, projectBinding: 'acme' });
  });

  it('without X-Connection-ID the token request is UNIDENTIFIED, exactly like the static path', async () => {
    enforce();
    executorCalls = [];
    await callTool(STATIC_TOKEN);
    await callTool(T_LIVE);
    expect(executorCalls.map((c) => c.ctx.identified)).toEqual([false, false]);
  });

  it('revoked / expired / deactivated-owner / wrong → 401 with byte-identical bodies', async () => {
    enforce();
    executorCalls = [];
    const bodies: string[] = [];
    for (const t of [T_WRONG, T_REVOKED, T_EXPIRED, T_GONE_OWNER]) {
      const res = await callTool(t);
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(executorCalls).toHaveLength(0);
  });

  it('demoting the owner to role=user → the NEXT request is 401, body identical to a wrong token', async () => {
    enforce();
    expect((await callTool(T_BOB)).status).toBe(200);
    const wrongBody = await (await callTool(T_WRONG)).text();
    await pool.query(`UPDATE admin_users SET role = 'user' WHERE id = $1`, [U_BOB]);
    try {
      const res = await callTool(T_BOB);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(wrongBody);
    } finally {
      await pool.query(`UPDATE admin_users SET role = 'admin' WHERE id = $1`, [U_BOB]);
    }
  });

  it('REGRESSION: the static token and no-credential behave as before', async () => {
    enforce();
    expect((await callTool(STATIC_TOKEN)).status).toBe(200);
    expect((await callTool(null)).status).toBe(401);
  });
});

describe('a static-only SERVICE mount refuses an API token', () => {
  it('GET /api/v2/sessions with a live API token → 401 (static MCP_AUTH_TOKEN still 200-class)', async () => {
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
    const withToken = await fetch(`${baseUrl}/api/v2/sessions`, { headers: { Authorization: `Bearer ${T_LIVE}` } });
    expect(withToken.status).toBe(401);
    const withStatic = await fetch(`${baseUrl}/api/v2/sessions`, { headers: { Authorization: `Bearer ${STATIC_TOKEN}` } });
    expect(withStatic.status).not.toBe(401);
    expect(withStatic.status).not.toBe(503);
  });
});

describe('/mcp guards — dualBearerAuth and the opted-in static bearerAuth', () => {
  let guardServer: http.Server;
  let guardUrl: string;

  beforeAll(async () => {
    const app = express();
    const echo = (req: express.Request, res: express.Response) =>
      res.json({ sub: req.oauthSubject?.sub ?? null, via: req.oauthSubject?.via ?? null });
    app.post(
      '/dual',
      guards.dualBearerAuth({ verifyOAuth: async (t) => (t === 'oauth-ok' ? { sub: 'oauth-user', claims: {} } : null) }),
      echo
    );
    app.post('/static', guards.bearerAuth({ apiTokens: tokens.defaultApiTokenVerifier }), echo);
    app.post('/service', guards.bearerAuth(), echo);
    const failing = tokens.createApiTokenVerifier({
      query: async () => {
        throw new Error('db down');
      },
    } as never);
    app.post('/dual-down', guards.dualBearerAuth({ verifyApiToken: failing }), echo);
    app.post('/static-down', guards.bearerAuth({ apiTokens: failing }), echo);
    guardServer = http.createServer(app);
    await new Promise<void>((resolve) => guardServer.listen(0, resolve));
    const addr = guardServer.address();
    guardUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => guardServer.close(() => resolve()));
  });

  const hit = (path: string, bearer: string) =>
    fetch(`${guardUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } });

  it.each(['/dual', '/static'])('%s: live token → 200 as the owner; revoked/expired/wrong → 401', async (path) => {
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
    const ok = await hit(path, T_LIVE);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sub: 'tokalice', via: 'api_token' });
    for (const t of [T_REVOKED, T_EXPIRED, T_WRONG]) expect((await hit(path, t)).status).toBe(401);
  });

  it.each(['/dual', '/static', '/service'])('REGRESSION %s: the static token still passes, unattributed', async (path) => {
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
    const res = await hit(path, STATIC_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: null, via: null });
  });

  it('REGRESSION /dual: an OAuth token still passes as before', async () => {
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
    const res = await hit('/dual', 'oauth-ok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'oauth-user', via: null });
  });

  it('/service (no opt-in) refuses a live API token', async () => {
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
    expect((await hit('/service', T_LIVE)).status).toBe(401);
  });

  it.each(['/dual-down', '/static-down'])('%s: a DB outage on an mdl_ bearer is 503, not 401', async (path) => {
    process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
    expect((await hit(path, T_LIVE)).status).toBe(503);
  });
});

describe('the plaintext never reaches a log', () => {
  it('no captured logger / console / stdout / stderr line contains any plaintext token', () => {
    // Witness that capture worked at all: the 401 paths above DO log a warning.
    expect(captured.some((l) => /auth rejected/i.test(l))).toBe(true);
    for (const t of ALL_PLAINTEXTS) {
      expect(captured.filter((l) => l.includes(t))).toEqual([]);
      // The 43-char random body alone, too — a log that strips the prefix still leaks it.
      expect(captured.filter((l) => l.includes(t.slice(4)))).toEqual([]);
    }
  });
});
