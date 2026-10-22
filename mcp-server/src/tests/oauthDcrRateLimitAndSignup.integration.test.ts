/**
 * BA-3 ARMING integration test — DCR REGISTER RATE-LIMIT + SIGN-UP POSITIVE
 * CONTROL. Boots the REAL HealthServer with OAuth ENABLED against the
 * disposable, migrated CI DB and proves, without a browser:
 *
 *   1. SIGN-UP TOGGLE WORKS THE OTHER WAY (positive control): with MANDREL_OAUTH_ALLOW_SIGNUP=
 *      true, POST <basePath>/sign-up/email SUCCEEDS. Paired with the default-restricted case in
 *      oauthDcrCapAndSignup.integration.test.ts, this proves the config toggle governs sign-up
 *      (the restriction is not a permanently-broken endpoint — tests-are-the-rock).
 *   2. DCR RATE-LIMIT: with the register rate-limit set to a small max, a burst of registrations
 *      trips 429 — proving the config-driven per-endpoint limit is actually applied (the cap is
 *      set high here so the RATE-LIMIT, not the cap, is what rejects).
 *
 * Env stubbed in beforeAll / restored in afterAll (env-leak guard, vitest.setup.ts).
 */
import { runScopedTmpPath } from './helpers/runScopedTmp.js';
import { requireScratchDb } from './helpers/scratchTestDb.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';

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
// OS-ASSIGNED AT beforeAll, NEVER A LITERAL. Same class as the 19097
// literal in betterAuthOAuth.integration.test.ts, which was REPRODUCED colliding across
// two simultaneous runs. Fixed here in the same change because a rule written in one
// place and violated in another is not a rule; enforced by
// hardcodedTestPorts.contract.test.ts.
let TEST_PORT: number;
const TEST_TOKEN = 'static-mcp-token-ba3-rl-test';
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
let RESOURCE: string;
const RATE_MAX = 3;

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
  MANDREL_OAUTH_SECRET: 'ba3-rl-test-secret-not-for-prod-0123456789abcd',
  // Positive control: open sign-up ENABLED here.
  MANDREL_OAUTH_ALLOW_SIGNUP: 'true',
  // Rate-limit ON with a small window/max; cap high so the rate-limit is the rejecter.
  MANDREL_OAUTH_RATELIMIT_ENABLED: 'true',
  MANDREL_OAUTH_DCR_RATE_WINDOW_SEC: '60',
  MANDREL_OAUTH_DCR_RATE_MAX: String(RATE_MAX),
  MANDREL_OAUTH_DCR_CLIENT_CAP: '1000',

  MCP_AUTH_TOKEN: TEST_TOKEN,
  MCP_ALLOWED_HOSTS: `127.0.0.1:${TEST_PORT},localhost:${TEST_PORT},127.0.0.1,localhost`,
  MANDREL_AIDIS_MCP_PORT: String(TEST_PORT),
  AIDIS_PORT_REGISTRY: runScopedTmpPath('mandrel-ba3-rl-port-registry.json'),
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

beforeAll(async () => {
  TEST_PORT = await reserveEphemeralPort();
  ISSUER = `http://127.0.0.1:${TEST_PORT}`;
  RESOURCE = `${ISSUER}/mcp`;
  for (const [key, value] of Object.entries(buildTestEnv())) vi.stubEnv(key, value);

  const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
  const { HealthServer } = await import('../server/healthServer.js');

  authPool = new Pool({
    user: SCRATCH_USER, host: process.env.DATABASE_HOST, database: SCRATCH_DB,
    password: SCRATCH_PASS, port: parseInt(process.env.DATABASE_PORT!, 10),
  });
  await authPool.query('DELETE FROM "oauthClient"');

  const remoteMcp = new RemoteMcpTransport({
    executeMcpTool: stubExecutor as any,
    getServerStatus: async () => ({ version: 'test' }),
  });
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
    vi.unstubAllEnvs();
  }
});

describe('(1) SIGN-UP positive control — enabled toggle allows sign-up', () => {
  it('POST <basePath>/sign-up/email succeeds when MANDREL_OAUTH_ALLOW_SIGNUP=true', async () => {
    const email = `provisioned-${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}${BASE_PATH}/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Provisioned User', email, password: 'a-strong-password-123' }),
    });
    expect(res.status).toBe(200);
    const { rows } = await authPool.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [email]);
    expect(rows[0].n).toBe(1);
  });
});

describe('(2) DCR register RATE-LIMIT', () => {
  it(`a burst past max=${RATE_MAX}/window trips 429 (config-driven per-endpoint rate-limit)`, async () => {
    const meta = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    const endpoint = meta.registration_endpoint as string;

    const statuses: number[] = [];
    // Fire a burst clearly larger than max (max+4). With the default global limiter (100/10s)
    // NONE of these would 429 — so a 429 here proves OUR register-specific max is what limits.
    for (let i = 0; i < RATE_MAX + 4; i++) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: `RL client ${i}`,
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      statuses.push(res.status);
    }

    const rateLimited = statuses.filter((s) => s === 429).length;
    const succeeded = statuses.filter((s) => s === 200 || s === 201).length;
    expect(rateLimited, `expected ≥1 rate-limited (429) in a burst; got statuses ${statuses.join(',')}`).toBeGreaterThanOrEqual(1);
    // Sanity: the endpoint genuinely registers when under the limit (not a blanket reject).
    expect(succeeded, `expected some registrations to succeed under the limit; got ${statuses.join(',')}`).toBeGreaterThanOrEqual(1);
  });
});
