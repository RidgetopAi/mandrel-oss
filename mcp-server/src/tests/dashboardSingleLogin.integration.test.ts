/**
 * Integration test — ONE LOGIN, the mcp-server half (option A).
 *
 * Boots the REAL HealthServer with OAuth enabled against the disposable, migrated DB
 * (migrations 052 better-auth, 108 api_tokens, 109 the link) and drives, over real HTTP:
 *
 *   PROVISIONED INSTANCE   the seed CLI (spawned exactly as an operator runs it)
 *                          creates the customer's better-auth login AND their dashboard row:
 *                          linked, role admin, no dashboard password.
 *   WELCOME LINK           a set-password link is minted and spent through better-auth's own
 *                          reset endpoint; the internal dashboard sign-in then accepts the NEW
 *                          password and refuses the seeded one.
 *   TOKEN → /mcp           an API token owned by that dashboard row authenticates
 *                          /mcp/tools/* and the tool runs as the customer's better-auth id —
 *                          the same actor their OAuth session is.
 *   SESSION BINDING        a dashboard session row bound to the better-auth session is deleted
 *                          by the database when better-auth ends that session (spending a
 *                          set-password link revokes every session).
 *   EXISTING ADMIN         a legacy admin with a dashboard password and a token keeps both;
 *                          seeding their email LINKS the existing row (no second row), the
 *                          token keeps working, and only its attribution moves to the
 *                          better-auth id.
 *   AUTHZ                  the internal sign-in accepts ONLY the static service token: none,
 *                          a wrong one, a live `mdl_` API token, an OAuth-shaped JWT → 401.
 *                          Per-email attempt limit → 429.
 *   DB INVARIANT           a dashboard row is never left without a credential: better-auth
 *                          cannot delete the user behind a password-less owner.
 *
 * The Command backend half (login route, session validation, 403/429/503 mapping) is
 * mandrel-command/backend/src/__tests__/dashboardSingleLogin.db.test.ts.
 */
import { requireScratchDb } from './helpers/scratchTestDb.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';
import { waitForReady } from './helpers/waitForReady.js';

vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';

const SCRATCH = requireScratchDb('ONELOGIN');
let TEST_PORT: number;
let ISSUER: string;
const BASE_PATH = process.env.MANDREL_OAUTH_BASE_PATH ?? '/api/oauth';
const STATIC_TOKEN = 'static-mcp-token-onelogin-test';
const OAUTH_SECRET = 'onelogin-test-secret-not-for-prod-0123456789abcdef';
const RATE_MAX = 6;

const buildTestEnv = (): Record<string, string> => ({
  DATABASE_NAME: SCRATCH.name,
  DATABASE_USER: SCRATCH.user,
  DATABASE_PASSWORD: SCRATCH.password,
  DATABASE_HOST: SCRATCH.host,
  DATABASE_PORT: SCRATCH.port,
  AIDIS_SKIP_BACKGROUND: 'true',
  AIDIS_SKIP_STDIO: 'true',
  MANDREL_OAUTH_ENABLED: 'true',
  MANDREL_OAUTH_ISSUER: ISSUER,
  MANDREL_OAUTH_RESOURCE: `${ISSUER}/mcp`,
  MANDREL_OAUTH_SECRET: OAUTH_SECRET,
  MANDREL_OAUTH_RATELIMIT_ENABLED: 'false',
  MANDREL_DASHBOARD_SIGNIN_RATE_MAX: String(RATE_MAX),
  MCP_AUTH_TOKEN: STATIC_TOKEN,
  MCP_ALLOWED_HOSTS: `127.0.0.1:${TEST_PORT},localhost:${TEST_PORT},127.0.0.1,localhost`,
  MANDREL_AIDIS_MCP_PORT: String(TEST_PORT),
});

type HealthServer = import('../server/healthServer.js').HealthServer;
type AuthInstance = import('../server/auth.js').AuthInstance;

