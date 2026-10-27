/**
 * Integration test — the one-time SET-PASSWORD link (sign-up S5).
 *
 * Boots the REAL HealthServer with OAuth enabled against the disposable, migrated CI DB, seeds
 * a login user the way provisioning does (seedFirstOAuthUser), mints links with the SHIPPED
 * mint function, and then drives everything a customer's browser does over real HTTP:
 *   GET  /sign-in/set-password               the page
 *   POST /sign-in/set-password/status        "is this link still good?" (read-only)
 *   POST <basePath>/reset-password           better-auth's own spend endpoint
 *   POST <basePath>/sign-in/email            proof the new password is the live one
 *
 * The properties the link exists for, each asserted at the HTTP surface:
 *   SINGLE USE  a spent token cannot be spent again, and the status check stops calling it good.
 *   EXPIRY      an expired token is refused by BOTH the status check and the spend, and the old
 *               password still works (an expired link changes nothing).
 *   SUPERSEDE   minting a new link kills the previous unspent one.
 *
 * Env is stubbed before the dynamic imports that read it at module load, and restored in
 * afterAll (vitest.setup env-leak guard).
 */
import { runScopedTmpPath } from './helpers/runScopedTmp.js';
import { requireScratchDb } from './helpers/scratchTestDb.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';
import { waitForReady } from './helpers/waitForReady.js';

const SCRATCH = requireScratchDb('SETPW');
let TEST_PORT: number;
let ISSUER: string;
// Same derivation as betterAuthConfig.ts (see oauthDcrCapAndSignup.integration.test.ts for why
// this reads process.env instead of importing the config before the env is stubbed).
const BASE_PATH = process.env.MANDREL_OAUTH_BASE_PATH ?? '/api/oauth';
const STATUS_RATE_MAX = 40;

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
  MANDREL_OAUTH_SECRET: 'setpw-test-secret-not-for-prod-0123456789abcdef',
  // The spend/sign-in calls below are many and fast; keep the limiter out of the verdict.
  MANDREL_OAUTH_RATELIMIT_ENABLED: 'false',
  // The status limiter: a known ceiling the rate test can cross on its own client key.
  MANDREL_SET_PASSWORD_STATUS_RATE_MAX: String(STATUS_RATE_MAX),
  MCP_AUTH_TOKEN: 'static-mcp-token-setpw-test',
  MCP_ALLOWED_HOSTS: `127.0.0.1:${TEST_PORT},localhost:${TEST_PORT},127.0.0.1,localhost`,
  MANDREL_AIDIS_MCP_PORT: String(TEST_PORT),
  AIDIS_PORT_REGISTRY: runScopedTmpPath('mandrel-setpw-port-registry.json'),
});

vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

type HealthServer = import('../server/healthServer.js').HealthServer;
type AuthInstance = import('../server/auth.js').AuthInstance;
type MintMod = typeof import('../scripts/mint-set-password-link.js');

const stubExecutor = vi.fn(async (toolName: string) => ({
  content: [{ type: 'text', text: `stub:${toolName}` }],
  structuredContent: { ok: true, tool: toolName },
}));

let health: HealthServer;
let baseUrl: string;
let auth: AuthInstance;
let mint: MintMod;
let pagePath: string;
let seed: typeof import('../scripts/seed-first-oauth-user.js').seedFirstOAuthUser;

const SEEDED_PW = 'Seeded-Passw0rd!generated';

function uniqEmail(tag: string): string {
  return `setpw-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function seedUser(tag: string): Promise<string> {
  const email = uniqEmail(tag);
  const r = await seed(auth, { email, name: email, password: SEEDED_PW });
  expect(r.action).toBe('created');
  return email;
}

function tokenOf(url: string): string {
  const m = /#token=([A-Za-z0-9_-]+)$/.exec(url);
  if (!m) throw new Error(`no fragment token in ${url}`);
  return m[1];
}

async function status(token: unknown): Promise<{ code: number; valid?: boolean }> {
  const r = await fetch(`${baseUrl}${pagePath}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const j = (await r.json().catch(() => ({}))) as { valid?: boolean };
  return { code: r.status, valid: j.valid };
}

