/**
 * BA-3 ARMING integration test — SIGN-UP RESTRICTION + PER-TENANT DCR CAP
 *. Boots the REAL HealthServer with OAuth ENABLED against the disposable,
 * migrated CI DB and proves, without a browser:
 *
 *   1. SIGN-UP IS RESTRICTED BY DEFAULT: with MANDREL_OAUTH_ALLOW_SIGNUP unset (default false),
 *      POST <basePath>/sign-up/email is REJECTED (better-auth disableSignUp → 400). The consent
 *      flow's sign-IN path is untouched (this test only asserts sign-up is closed).
 *   2. DCR UNDER THE CAP SUCCEEDS: with the table below the per-tenant cap, register works.
 *   3. DCR PAST THE CAP IS REJECTED: once the "oauthClient" table holds `cap` rows, the next
 *      register returns 429 with our RFC-7591 `invalid_client_metadata` error — proving OUR cap
 *      middleware (not the rate-limit) is what rejected (rate-limit is DISABLED in this file).
 *
 * Env is stubbed in beforeAll (before the dynamic imports that module-eval-read it) and
 * restored in afterAll (vi.unstubAllEnvs) so the file leaves process.env exactly as found —
 * per the env-leak guard (vitest.setup.ts).
 */
import { runScopedTmpPath } from './helpers/runScopedTmp.js';
import { requireScratchDb } from './helpers/scratchTestDb.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';
import { waitForReady } from './helpers/waitForReady.js';

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
// OS-assigned at beforeAll, never a literal (an earlier task folded in the same
// defence-in-depth remoteMcpTransport.integration.test.ts already uses). 19098 was a
// hardcoded literal shared with seedFirstOAuthUser.integration.test.ts and sat OUTSIDE
// the ranges reservedTestPorts.contract.test.ts knows about, so nothing would have
// caught the collision. See helpers/ephemeralPort.ts for why the port must be known
// BEFORE the server is constructed (allowedHosts is frozen in the transport ctor).
// NOTE: this is hardening, NOT the fix for bb98a3d4 — that failure was Postgres
// connection-slot exhaustion, and nothing was ever bound on 19098 (measured).
let TEST_PORT: number;
const TEST_TOKEN = 'static-mcp-token-ba3-cap-test';
let ISSUER: string;
// Derive the sign-up basePath the SAME way betterAuthConfig.ts does — read
// MANDREL_OAUTH_BASE_PATH with the identical '/api/oauth' default (see
// envStr('MANDREL_OAUTH_BASE_PATH', '/api/oauth') there) — so this can never
// drift from the server's mount again (a hardcoded '/api/auth' literal drifted
// from that default in an earlier task and 404'd these tests). We read process.env
// rather than importing BETTER_AUTH_CONFIG because a static import would eval that
// module (issuer/enabled/etc.) BEFORE beforeAll stubs the env, poisoning the cached
// config the server later dynamically imports. TEST_ENV deliberately does not set
// MANDREL_OAUTH_BASE_PATH, so this resolves to the exact default the server boots with.
const BASE_PATH = process.env.MANDREL_OAUTH_BASE_PATH ?? '/api/oauth';
const CLIENT_CAP = 2;

// Built in beforeAll, once the OS has assigned TEST_PORT (the issuer/resource/allowed-hosts
// all embed the real port, so none of them can be a module-level constant any more).
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
  MANDREL_OAUTH_RESOURCE: `${ISSUER}/mcp`,
  MANDREL_OAUTH_SECRET: 'ba3-cap-test-secret-not-for-prod-0123456789ab',
  // MANDREL_OAUTH_ALLOW_SIGNUP deliberately UNSET → default restricted (sign-up closed).
  // Isolate the CAP as the rejecter: disable better-auth's register rate-limit here.
  MANDREL_OAUTH_RATELIMIT_ENABLED: 'false',
  MANDREL_OAUTH_DCR_CLIENT_CAP: String(CLIENT_CAP),

  MCP_AUTH_TOKEN: TEST_TOKEN,
  MCP_ALLOWED_HOSTS: `127.0.0.1:${TEST_PORT},localhost:${TEST_PORT},127.0.0.1,localhost`,
  MANDREL_AIDIS_MCP_PORT: String(TEST_PORT),
  AIDIS_PORT_REGISTRY: runScopedTmpPath('mandrel-ba3-cap-port-registry.json'),
});

vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

import { Pool } from 'pg';

type HealthServer = import('../server/healthServer.js').HealthServer;

const stubExecutor = vi.fn(async (toolName: string) => ({
  content: [{ type: 'text', text: `stub:${toolName}` }],
  structuredContent: { ok: true, tool: toolName },
}));

let health: HealthServer;
let baseUrl: string;
let authPool: Pool;

async function registrationEndpoint(): Promise<string> {
  const meta = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
  return meta.registration_endpoint as string;
}

async function registerClient(endpoint: string, name: string): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
}

beforeAll(async () => {
  TEST_PORT = await reserveEphemeralPort();
  ISSUER = `http://127.0.0.1:${TEST_PORT}`;
  for (const [key, value] of Object.entries(buildTestEnv())) vi.stubEnv(key, value);

  const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
  const { HealthServer } = await import('../server/healthServer.js');

  authPool = new Pool({
    user: SCRATCH_USER, host: process.env.DATABASE_HOST, database: SCRATCH_DB,
    password: SCRATCH_PASS, port: parseInt(process.env.DATABASE_PORT!, 10),
  });
  // Start from a clean client table so the cap arithmetic is deterministic (disposable CI DB).
  await authPool.query('DELETE FROM "oauthClient"');

  const remoteMcp = new RemoteMcpTransport({
    executeMcpTool: stubExecutor as any,
    getServerStatus: async () => ({ version: 'test' }),
  });
  health = new HealthServer(stubExecutor as any, remoteMcp);
  const port = await health.start();
  const addr = health.address() as AddressInfo | null;
  baseUrl = `http://127.0.0.1:${addr?.port ?? port}`;

  // READINESS GATE (defence-in-depth). `listen()` resolving means the
  // socket is accepting, not that the server can serve — /readyz additionally reports DB
  // pool health. Asserting it here means a DB-side problem surfaces as an explicit
  // "server never became ready" failure in THIS hook, instead of leaking downstream as a
  // mystery 503 on an unrelated assertion (which is exactly how bb98a3d4 presented).
  // NOT the fix for that bug — the root cause was host connection-slot exhaustion.
  await waitForReady(baseUrl);
}, 30000);

afterAll(async () => {
  try {
    if (health) await health.stop();
    if (authPool) await authPool.end().catch(() => {});
    const { closeAuth } = await import('../server/auth.js');
    await closeAuth();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('(1) SIGN-UP restricted by default', () => {
  it('POST <basePath>/sign-up/email is rejected when MANDREL_OAUTH_ALLOW_SIGNUP is unset (default)', async () => {
    const intruderEmail = `intruder-${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}${BASE_PATH}/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Intruder',
        email: intruderEmail,
        password: 'a-strong-password-123',
      }),
    });
    // disableSignUp → better-auth returns 400 BAD_REQUEST (open self-registration is closed).
    expect(res.status).toBe(400);
    // And THIS account was not created (scope to our email — the shared CI DB may hold users
    // created by other test files, so a global count would be a flaky/false assertion).
    const { rows } = await authPool.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [intruderEmail]);
    expect(rows[0].n).toBe(0);
  });
});

describe('(2)+(3) PER-TENANT DCR cap', () => {
  it(`registers up to the cap (${CLIENT_CAP}) then rejects the next with 429 invalid_client_metadata`, async () => {
    const endpoint = await registrationEndpoint();

    // Under the cap: the first `cap` registrations succeed.
    for (let i = 0; i < CLIENT_CAP; i++) {
      const res = await registerClient(endpoint, `Under-cap client ${i}`);
      expect([200, 201], `registration #${i + 1} should succeed (under cap)`).toContain(res.status);
    }

    // At the cap: the next registration is rejected by OUR cap middleware.
    const over = await registerClient(endpoint, 'Over-cap client');
    expect(over.status).toBe(429);
    const body = await over.json();
    expect(body.error).toBe('invalid_client_metadata');

    // The table did not grow past the cap.
    const { rows } = await authPool.query('SELECT count(*)::int AS n FROM "oauthClient"');
    expect(rows[0].n).toBe(CLIENT_CAP);
  });
});
