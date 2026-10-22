/**
 * Integration test for seedFirstOAuthUser.
 *
 * Proves the first-OAuth-user provisioning against the disposable, fully-migrated CI DB
 * (the better-auth OAuth schema is migration 052, present after the standard migrate — the
 * same DB the CI gate provisions + exports as DATABASE_*). It builds a REAL better-auth instance
 * (createAuth) and asserts behavior through better-auth's OWN sign-in path — NOT by reading
 * rows — so the test is a genuine guard on hashing correctness AND the better-auth version:
 *
 *   (1) seed → auth.api.signInEmail SUCCEEDS (the hashing / version guard: a wrong hash,
 *       or an internal-adapter API drift on upgrade, makes sign-in fail RED — not silent).
 *   (2) idempotent: seeding twice → exactly ONE user row + ONE `credential` account row, and
 *       the ORIGINAL password still signs in (no silent rotation on re-run).
 *   (3) partial-state repair: a user with NO credential account → seed LINKS the credential
 *       → sign-in works.
 *   (4) seeding does NOT reopen registration — the sign-up endpoint still rejects (guard
 *       mutation-probe).
 *   (5) a wrong password is rejected.
 *
 * ENV DISCIPLINE (an earlier task / vitest.setup env-leak guard): every server/auth/config
 * module reads env at MODULE LOAD, and process.env is shared by the whole (single-fork)
 * suite. So env is stubbed with vi.stubEnv at the TOP of beforeAll (before the dynamic
 * imports that read it) and removed with vi.unstubAllEnvs in afterAll's finally — the file
 * leaves process.env exactly as it found it on every path.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { requireScratchDb } from './helpers/scratchTestDb.js';

// CI-PORTABLE DB SELECTION (configs-not-hardcoded), same precedence as
// betterAuthOAuth.integration.test.ts: an explicit SEED_DB_* override, then the ambient
// DATABASE_* the CI gate exports, then a last-resort local default.
// NO LAST-RESORT DEFAULT DB NAME. The three literals that used to sit
// here — 'ci_better_auth_ba1' / 'ci_role_better_auth_ba1' / a throwaway password — gave
// every lane on the box the SAME database the moment DATABASE_NAME was unset. That is
// the fixed-shared-global defect one axis over from this file's port literal, and the
// worse half: provision-test-db.sh destroys by NAME, and 58 of 67 copies of it under
// ~/projects carry no ownership-stamp logic (measured). requireScratchDb throws instead.
// Enforced by sharedScratchDbName.contract.test.ts.
const SCRATCH = requireScratchDb('SEED');
const SCRATCH_DB = SCRATCH.name;
const SCRATCH_USER = SCRATCH.user;
const SCRATCH_PASS = SCRATCH.password;
const SCRATCH_HOST = SCRATCH.host;
const SCRATCH_PORT = SCRATCH.port;

// A test issuer/secret; no HTTP server is booted (we call auth.api.* directly), so the
// port only needs to be a valid origin string.
const ISSUER = 'http://127.0.0.1:19098'; // fixed-port-ok: origin string only — this file boots no HTTP server (see above), so nothing binds it
const RESOURCE = `${ISSUER}/mcp`;

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: SCRATCH_DB,
  DATABASE_USER: SCRATCH_USER,
  DATABASE_PASSWORD: SCRATCH_PASS,
  DATABASE_HOST: SCRATCH_HOST,
  DATABASE_PORT: SCRATCH_PORT,
  AIDIS_SKIP_BACKGROUND: 'true',
  AIDIS_SKIP_STDIO: 'true',

  MANDREL_OAUTH_ENABLED: 'true',
  MANDREL_OAUTH_ISSUER: ISSUER,
  MANDREL_OAUTH_RESOURCE: RESOURCE,
  MANDREL_OAUTH_SECRET: 'seed-test-secret-not-for-prod-0123456789abcdef',
  // allowSignUp stays at its shipped default (false) so disableSignUp=true — the exact
  // surface this feature exists for. Test (4) mutation-probes that this stays closed.
};

// vitest.setup mocks crypto with ONLY randomUUID; restore real crypto for the genuine
// scrypt hash/verify path better-auth uses.
vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

import { Pool } from 'pg';

type AuthInstance = import('../server/auth.js').AuthInstance;
type SeedFn = typeof import('../scripts/seed-first-oauth-user.js').seedFirstOAuthUser;

let auth: AuthInstance;
let seedFirstOAuthUser: SeedFn;
let pool: Pool;       // for direct row assertions
let authPool: Pool;   // the pool the better-auth instance runs on (closed in afterAll)

/** Unique-per-run email so a shared CI DB never collides across tests or reruns. */
function uniqEmail(tag: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `seed-${tag}-${Date.now()}-${rand}@example.test`;
}

/** Attempt a sign-in through better-auth's own path. Returns true iff it succeeds. */
async function canSignIn(email: string, password: string): Promise<boolean> {
  try {
    const res: any = await auth.api.signInEmail({ body: { email, password } });
    // A successful sign-in returns a token (and/or user). A rejection throws, caught below.
    return Boolean(res && (res.token || res.user || res.redirect !== undefined));
  } catch {
    return false;
  }
}

async function countUsers(email: string): Promise<number> {
  const r = await pool.query('SELECT count(*)::int AS n FROM "user" WHERE lower("email") = lower($1)', [email]);
  return r.rows[0].n;
}

