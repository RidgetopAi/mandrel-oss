/**
 * BA-1 integration test: better-auth OAuth 2.1 authorization-server on the mcp-server.
 *
 * Boots the real HealthServer Express app with OAuth ENABLED + a real RemoteMcpTransport
 * + a real better-auth instance against the disposable, fully-migrated CI DB (the same
 * DB the CI gate provisions + migrates and exports as DATABASE_* — the better-auth OAuth schema
 * is migration 052, so it is present after the standard migrate), and proves the five
 * required behaviors WITHOUT a browser:
 *
 *   (a) REGRESSION / BACKWARD-COMPAT GATE: no token → 401; valid MCP_AUTH_TOKEN → /mcp
 *       authorizes exactly as today (the existing static-bearer path is byte-for-byte intact).
 *   (b) METADATA: /.well-known/oauth-authorization-server, /.well-known/openid-configuration,
 *       and /.well-known/oauth-protected-resource return the correct fields.
 *   (c) DCR: dynamic client registration succeeds.
 *   (d) OAUTH ON /mcp: mint a real access token via better-auth in-test (no browser),
 *       present it on /mcp → authorized; wrong audience/issuer → 401.
 *   (e) (covered by requireRemoteMcpEnv.contract.test.ts — boot fails-closed without
 *       MCP_AUTH_TOKEN; asserted here too at the guard level for completeness.)
 *
 * Token minting bypasses the browser by signing a JWT with the SAME JWKS key better-auth
 * generated (read from the scratch DB jwks table), so verifyAccessToken's local JWKS
 * verification accepts it — exercising the genuine /mcp dual-path guard end-to-end.
 */

import { runScopedTmpPath } from './helpers/runScopedTmp.js';
import { requireScratchDb } from './helpers/scratchTestDb.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';

// ---- Env MUST be set before importing any server/auth/config module (module-eval reads it)
// — and this file imports every such module DYNAMICALLY (inside beforeAll), so "before the
// import" is satisfied by stubbing in beforeAll. It is NOT set at module scope, because
// process.env is shared by EVERY test file in the run (vitest.config pins the whole suite to
// ONE fork: fileParallelism:false + singleFork:true), so a module-scope write leaks into every
// file that runs afterwards and makes OTHER files lie. That is exactly what happened:
// MANDREL_OAUTH_ENABLED='true' leaked out of this file into bridgeAuth.test.ts,
// whose "flag ON but NO credential source configured → 503 fail-closed" case reads it via
// betterAuthConfig's module-load `BETTER_AUTH_CONFIG.enabled`; the leaked flag made a
// credential source look configured, so the guard returned 401 instead of the fail-closed 503
// and Stage 1 went RED — aborting every fleet deploy. The leak fired even when this file's
// beforeAll THREW (module eval happens regardless), and it landed FAR from its cause.
// See the env-leak guard in vitest.setup.ts, which now fails the CULPRIT file.
//
// CI-PORTABLE DB SELECTION (configs-not-hardcoded): point the test at the DB the CI gate
// provisions + migrates and exports as DATABASE_* (the better-auth OAuth schema is
// migration 052, so it's present after the standard migrate). Precedence:
//   1. BA1_DB_* explicit override (a manual run can pin a specific scratch DB)
//   2. the ambient DATABASE_* exported by the CI gate / provision-test-db.sh
//   3. …and NOTHING ELSE. There is no third fallback: requireScratchDb throws when
//      neither is set. See helpers/scratchTestDb.ts for why a default name is more
//      dangerous than a missing one.
// NO LAST-RESORT DEFAULT DB NAME. The three literals that used to sit
// here — 'ci_better_auth_ba1' / 'ci_role_better_auth_ba1' / a throwaway password — gave
// every lane on the box the SAME database the moment DATABASE_NAME was unset. That is
// the fixed-shared-global defect one axis over from this file's port literal, and the
// worse half: provision-test-db.sh destroys by NAME, and 58 of 67 copies of it under
// ~/projects carry no ownership-stamp logic (measured). requireScratchDb throws instead.
// Enforced by sharedScratchDbName.contract.test.ts.
const SCRATCH = requireScratchDb('BA1');
const SCRATCH_DB = SCRATCH.name;
const SCRATCH_USER = SCRATCH.user;
const SCRATCH_PASS = SCRATCH.password;
// OS-ASSIGNED AT beforeAll, NEVER A LITERAL.
// This was `const TEST_PORT = 19097` — a literal that was correct about the only thing it
// claimed (it sits outside the fleet's reserved blocks) and still broke, because a port is
// exclusive to a HOST, not to a range. Two simultaneous runs of THIS FILE — the ordinary
// parallel-worktree case, measured with 10 sibling worktrees carrying the identical
// constant — race for it, and the loser dies with `EADDRINUSE :::19097` inside beforeAll,
// i.e. as a hook timeout with 11 tests SKIPPED rather than as an assertion. Reproduced
// 2026-08-26 before this change: laneA 11 passed / laneB EADDRINUSE.
// A bigger or per-worktree literal would not have fixed it either: two runs inside one
// worktree share it again. The OS is the only allocator that knows what is actually free.
// See helpers/ephemeralPort.ts for why the port must be known BEFORE the server is
// constructed (RemoteMcpTransport freezes allowedHosts in its ctor).
// Enforced by hardcodedTestPorts.contract.test.ts, so the literal cannot come back.
let TEST_PORT: number;
const TEST_TOKEN = 'static-mcp-token-ba1-test';
// ISSUER/RESOURCE/ISSUER_IDENTIFIER all embed the real port, so none of them can be a
// module-level constant any more — they are built in beforeAll once TEST_PORT exists.
let ISSUER: string;
const BASE_PATH = '/api/oauth';
// GROUND TRUTH (better-auth 1.6.20): the OAuth issuer identifier the AS advertises +
// mints as the token `iss` is baseURL + basePath, NOT the bare origin.
let ISSUER_IDENTIFIER: string;
let RESOURCE: string;