const executorCalls: Array<{ tool: string; ctx: Record<string, unknown> }> = [];
const stubExecutor = vi.fn(async (toolName: string, _args: unknown, ctx?: unknown) => {
  executorCalls.push({ tool: toolName, ctx: (ctx ?? {}) as Record<string, unknown> });
  return { content: [{ type: 'text', text: `stub:${toolName}` }], structuredContent: { ok: true } };
});

let health: HealthServer;
let baseUrl: string;
let auth: AuthInstance;
let pool: Pool;
let signInPath: string;
let mint: typeof import('../scripts/mint-set-password-link.js');
let seed: typeof import('../scripts/seed-first-oauth-user.js').seedFirstOAuthUser;
let linkOwner: typeof import('../services/dashboardOwner.js').linkDashboardOwner;

const SEEDED_PW = 'Seeded-Passw0rd!generated';
const emails: string[] = [];
function uniqEmail(tag: string): string {
  const e = `onelogin-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  emails.push(e);
  return e;
}
const mintToken = (): string => `mdl_${randomBytes(32).toString('base64url')}`;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

async function internalSignIn(
  email: unknown,
  password: unknown,
  bearer: string | null = STATIC_TOKEN,
  clientIp?: string,
): Promise<{ code: number; body: Record<string, any> }> {
  const r = await fetch(`${baseUrl}${signInPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ email, password, ...(clientIp ? { clientIp } : {}) }),
  });
  return { code: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

async function spend(token: string, newPassword: string): Promise<number> {
  const r = await fetch(`${baseUrl}${BASE_PATH}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ token, newPassword }),
  });
  return r.status;
}

async function callTool(bearer: string): Promise<number> {
  const r = await fetch(`${baseUrl}/mcp/tools/mandrel_ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, 'X-Actor-ID': 'loop' },
    body: JSON.stringify({ arguments: {} }),
  });
  return r.status;
}

async function insertApiToken(adminUserId: string): Promise<string> {
  const plaintext = mintToken();
  await pool.query(
    `INSERT INTO api_tokens (user_id, name, token_hash, display_prefix) VALUES ($1, 'loop', $2, $3)`,
    [adminUserId, sha(plaintext), plaintext.slice(0, 12)],
  );
  return plaintext;
}