async function countCredentialAccounts(userId: string): Promise<number> {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM "account" WHERE "userId" = $1 AND "providerId" = $2',
    [userId, 'credential'],
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  // MUST precede the dynamic imports below (betterAuthConfig reads env at module load).
  for (const [k, v] of Object.entries(TEST_ENV)) vi.stubEnv(k, v);

  const authMod = await import('../server/auth.js');
  const seedMod = await import('../scripts/seed-first-oauth-user.js');
  seedFirstOAuthUser = seedMod.seedFirstOAuthUser;

  pool = new Pool({
    user: SCRATCH_USER, host: SCRATCH_HOST, database: SCRATCH_DB,
    password: SCRATCH_PASS, port: parseInt(SCRATCH_PORT, 10),
  });
  // A dedicated pool for the auth instance so its teardown is independent of the assertion pool.
  authPool = new Pool({
    user: SCRATCH_USER, host: SCRATCH_HOST, database: SCRATCH_DB,
    password: SCRATCH_PASS, port: parseInt(SCRATCH_PORT, 10),
  });
  // createAuth's first arg defaults to BETTER_AUTH_CONFIG (which read the stubbed env at
  // module load); pass the pool explicitly.
  auth = authMod.createAuth(undefined, authPool);
}, 30000);

afterAll(async () => {
  try {
    if (pool) await pool.end().catch(() => {});
    if (authPool) await authPool.end().catch(() => {});
    const { closeAuth } = await import('../server/auth.js');
    await closeAuth();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('seedFirstOAuthUser', () => {
  it('(1) seeds a user whose password signs in via better-auth (hashing + version guard)', async () => {
    const email = uniqEmail('signin');
    const password = 'Seed-Passw0rd!one';
    const res = await seedFirstOAuthUser(auth, { email, name: 'Signin User', password });
    expect(res.action).toBe('created');
    expect(res.userId).toBeTruthy();
    expect(await canSignIn(email, password)).toBe(true);
  });

  it('(2) is idempotent: seeding twice yields ONE user + ONE credential account, original password still signs in', async () => {
    const email = uniqEmail('idem');
    const password = 'Seed-Passw0rd!two';
    const first = await seedFirstOAuthUser(auth, { email, name: 'Idem User', password });
    expect(first.action).toBe('created');

    // Re-run with a DIFFERENT password but NO rotate → must be a no-op (never silently rotate).
    const second = await seedFirstOAuthUser(auth, { email, name: 'Idem User', password: 'Different-Passw0rd!zz' });
    expect(second.action).toBe('exists');
    expect(second.userId).toBe(first.userId);

    expect(await countUsers(email)).toBe(1);
    expect(await countCredentialAccounts(first.userId)).toBe(1);
    // The ORIGINAL password still works; the re-run's different password must NOT.
    expect(await canSignIn(email, password)).toBe(true);
    expect(await canSignIn(email, 'Different-Passw0rd!zz')).toBe(false);
  });

  it('(2b) rotate is the ONLY path that overwrites a working credential', async () => {
    const email = uniqEmail('rotate');
    const original = 'Seed-Passw0rd!orig';
    const rotated = 'Seed-Passw0rd!newx';
    const created = await seedFirstOAuthUser(auth, { email, name: 'Rotate User', password: original });
    expect(created.action).toBe('created');

    const rot = await seedFirstOAuthUser(auth, { email, name: 'Rotate User', password: rotated, rotate: true });
    expect(rot.action).toBe('rotated');
    expect(rot.userId).toBe(created.userId);

    // Still exactly one credential account; the NEW password signs in, the old does not.
    expect(await countCredentialAccounts(created.userId)).toBe(1);
    expect(await canSignIn(email, rotated)).toBe(true);
    expect(await canSignIn(email, original)).toBe(false);
  });

  it('(3) repairs a partial state: user with no credential account → seed links it → sign-in works', async () => {
    const email = uniqEmail('repair');
    const password = 'Seed-Passw0rd!three';
    // Create the user WITHOUT a credential account (partial state) via the internal adapter.
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email, name: 'Repair User', emailVerified: true });
    expect(await countCredentialAccounts(user.id)).toBe(0);
    expect(await canSignIn(email, password)).toBe(false); // no credential yet

    const res = await seedFirstOAuthUser(auth, { email, name: 'Repair User', password });
    expect(res.action).toBe('repaired');
    expect(res.userId).toBe(user.id);
    expect(await countUsers(email)).toBe(1);
    expect(await countCredentialAccounts(user.id)).toBe(1);
    expect(await canSignIn(email, password)).toBe(true);
  });

  it('(4) seeding does NOT reopen registration — the sign-up endpoint still rejects (mutation-probe the guard)', async () => {
    const seedEmail = uniqEmail('nosignup-seed');
    await seedFirstOAuthUser(auth, { email: seedEmail, name: 'Seed', password: 'Seed-Passw0rd!four' });

    // Open self-registration must remain closed (disableSignUp): signUpEmail is rejected.
    const signupEmail = uniqEmail('nosignup-attempt');
    await expect(
      auth.api.signUpEmail({ body: { email: signupEmail, password: 'Attempt-Passw0rd!zz', name: 'Intruder' } }),
    ).rejects.toBeTruthy();
    // And no account was created by the rejected attempt.
    expect(await countUsers(signupEmail)).toBe(0);
  });

  it('(5) a wrong password is rejected', async () => {
    const email = uniqEmail('wrongpw');
    const password = 'Seed-Passw0rd!five';
    await seedFirstOAuthUser(auth, { email, name: 'Wrong PW User', password });
    expect(await canSignIn(email, password)).toBe(true);
    expect(await canSignIn(email, 'not-the-password!!')).toBe(false);
  });
});