/**
 * The env this file's server/auth stack needs. Applied with vi.stubEnv at the TOP of
 * beforeAll (before the dynamic imports that module-eval-read them) and removed by
 * vi.unstubAllEnvs in afterAll, so the file leaves process.env exactly as it found it.
 * afterAll runs even when beforeAll or a test THROWS, so the restore is guaranteed on
 * every path — which a module-scope write could never offer.
 */
const buildTestEnv = (): Record<string, string> => ({
  DATABASE_NAME: SCRATCH_DB,
  DATABASE_USER: SCRATCH_USER,
  DATABASE_PASSWORD: SCRATCH_PASS,
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  DATABASE_PORT: process.env.DATABASE_PORT || '5432',
  AIDIS_SKIP_BACKGROUND: 'true',
  AIDIS_SKIP_STDIO: 'true',

  MANDREL_OAUTH_ENABLED: 'true',
  MANDREL_OAUTH_ISSUER: ISSUER,
  MANDREL_OAUTH_RESOURCE: RESOURCE,
  MANDREL_OAUTH_SECRET: 'ba1-test-secret-not-for-prod-0123456789abcdef',
  MCP_AUTH_TOKEN: TEST_TOKEN,
  MCP_ALLOWED_HOSTS: `127.0.0.1:${TEST_PORT},localhost:${TEST_PORT},127.0.0.1,localhost`,
  MANDREL_AIDIS_MCP_PORT: String(TEST_PORT),
  AIDIS_PORT_REGISTRY: runScopedTmpPath('mandrel-ba1-port-registry.json'),
});

// vitest.setup mocks crypto with ONLY randomUUID; restore real crypto for the genuine
// JWT/JWKS + constant-time-compare paths.
vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

import { Pool } from 'pg';
import { SignJWT, importJWK, exportJWK, generateKeyPair } from 'jose';

type HealthServer = import('../server/healthServer.js').HealthServer;