/** The provisioning entry point, spawned the way an operator runs it in the container. */
function runSeedCli(email: string, password: string, extraEnv: Record<string, string> = {}): { status: number | null; out: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = path.resolve(here, '..', '..');
  const r = spawnSync(path.join(pkg, 'node_modules', '.bin', 'tsx'), ['src/scripts/seed-first-oauth-user.ts'], {
    cwd: pkg,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'test',
      ...buildTestEnv(),
      MANDREL_OAUTH_SEED_EMAIL: email,
      MANDREL_OAUTH_SEED_PASSWORD: password,
      ...extraEnv,
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

beforeAll(async () => {
  TEST_PORT = await reserveEphemeralPort();
  ISSUER = `http://127.0.0.1:${TEST_PORT}`;
  for (const [key, value] of Object.entries(buildTestEnv())) vi.stubEnv(key, value);
  vi.stubEnv('MCP_BRIDGE_AUTH_ENABLED', 'true'); // the production posture: the bridge ENFORCES

  pool = new Pool({
    user: SCRATCH.user, host: SCRATCH.host, database: SCRATCH.name,
    password: SCRATCH.password, port: parseInt(SCRATCH.port, 10),
  });

  const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
  const { HealthServer } = await import('../server/healthServer.js');
  const authMod = await import('../server/auth.js');
  mint = await import('../scripts/mint-set-password-link.js');
  seed = (await import('../scripts/seed-first-oauth-user.js')).seedFirstOAuthUser;
  linkOwner = (await import('../services/dashboardOwner.js')).linkDashboardOwner;
  signInPath = (await import('../config/dashboardAuthConfig.js')).DASHBOARD_AUTH_CONFIG.signInPath;

  const remoteMcp = new RemoteMcpTransport({
    executeMcpTool: stubExecutor as any,
    getServerStatus: async () => ({ version: 'test' }),
  });
  health = new HealthServer(stubExecutor as any, remoteMcp);
  const port = await health.start();
  const addr = health.address() as AddressInfo | null;
  baseUrl = `http://127.0.0.1:${addr?.port ?? port}`;
  await waitForReady(baseUrl);
  auth = authMod.getAuth();
}, 60000);

afterAll(async () => {
  try {
    if (pool) {
      for (const e of emails) {
        await pool.query('DELETE FROM admin_users WHERE lower(email) = lower($1)', [e]).catch(() => {});
        await pool.query('DELETE FROM "user" WHERE lower(email) = lower($1)', [e]).catch(() => {});
      }
      await pool.end();
    }
    if (health) await health.stop();
    const { closeAuth } = await import('../server/auth.js');
    await closeAuth();
  } finally {
    vi.unstubAllEnvs();
  }
});

/**
 * N5: with MORE THAN ONE admin row, the seed no longer infers the owner's row
 * from email. These suites exercise the single-admin inference rules, so while they run every
 * admin row that already existed (a shared scratch DB accumulates them) is parked as role
 * 'user' and restored afterwards. Rows a test inserts itself are untouched.
 */
function parkOtherAdmins(): void {
  let parked: string[] = [];
  beforeEach(async () => {
    parked = (await pool.query(`UPDATE admin_users SET role = 'user' WHERE role = 'admin' RETURNING id`)).rows.map((r) => r.id as string);
  });
  afterEach(async () => {
    if (parked.length) await pool.query(`UPDATE admin_users SET role = 'admin' WHERE id = ANY($1::uuid[])`, [parked]);
  });
}

describe('a freshly provisioned customer: welcome link → dashboard sign-in → token → /mcp', () => {
  it('the whole chain, through the shipped entry points', async () => {
    const email = uniqEmail('fresh');

    // 1. Provisioning (step 6b): the seed CLI creates the login AND the dashboard row.
    const cli = runSeedCli(email, SEEDED_PW);
    expect(cli.out).toContain('SEED_RESULT=created');
    expect(cli.out).toContain('DASHBOARD_OWNER=created');
    expect(cli.status).toBe(0);

    const ba = (await pool.query('SELECT id FROM "user" WHERE lower(email) = lower($1)', [email])).rows[0];
    const row = (await pool.query('SELECT * FROM admin_users WHERE auth_user_id = $1', [ba.id])).rows[0];
    expect(row).toMatchObject({ email, role: 'admin', is_active: true, password_hash: null, must_change_password: false });
    expect(row.username).toMatch(/^[A-Za-z0-9._-]{3,32}$/);

    // 2. The welcome link: mint, then spend through better-auth's own reset endpoint.
    const { token } = await mint.mintSetPasswordLink(auth, { email });
    expect(await spend(token, 'Customer-Chosen-1')).toBe(200);

    // 3. The dashboard's sign-in check: the NEW password is the live one.
    const ok = await internalSignIn(email, 'Customer-Chosen-1');
    expect(ok.code).toBe(200);
    expect(ok.body.result).toBe('ok');
    expect(ok.body.user).toEqual({ id: ba.id, email });
    const sess = (await pool.query('SELECT "userId" FROM "session" WHERE id = $1', [ok.body.session.id])).rows[0];
    expect(sess?.userId).toBe(ba.id);
    // the better-auth session TOKEN never leaves the mcp-server
    expect(JSON.stringify(ok.body)).not.toMatch(/token/i);

    const stale = await internalSignIn(email, SEEDED_PW);
    expect(stale).toEqual({ code: 200, body: { result: 'no-match' } });

    // 4. A token owned by that dashboard row authenticates the loop's surface, as the customer.
    const apiToken = await insertApiToken(row.id);
    executorCalls.length = 0;
    expect(await callTool(apiToken)).toBe(200);
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].ctx.actor).toBe(ba.id);
  });

  it('a re-run of provisioning changes nothing (an operator demotion stands)', async () => {
    const email = uniqEmail('rerun');
    expect(runSeedCli(email, SEEDED_PW).out).toContain('DASHBOARD_OWNER=created');
    await pool.query("UPDATE admin_users SET role = 'user' WHERE lower(email) = lower($1)", [email]);
    const again = runSeedCli(email, SEEDED_PW);
    expect(again.out).toContain('SEED_RESULT=exists');
    expect(again.out).toContain('DASHBOARD_OWNER=exists');
    const rows = (await pool.query('SELECT role FROM admin_users WHERE lower(email) = lower($1)', [email])).rows;
    expect(rows).toEqual([{ role: 'user' }]);
  });
});

describe('session binding: better-auth ending a session ends the dashboard session', () => {
  it('spending a set-password link deletes the bound dashboard session row (FK cascade)', async () => {
    const email = uniqEmail('bind');
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    const owner = await linkOwner(pool, { authUserId: seeded.userId, email });
    const signedIn = await internalSignIn(email, SEEDED_PW);
    expect(signedIn.body.result).toBe('ok');

    // what the Command backend stores for a better-auth sign-in (services/auth.ts createSession)
    await pool.query(
      `INSERT INTO auth_tokens (user_id, token_id, expires_at, auth_session_id)
       VALUES ($1, gen_random_uuid(), now() + interval '1 day', $2)`,
      [owner.adminUserId, signedIn.body.session.id],
    );
    const before = await pool.query('SELECT count(*)::int AS n FROM auth_tokens WHERE auth_session_id = $1', [signedIn.body.session.id]);
    expect(before.rows[0].n).toBe(1);

    const { token } = await mint.mintSetPasswordLink(auth, { email });
    expect(await spend(token, 'Customer-Chosen-2')).toBe(200);

    const after = await pool.query('SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1', [owner.adminUserId]);
    expect(after.rows[0].n).toBe(0);
  });
});

describe('an instance that already has a dashboard admin (prod, a self-hoster)', () => {
  parkOtherAdmins();
  it('keeps its password login and its token; linking moves only the attribution', async () => {
    const email = uniqEmail('legacy');
    const legacy = (await pool.query(
      `INSERT INTO admin_users (username, email, password_hash, role, is_active)
       VALUES ($1, $2, '$2b$04$notarealhashnotarealhashno', 'admin', true) RETURNING id, username`,
      [`legacy-${Date.now() % 1e9}`, email],
    )).rows[0];
    const apiToken = await insertApiToken(legacy.id);

    executorCalls.length = 0;
    expect(await callTool(apiToken)).toBe(200);
    expect(executorCalls[0].ctx.actor).toBe(legacy.username); // unlinked: as before 109

    // the operator gives this admin the better-auth login (the provisioning seed path)
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    const owner = await linkOwner(pool, { authUserId: seeded.userId, email });
    expect(owner).toEqual({ action: 'linked-existing', adminUserId: legacy.id, username: legacy.username });

    const row = (await pool.query('SELECT password_hash, auth_user_id FROM admin_users WHERE id = $1', [legacy.id])).rows[0];
    expect(row.password_hash).toBe('$2b$04$notarealhashnotarealhashno'); // the old login survives
    expect(row.auth_user_id).toBe(seeded.userId);
    expect((await pool.query('SELECT count(*)::int AS n FROM admin_users WHERE lower(email) = lower($1)', [email])).rows[0].n).toBe(1);

    executorCalls.length = 0;
    expect(await callTool(apiToken)).toBe(200);
    expect(executorCalls[0].ctx.actor).toBe(seeded.userId);
  });

  it('a row with that email already linked to ANOTHER login is a conflict, not a re-link', async () => {
    const email = uniqEmail('conflict');
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    await linkOwner(pool, { authUserId: seeded.userId, email });
    const other = await seed(auth, { email: uniqEmail('other'), name: 'o', password: SEEDED_PW });
    await expect(linkOwner(pool, { authUserId: other.userId, email })).rejects.toThrow(/different sign-in/);
  });
});

describe('the internal sign-in accepts ONLY the static service credential', () => {
  it('none / wrong / a live API token / a JWT-shaped bearer → 401, and no verdict is given', async () => {
    const email = uniqEmail('authz');
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    const owner = await linkOwner(pool, { authUserId: seeded.userId, email });
    const liveApiToken = await insertApiToken(owner.adminUserId);
    expect(await callTool(liveApiToken)).toBe(200); // the token IS live…

    for (const bearer of [null, 'wrong-static', liveApiToken, 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln']) {
      const r = await internalSignIn(email, SEEDED_PW, bearer);
      expect(r.code).toBe(401); // …and still cannot run a password check
      expect(r.body.result).toBeUndefined();
    }
  });

  it('wrong password, unknown email and a malformed email are one answer: no-match', async () => {
    const email = uniqEmail('nomatch');
    await seed(auth, { email, name: email, password: SEEDED_PW });
    expect(await internalSignIn(email, 'not-it')).toEqual({ code: 200, body: { result: 'no-match' } });
    expect(await internalSignIn(uniqEmail('ghost'), SEEDED_PW)).toEqual({ code: 200, body: { result: 'no-match' } });
    expect(await internalSignIn('not-an-email', SEEDED_PW)).toEqual({ code: 200, body: { result: 'no-match' } });
  });

  it('a body that is not {email, password} strings → 400', async () => {
    for (const [e, p] of [[undefined, 'x'], ['a@b.test', undefined], [1, 'x'], ['', 'x'], ['a@b.test', '']]) {
      expect((await internalSignIn(e, p)).code).toBe(400);
    }
  });

  it('FAILED attempts per (email, client) → 429 for that client only; the owner elsewhere still signs in', async () => {
    const email = uniqEmail('rate');
    await seed(auth, { email, name: email, password: SEEDED_PW });
    const guesser = '198.51.100.7';
    const owner = '203.0.113.20';
    for (let i = 0; i < RATE_MAX; i += 1) expect((await internalSignIn(email, 'wrong', STATIC_TOKEN, guesser)).code).toBe(200);
    // the guesser is cut off — even with the RIGHT password, once over
    expect(await internalSignIn(email, SEEDED_PW, STATIC_TOKEN, guesser)).toEqual({ code: 429, body: { result: 'rate-limited' } });
    // …and the owner, from their own address, is NOT locked out (Reviewer N1)
    expect((await internalSignIn(email, SEEDED_PW, STATIC_TOKEN, owner)).body.result).toBe('ok');
  });

  it('successful sign-ins never count toward the limit', async () => {
    const email = uniqEmail('rate-ok');
    await seed(auth, { email, name: email, password: SEEDED_PW });
    for (let i = 0; i < RATE_MAX + 2; i += 1) {
      expect((await internalSignIn(email, SEEDED_PW, STATIC_TOKEN, '203.0.113.21')).body.result).toBe('ok');
    }
  });
});

describe('the database never leaves a dashboard row without a credential (migration 109)', () => {
  parkOtherAdmins();
  it('better-auth cannot delete the user behind a password-less owner', async () => {
    const email = uniqEmail('check');
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    await linkOwner(pool, { authUserId: seeded.userId, email });
    await expect(pool.query('DELETE FROM "user" WHERE id = $1', [seeded.userId])).rejects.toThrow(/admin_users_has_credential_check/);
  });

  it('a linked row that kept its dashboard password just loses the link', async () => {
    const email = uniqEmail('unlink');
    const legacy = (await pool.query(
      `INSERT INTO admin_users (username, email, password_hash, role, is_active)
       VALUES ($1, $2, '$2b$04$notarealhashnotarealhashno', 'admin', true) RETURNING id`,
      [`unlink-${Date.now() % 1e9}`, email],
    )).rows[0];
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    await linkOwner(pool, { authUserId: seeded.userId, email });
    await pool.query('DELETE FROM "user" WHERE id = $1', [seeded.userId]);
    const row = (await pool.query('SELECT auth_user_id, password_hash FROM admin_users WHERE id = $1', [legacy.id])).rows[0];
    expect(row).toEqual({ auth_user_id: null, password_hash: '$2b$04$notarealhashnotarealhashno' });
  });
});

describe('F1 (Reviewer): an open-sign-up account is never made the instance owner', () => {
  // Reviewer's repro, as a test. On an instance with MANDREL_OAUTH_ALLOW_SIGNUP=true an attacker
  // self-registers the owner's address FIRST (better-auth's own public sign-up → emailVerified
  // false). The operator then provisions the owner. Before the fix the seed said `exists`, kept
  // the ATTACKER's password, and linked that account as the role=admin owner.
  it('the provisioning seed REFUSES the link (nonzero exit), and no dashboard row exists', async () => {
    const { createAuth } = await import('../server/auth.js');
    const { BETTER_AUTH_CONFIG } = await import('../config/betterAuthConfig.js');
    const openSignUp = createAuth({ ...BETTER_AUTH_CONFIG, allowSignUp: true }, pool);
    const victim = uniqEmail('takeover');
    const su = (await openSignUp.api.signUpEmail({ body: { email: victim, password: 'Attacker-Passw0rd!', name: 'x' } })) as any;
    expect(su.user.emailVerified).toBe(false);

    const cli = runSeedCli(victim, 'Operator-Generated-Passw0rd!');
    expect(cli.out).toContain('SEED_RESULT=exists');
    expect(cli.out).toContain('DASHBOARD_OWNER=refused reason=email-not-verified');
    expect(cli.status).toBe(1);
    const rows = await pool.query('SELECT 1 FROM admin_users WHERE auth_user_id = $1 OR lower(email) = lower($2)', [su.user.id, victim]);
    expect(rows.rowCount).toBe(0);
    // and the attacker's password reaches no dashboard: no linked row means the Command backend 403s
  });
});

describe('F2 (Reviewer): an email match alone links only an unambiguous admin row', () => {
  parkOtherAdmins();
  const insertRow = async (username: string, email: string, role: string) =>
    (await pool.query(
      `INSERT INTO admin_users (username, email, password_hash, role, is_active)
       VALUES ($1, $2, '$2b$04$notarealhashnotarealhashno', $3, true) RETURNING id`,
      [username, email, role],
    )).rows[0].id as string;
  const tag = () => `${Date.now() % 1e9}${Math.random().toString(36).slice(2, 5)}`;

  it('a single NON-admin row carrying the email (anyone can set their own) → refused, row untouched', async () => {
    const email = uniqEmail('f2-user');
    const rowId = await insertRow(`f2u-${tag()}`, email, 'user');
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    const { DashboardLinkRefused } = await import('../services/dashboardOwner.js');
    const err = await linkOwner(pool, { authUserId: seeded.userId, email }).catch((e) => e);
    expect(err).toBeInstanceOf(DashboardLinkRefused);
    expect(err.reason).toBe('not-admin');
    expect((await pool.query('SELECT auth_user_id FROM admin_users WHERE id = $1', [rowId])).rows[0].auth_user_id).toBeNull();
    // the operator can still name that row explicitly
    const named = await linkOwner(pool, { authUserId: seeded.userId, email, linkUsername: (await pool.query('SELECT username FROM admin_users WHERE id = $1', [rowId])).rows[0].username });
    expect(named).toMatchObject({ action: 'linked-existing', adminUserId: rowId });
  });

  it('two rows carrying the email (case variants) → refused as ambiguous, nothing linked', async () => {
    const email = uniqEmail('f2-amb');
    const a = await insertRow(`f2a-${tag()}`, email, 'admin');
    const b = await insertRow(`f2b-${tag()}`, email.toUpperCase(), 'user');
    emails.push(email.toUpperCase());
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    const err = await linkOwner(pool, { authUserId: seeded.userId, email }).catch((e) => e);
    expect(err.reason).toBe('ambiguous-email');
    const linked = await pool.query('SELECT count(*)::int AS n FROM admin_users WHERE id = ANY($1::uuid[]) AND auth_user_id IS NOT NULL', [[a, b]]);
    expect(linked.rows[0].n).toBe(0);
  });

  it('the seed CLI exits nonzero on the refusal and honours MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME', async () => {
    const email = uniqEmail('f2-cli');
    const username = `f2c-${tag()}`;
    await insertRow(username, email, 'user');
    const refused = runSeedCli(email, SEEDED_PW);
    expect(refused.out).toContain('DASHBOARD_OWNER=refused reason=not-admin');
    expect(refused.status).toBe(1);
    const named = runSeedCli(email, SEEDED_PW, { MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME: username });
    expect(named.out).toContain('DASHBOARD_OWNER=linked-existing');
    expect(named.status).toBe(0);
  });
});

describe('F3 (Reviewer): rollback 109 works after a created owner has signed in', () => {
  it('the shipped rollback SQL runs, removes the owner and their sessions, keeps the legacy admin', async () => {
    const fs = await import('node:fs');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.resolve(here, '..', '..', 'database', 'migrations', 'rollback', '109_dashboard_better_auth_login_ROLLBACK.sql');
    // The file carries its own BEGIN/COMMIT; run its statements inside OUR transaction instead,
    // so the schema change is rolled back afterwards (Postgres DDL is transactional).
    const sql = fs.readFileSync(file, 'utf8').replace(/^\s*(BEGIN|COMMIT);\s*$/gim, '');
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);

    const email = uniqEmail('rollback');
    const seeded = await seed(auth, { email, name: email, password: SEEDED_PW });
    const owner = await linkOwner(pool, { authUserId: seeded.userId, email });
    expect(owner.action).toBe('created');
    const legacyEmail = uniqEmail('rollback-legacy');
    const legacy = (await pool.query(
      `INSERT INTO admin_users (username, email, password_hash, role, is_active)
       VALUES ($1, $2, '$2b$04$notarealhashnotarealhashno', 'admin', true) RETURNING id`,
      [`rbl-${Date.now() % 1e9}`, legacyEmail],
    )).rows[0].id as string;
    const signedIn = await internalSignIn(email, SEEDED_PW);
    // what the Command backend stores when that owner signs into the dashboard
    await pool.query(
      `INSERT INTO auth_tokens (user_id, token_id, expires_at, auth_session_id)
       VALUES ($1, gen_random_uuid(), now() + interval '1 day', $2)`,
      [owner.adminUserId, signedIn.body.session.id],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql); // threw auth_tokens_user_id_fkey before the fix
      const gone = await client.query('SELECT count(*)::int AS n FROM admin_users WHERE id = $1', [owner.adminUserId]);
      expect(gone.rows[0].n).toBe(0);
      const col = await client.query(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'admin_users' AND column_name = 'auth_user_id'",
      );
      expect(col.rows[0].n).toBe(0);
      const legacyLeft = await client.query('SELECT count(*)::int AS n FROM admin_users WHERE id = $1', [legacy]);
      expect(legacyLeft.rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // the schema is back
    const back = await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'admin_users' AND column_name = 'auth_user_id'");
    expect(back.rows[0].n).toBe(1);
  });
});