async function spend(token: string, newPassword: string): Promise<{ code: number; errCode?: string }> {
  const r = await fetch(`${baseUrl}${BASE_PATH}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ token, newPassword }),
  });
  const j = (await r.json().catch(() => ({}))) as { code?: string };
  return { code: r.status, errCode: j.code };
}

/** Live sessions for a user, read through better-auth's own adapter (no cookie plumbing). */
async function liveSessions(email: string): Promise<number> {
  const ctx = await auth.$context;
  const u = await ctx.internalAdapter.findUserByEmail(email);
  if (!u) throw new Error(`no user ${email}`);
  const rows = await ctx.internalAdapter.listSessions(u.user.id);
  return rows.filter((r) => new Date(r.expiresAt).getTime() > Date.now()).length;
}

async function signIn(email: string, password: string): Promise<number> {
  const r = await fetch(`${baseUrl}${BASE_PATH}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
  return r.status;
}

beforeAll(async () => {
  TEST_PORT = await reserveEphemeralPort();
  ISSUER = `http://127.0.0.1:${TEST_PORT}`;
  for (const [key, value] of Object.entries(buildTestEnv())) vi.stubEnv(key, value);

  const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
  const { HealthServer } = await import('../server/healthServer.js');
  const authMod = await import('../server/auth.js');
  mint = await import('../scripts/mint-set-password-link.js');
  seed = (await import('../scripts/seed-first-oauth-user.js')).seedFirstOAuthUser;
  pagePath = (await import('../config/setPasswordConfig.js')).SET_PASSWORD_CONFIG.pagePath;

  const remoteMcp = new RemoteMcpTransport({
    executeMcpTool: stubExecutor as any,
    getServerStatus: async () => ({ version: 'test' }),
  });
  health = new HealthServer(stubExecutor as any, remoteMcp);
  const port = await health.start();
  const addr = health.address() as AddressInfo | null;
  baseUrl = `http://127.0.0.1:${addr?.port ?? port}`;
  await waitForReady(baseUrl);
  // The SAME singleton the mounted routes use, so the mint and the server share one auth.
  auth = authMod.getAuth();
}, 30000);

afterAll(async () => {
  try {
    if (health) await health.stop();
    const { closeAuth } = await import('../server/auth.js');
    await closeAuth();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('set-password link: the page and the link shape', () => {
  it('GET the page: 200 HTML, no-store, reads the token from the fragment', async () => {
    const r = await fetch(`${baseUrl}${pagePath}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const html = await r.text();
    expect(html).toContain('Set your Mandrel password');
    expect(html).toContain('window.location.hash');
    expect(html).toContain('Ask us for a new one');
  });

  it('the minted URL is <issuer><pagePath>#token=… (token in the fragment, never the query)', async () => {
    const email = await seedUser('shape');
    const r = await mint.mintSetPasswordLink(auth, { email });
    expect(r.url.startsWith(`${ISSUER}${pagePath}#token=`)).toBe(true);
    expect(r.url).not.toContain('?');
    expect(tokenOf(r.url)).toBe(r.token);
    // default TTL is the named config value (48 h)
    const hours = (r.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThanOrEqual(48);
  });

  it('no login user with that email → NoSuchLoginUser (measured no, not an error)', async () => {
    await expect(mint.mintSetPasswordLink(auth, { email: uniqEmail('ghost') })).rejects.toBeInstanceOf(mint.NoSuchLoginUser);
  });

  it('status refuses absent / malformed / unknown tokens without throwing', async () => {
    expect(await status(undefined)).toEqual({ code: 200, valid: false });
    expect(await status('short')).toEqual({ code: 200, valid: false });
    expect(await status('A'.repeat(43))).toEqual({ code: 200, valid: false });
  });
});

describe('set-password link: SINGLE USE', () => {
  it('spend once → new password signs in, old does not; the same token is then dead everywhere', async () => {
    const email = await seedUser('once');
    const { token } = await mint.mintSetPasswordLink(auth, { email });
    expect(await status(token)).toEqual({ code: 200, valid: true });
    // the status check is read-only: asking twice does not spend it
    expect(await status(token)).toEqual({ code: 200, valid: true });

    const first = await spend(token, 'Customer-Chosen-1');
    expect(first.code).toBe(200);
    expect(await signIn(email, 'Customer-Chosen-1')).toBe(200);
    expect(await signIn(email, SEEDED_PW)).toBe(401);

    // SECOND USE: refused, and the password stays the one set by the first use.
    const second = await spend(token, 'Attacker-Second-2');
    expect(second.code).toBe(400);
    expect(second.errCode).toBe('INVALID_TOKEN');
    expect(await signIn(email, 'Attacker-Second-2')).toBe(401);
    expect(await signIn(email, 'Customer-Chosen-1')).toBe(200);
    expect(await status(token)).toEqual({ code: 200, valid: false });
  });
});

describe('set-password link: EXPIRY', () => {
  it('a link minted 49 h ago (48 h TTL) is dead at status AND spend, and changes nothing', async () => {
    const email = await seedUser('expired');
    const { token, expiresAt } = await mint.mintSetPasswordLink(auth, { email, now: () => Date.now() - 49 * 3_600_000 });
    expect(expiresAt.getTime()).toBeLessThan(Date.now());
    expect(await status(token)).toEqual({ code: 200, valid: false });
    const r = await spend(token, 'Too-Late-Passw0rd');
    expect(r.code).toBe(400);
    expect(r.errCode).toBe('INVALID_TOKEN');
    expect(await signIn(email, 'Too-Late-Passw0rd')).toBe(401);
    expect(await signIn(email, SEEDED_PW)).toBe(200);
  });

  it('a link inside its TTL works (control for the expiry case)', async () => {
    const email = await seedUser('fresh');
    const { token } = await mint.mintSetPasswordLink(auth, { email, now: () => Date.now() - 47 * 3_600_000 });
    expect(await status(token)).toEqual({ code: 200, valid: true });
    expect((await spend(token, 'Just-In-Time-1')).code).toBe(200);
    expect(await signIn(email, 'Just-In-Time-1')).toBe(200);
  });
});

describe('set-password link: SUPERSEDE ("ask us for a new one")', () => {
  it('minting a new link kills the previous unspent one', async () => {
    const email = await seedUser('again');
    const a = await mint.mintSetPasswordLink(auth, { email });
    const b = await mint.mintSetPasswordLink(auth, { email });
    expect(b.superseded).toBe(1);
    expect(await status(a.token)).toEqual({ code: 200, valid: false });
    expect(await status(b.token)).toEqual({ code: 200, valid: true });
    expect((await spend(a.token, 'Old-Link-Passw0rd')).errCode).toBe('INVALID_TOKEN');
    expect((await spend(b.token, 'New-Link-Passw0rd')).code).toBe(200);
  });
});

describe('set-password page: hardening (Reviewer N3, N6)', () => {
  it('page and status carry a strict CSP whose script hash matches the served inline script, and X-Frame-Options DENY', async () => {
    const { createHash } = await import('node:crypto');
    const r = await fetch(`${baseUrl}${pagePath}`);
    const html = await r.text();
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    // the hash in the header must be the hash of the script the browser receives, or the page is dead
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    const h = createHash('sha256').update(scripts[0], 'utf8').digest('base64');
    expect(csp).toContain(`script-src 'sha256-${h}'`);
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(csp).toContain(`style-src 'sha256-${createHash('sha256').update(styles[0], 'utf8').digest('base64')}'`);
    const st = await fetch(`${baseUrl}${pagePath}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(st.headers.get('x-frame-options')).toBe('DENY');
    expect(st.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it(`status is rate-limited per client (${STATUS_RATE_MAX}/window): the next call is 429, another client is unaffected`, async () => {
    const call = (ip: string) =>
      fetch(`${baseUrl}${pagePath}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: '{}' });
    for (let i = 0; i < STATUS_RATE_MAX; i++) expect((await call('203.0.113.9')).status).toBe(200);
    const over = await call('203.0.113.9');
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
    expect((await call('203.0.113.10')).status).toBe(200);
  });

  it('spending a link ends the user\'s other sessions (revokeSessionsOnPasswordReset)', async () => {
    const email = await seedUser('revoke');
    expect(await signIn(email, SEEDED_PW)).toBe(200);
    expect(await signIn(email, SEEDED_PW)).toBe(200);
    expect(await liveSessions(email)).toBe(2);
    const { token } = await mint.mintSetPasswordLink(auth, { email });
    expect((await spend(token, 'After-Reset-Passw0rd')).code).toBe(200);
    expect(await liveSessions(email)).toBe(0);
  });
});