const stubExecutor = vi.fn(async (toolName: string) => ({
  content: [{ type: 'text', text: `stub:${toolName}` }],
  structuredContent: { ok: true, tool: toolName },
}));

const deps = {
  executeMcpTool: stubExecutor as any,
  getServerStatus: async () => ({ version: 'test' }),
};

let health: HealthServer;
let baseUrl: string;
let authPool: Pool;

/**
 * Mint a real RS256/EdDSA access token signed with a key whose PUBLIC half is published
 * at the AS's JWKS endpoint, so verifyAccessToken's local JWKS check accepts it. We
 * insert our own keypair into the scratch `jwks` table (the same place the jwt() plugin
 * reads from) so the published JWKS contains our public key. This bypasses the browser
 * while exercising the GENUINE local-JWKS verification path of the /mcp guard.
 */
async function mintAccessToken(opts: { issuer: string; audience: string; sub: string }): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const pubJwk = await exportJWK(publicKey);
  const privJwk = await exportJWK(privateKey);
  const kid = 'ba1-test-key';
  pubJwk.kid = kid;
  pubJwk.alg = 'EdDSA';
  pubJwk.use = 'sig';

  // Publish: insert a jwks row whose publicKey is the JWK better-auth's JWKS endpoint serves.
  // better-auth stores publicKey as a JSON JWK string and privateKey (we don't need priv here).
  await authPool.query(
    `INSERT INTO "jwks" ("id","publicKey","privateKey","createdAt") VALUES ($1,$2,$3, now())
     ON CONFLICT ("id") DO UPDATE SET "publicKey"=EXCLUDED."publicKey"`,
    [kid, JSON.stringify(pubJwk), JSON.stringify(privJwk)]
  );

  const key = await importJWK(privJwk, 'EdDSA');
  return await new SignJWT({ sub: opts.sub, scope: 'openid profile email' })
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(opts.sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

beforeAll(async () => {
  // The OS hands us a port nobody else holds; everything that embeds it is derived from
  // that single value, so there is exactly one place a port comes from in this file.
  TEST_PORT = await reserveEphemeralPort();
  ISSUER = `http://127.0.0.1:${TEST_PORT}`; // baseURL / public origin
  ISSUER_IDENTIFIER = `${ISSUER}${BASE_PATH}`;
  RESOURCE = `${ISSUER}/mcp`;
  // MUST precede the dynamic imports below: betterAuthConfig/bearerAuth read these at
  // MODULE LOAD, and that load happens on the first `await import(...)` in this hook.
  for (const [key, value] of Object.entries(buildTestEnv())) vi.stubEnv(key, value);

  const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
  const { HealthServer } = await import('../server/healthServer.js');

  authPool = new Pool({
    user: SCRATCH_USER, host: process.env.DATABASE_HOST, database: SCRATCH_DB,
    password: SCRATCH_PASS, port: parseInt(process.env.DATABASE_PORT!, 10),
  });

  const remoteMcp = new RemoteMcpTransport(deps);
  health = new HealthServer(stubExecutor as any, remoteMcp);
  const port = await health.start();
  const addr = health.address() as AddressInfo | null;
  baseUrl = `http://127.0.0.1:${addr?.port ?? port}`;
}, 30000);

afterAll(async () => {
  try {
    if (health) await health.stop();
    if (authPool) await authPool.end().catch(() => {});
    const { closeAuth } = await import('../server/auth.js');
    await closeAuth();
  } finally {
    // ALWAYS restore, even if a teardown step above throws — otherwise we would have just
    // MOVED the leak instead of fixing it. Runs last: the teardown above still reads env.
    vi.unstubAllEnvs();
  }
});

// ---------------------------------------------------------------------------------------
describe('(a) REGRESSION — static bearer path is byte-for-byte intact (BACKWARD-COMPAT GATE)', () => {
  it('no token → 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error).toBeDefined();
    // The discovery hint is the documented behavior change for the 401 path.
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('valid MCP_AUTH_TOKEN → /mcp authorizes (full MCP handshake works exactly as today)', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'ba1-static', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('mandrel-mcp-server');
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toContain('mandrel_ping');
    await client.close();
  });

  it('wrong static token AND not a valid OAuth token → 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer totally-wrong-not-a-jwt',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------
describe('(b) METADATA — discovery docs return correct fields', () => {
  it('/.well-known/oauth-authorization-server (RFC 8414)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.issuer).toBe(ISSUER_IDENTIFIER);
    expect(typeof doc.authorization_endpoint).toBe('string');
    expect(typeof doc.token_endpoint).toBe('string');
    expect(typeof doc.registration_endpoint).toBe('string'); // DCR advertised
    expect(typeof doc.jwks_uri).toBe('string');
    expect(doc.code_challenge_methods_supported).toContain('S256'); // PKCE S256
  });

  it('/.well-known/openid-configuration', async () => {
    const res = await fetch(`${baseUrl}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.issuer).toBe(ISSUER_IDENTIFIER);
    expect(typeof doc.authorization_endpoint).toBe('string');
    expect(typeof doc.token_endpoint).toBe('string');
    expect(typeof doc.jwks_uri).toBe('string');
    expect(doc.code_challenge_methods_supported).toContain('S256');
  });

  it('/.well-known/oauth-protected-resource (RFC 9728) names the exact resource + AS', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.resource).toBe(RESOURCE);
    expect(doc.authorization_servers).toContain(ISSUER_IDENTIFIER);
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(['openid', 'profile', 'email']));
  });
});

// ---------------------------------------------------------------------------------------
describe('(c) DCR — dynamic client registration succeeds', () => {
  it('POST <registration_endpoint> registers a client and returns a client_id', async () => {
    const meta = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    const res = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'BA1 Test Connector',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect([200, 201]).toContain(res.status);
    const reg = await res.json();
    expect(reg.client_id).toBeTruthy();
    expect(reg.redirect_uris).toContain('https://claude.ai/api/mcp/auth_callback');
  });
});

// ---------------------------------------------------------------------------------------
describe('(d) OAUTH on /mcp — a minted access token authorizes; wrong aud/iss does not', () => {
  it('valid OAuth access token (correct issuer + audience) → /mcp authorizes', async () => {
    const token = await mintAccessToken({ issuer: ISSUER_IDENTIFIER, audience: RESOURCE, sub: 'user-ba1' });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'ba1-oauth', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport); // initialize over /mcp with an OAuth JWT
    expect(client.getServerVersion()?.name).toBe('mandrel-mcp-server');
    const result: any = await client.callTool({ name: 'mandrel_ping', arguments: {} });
    expect(JSON.stringify(result)).toContain('mandrel_ping');
    await client.close();
  });

  it('wrong AUDIENCE → 401 (RFC 8707 audience binding enforced)', async () => {
    const token = await mintAccessToken({ issuer: ISSUER_IDENTIFIER, audience: 'https://evil.example/mcp', sub: 'user-ba1' });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('wrong ISSUER → 401', async () => {
    const token = await mintAccessToken({ issuer: 'https://evil.example', audience: RESOURCE, sub: 'user-ba1' });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------
describe('(e) FAIL-CLOSED — static path cannot authorize when MCP_AUTH_TOKEN is unset', () => {
  it('with MCP_AUTH_TOKEN unset, the OLD static token no longer authorizes (only OAuth can)', async () => {
    const saved = process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_AUTH_TOKEN;
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TEST_TOKEN}`, // the (now-unconfigured) static token
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      // The static secret is unconfigured → that path can't match; the token isn't a valid
      // OAuth JWT either → 401. (Boot-level fail-closed is asserted in
      // requireRemoteMcpEnv.contract.test.ts.)
      expect(res.status).toBe(401);
    } finally {
      process.env.MCP_AUTH_TOKEN = saved;
    }
  });
});
