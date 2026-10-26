/**
 * seed-first-oauth-user.ts — provision a tenant's FIRST better-auth login user
 * server-side, so a freshly OAuth-enabled tenant has a credential to sign in with
 * BEFORE the customer connects (the auditor spec
 * an earlier context).
 *
 * WHY THIS EXISTS
 *   With open sign-up CLOSED by default (betterAuthConfig `allowSignUp=false` →
 *   `emailAndPassword.disableSignUp=true`), a tenant's OAuth consent flow has no user to
 *   authenticate: the sign-in page can't create the first account and `signUpEmail` is
 *   rejected. So the first user must be SEEDED out-of-band. We do it the way better-auth's
 *   own admin plugin does — via the INTERNAL adapter — WITHOUT registering the admin plugin
 *   (which would churn the schema).
 *
 * MECHANISM (decided; verified against the installed better-auth 1.6.20 —
 *   dist/plugins/admin/routes.mjs `createUser` is the reference implementation):
 *     const ctx  = await auth.$context;
 *     const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true });
 *     const hash = await ctx.password.hash(password);              // scrypt (@better-auth/utils)
 *     await ctx.internalAdapter.linkAccount({ accountId: user.id, providerId: "credential",
 *                                             password: hash, userId: user.id });
 *   Rejected alternatives (per the decision): raw SQL (scrypt password lives on the ACCOUNT
 *   row keyed to better-auth's own hasher → a hand-rolled hash is a dead login); `auth.api.
 *   signUpEmail` (our `disableSignUp` blocks our own call); the admin plugin (schema churn).
 *
 * IDEMPOTENT + SAFE (a past incident fail-loud, a past incident never-log-a-secret):
 *   - user exists WITH a `credential` account  → NO-OP (never rotate a working login on a
 *     re-run) unless `rotate` is explicitly requested.
 *   - user exists WITHOUT a `credential` account → LINK the credential (repair a partial state).
 *   - user absent → create + hash + link.
 *   - `rotate` is the ONLY path that overwrites an existing working credential.
 *   The password is NEVER logged.
 *
 * ONE LOGIN: after seeding, `main()` also gives the login its Command dashboard
 * (services/dashboardOwner.ts — link an unlinked row with the same email, else create an owner
 * row). Opt out per exec with MANDREL_OAUTH_SEED_DASHBOARD_OWNER=false; name an existing row with
 * MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME, or by row id with
 * MANDREL_OAUTH_SEED_DASHBOARD_LINK_ADMIN_ID (REQUIRED when more than one admin row exists). A refused link (unverified login, ambiguous or
 * non-admin email match) prints DASHBOARD_OWNER=refused and exits 1.
 *
 * The exported `seedFirstOAuthUser(auth, {...})` is the tested unit; `main()` is the CLI an
 * operator runs inside the container (`docker exec -e`). CLI
 * inputs come from the ENVIRONMENT at exec time (NEVER argv — argv leaks the password in `ps`).
 */

import { Pool } from 'pg';
import { createAuth, type AuthInstance } from '../server/auth.js';
import { BETTER_AUTH_CONFIG } from '../config/betterAuthConfig.js';
import { logger } from '../utils/logger.js';
import { guardPool } from '../utils/datastoreError.js';
import { linkDashboardOwner, DashboardLinkRefused } from '../services/dashboardOwner.js';

/** Result actions — distinct so the shell wrapper can grep the outcome from the log line. */
export type SeedAction = 'created' | 'exists' | 'repaired' | 'rotated';

export interface SeedFirstOAuthUserInput {
  email: string;
  name: string;
  password: string;
  /** The ONLY path that overwrites an existing, working credential. Default false. */
  rotate?: boolean;
}

export interface SeedFirstOAuthUserResult {
  action: SeedAction;
  userId: string;
  /** The (normalized, lower-cased) email the credential is keyed to. */
  email: string;
}

const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * Seed (or repair / rotate) the first email+password login for an OAuth-enabled tenant.
 * Replicates the admin-plugin `createUser` path via better-auth's internal adapter, without
 * registering the plugin. Returns which action was taken (never throws for the idempotent
 * no-op case — it returns `action:'exists'`).
 */
export async function seedFirstOAuthUser(
  auth: AuthInstance,
  input: SeedFirstOAuthUserInput,
): Promise<SeedFirstOAuthUserResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const rotate = input.rotate === true;

  if (!email) throw new Error('seedFirstOAuthUser: email is required');
  if (!input.password) throw new Error('seedFirstOAuthUser: password is required');

  const ctx = await auth.$context;

  // includeAccounts:true so we can tell "user exists" from "user exists WITH a credential".
  const existing = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });

  if (existing) {
    const user = existing.user;
    const hasCredential = (existing.accounts ?? []).some(
      (a) => a.providerId === CREDENTIAL_PROVIDER_ID,
    );

    if (hasCredential) {
      if (rotate) {
        // The ONLY overwrite path. updatePassword() targets the (userId, providerId=credential)
        // account row — the same row sign-in verifies against.
        const hash = await ctx.password.hash(input.password);
        await ctx.internalAdapter.updatePassword(user.id, hash);
        return { action: 'rotated', userId: user.id, email };
      }
      // Idempotent re-run: a working login already exists. NEVER silently rotate it.
      return { action: 'exists', userId: user.id, email };
    }

    // Partial state: the user row exists but has no credential account (e.g. an earlier
    // half-run, or a social-only user). Link the credential to repair it.
    const hash = await ctx.password.hash(input.password);
    await ctx.internalAdapter.linkAccount({
      accountId: user.id,
      providerId: CREDENTIAL_PROVIDER_ID,
      password: hash,
      userId: user.id,
    });
    return { action: 'repaired', userId: user.id, email };
  }

  // Fresh: create the user (email pre-verified — this is the provisioned AS account, not a
  // self-service sign-up), hash the password with better-auth's own hasher, link the credential.
  const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true });
  const hash = await ctx.password.hash(input.password);
  await ctx.internalAdapter.linkAccount({
    accountId: user.id,
    providerId: CREDENTIAL_PROVIDER_ID,
    password: hash,
    userId: user.id,
  });
  return { action: 'created', userId: user.id, email };
}

/**
 * CLI entry point — reads inputs from the environment (never argv), builds a real auth
 * instance from the tenant's live BETTER_AUTH_CONFIG, seeds, and prints a single grep-able
 * `SEED_RESULT=<action>` line. Exits 0 on any success (created / exists / repaired / rotated),
 * 1 on error. The password is never echoed.
 */
async function main(): Promise<void> {
  const email = (process.env.MANDREL_OAUTH_SEED_EMAIL ?? '').trim(); // env-read: MANDREL_OAUTH_SEED_EMAIL
  const password = process.env.MANDREL_OAUTH_SEED_PASSWORD ?? ''; // env-read: MANDREL_OAUTH_SEED_PASSWORD
  // NAME defaults to the email if the caller did not supply one (better-auth requires a name).
  const name = (process.env.MANDREL_OAUTH_SEED_NAME ?? '').trim() || email; // env-read: MANDREL_OAUTH_SEED_NAME
  const rotate = ['1', 'true', 'yes', 'on'].includes(
    (process.env.MANDREL_OAUTH_SEED_ROTATE ?? '').trim().toLowerCase(), // env-read: MANDREL_OAUTH_SEED_ROTATE
  );
  // ONE LOGIN: the seeded login user is this instance's OWNER, so by default
  // they also get the Command dashboard (Settings → API tokens lives there). An operator
  // seeding a login that must NOT get the dashboard sets this to false.
  const dashboardOwner = !['0', 'false', 'no', 'off'].includes(
    (process.env.MANDREL_OAUTH_SEED_DASHBOARD_OWNER ?? '').trim().toLowerCase(), // env-read: MANDREL_OAUTH_SEED_DASHBOARD_OWNER
  );
  // The operator's EXPLICIT choice of an existing dashboard row to link (its username). Needed
  // when the email matches no admin, several rows, or a non-admin row (services/dashboardOwner.ts).
  const linkUsername = (process.env.MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME ?? '').trim() || undefined; // env-read: MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME
  // The operator's EXPLICIT choice of the existing dashboard row by admin_users.id. REQUIRED
  // when more than one admin row exists (an email match is not trusted then).
  const linkAdminId = (process.env.MANDREL_OAUTH_SEED_DASHBOARD_LINK_ADMIN_ID ?? '').trim() || undefined; // env-read: MANDREL_OAUTH_SEED_DASHBOARD_LINK_ADMIN_ID

  if (!email) {
    logger.error('SEED_RESULT=error MANDREL_OAUTH_SEED_EMAIL is required (unset/empty)');
    process.exit(1);
  }
  if (!password) {
    logger.error('SEED_RESULT=error MANDREL_OAUTH_SEED_PASSWORD is required (unset/empty)');
    process.exit(1);
  }

  // Build a real better-auth instance from the tenant's live config (issuer/secret/basePath
  // etc. from env). Own an explicit pool so we can close it cleanly at the end.
  // DATASTORE ERROR BOUNDARY. An operator CLI, not a caller-facing surface —
  // guarded anyway so the invariant the guard test asserts is "EVERY `new Pool(` under
  // mcp-server/src is wrapped", with no judgement calls about reachability to erode it.
  const pool = guardPool(new Pool({
    user: process.env.DATABASE_USER || 'mandrel',
    host: process.env.DATABASE_HOST || 'localhost',
    database: process.env.DATABASE_NAME || 'mandrel',
    password: process.env.DATABASE_PASSWORD || '',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    ssl: ((process.env.DATABASE_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'true')
      ? { rejectUnauthorized: false }
      : false,
    max: 3,
  }));

  try {
    const auth = createAuth(BETTER_AUTH_CONFIG, pool);
    const result = await seedFirstOAuthUser(auth, { email, name, password, rotate });
    // Distinct, grep-able outcome line (no secret). The wrapper keys off SEED_RESULT=<action>.
    switch (result.action) {
      case 'created':
        logger.info(`SEED_RESULT=created user=${result.userId} email=${result.email}`);
        break;
      case 'exists':
        logger.info(`SEED_RESULT=exists user=${result.userId} email=${result.email} (credential already present — skipping)`);
        break;
      case 'repaired':
        logger.info(`SEED_RESULT=repaired user=${result.userId} email=${result.email} (linked missing credential)`);
        break;
      case 'rotated':
        logger.info(`SEED_RESULT=rotated user=${result.userId} email=${result.email} (existing credential overwritten)`);
        break;
    }
    // ONE LOGIN: link (or create) the dashboard row for this login user. On a
    // re-run this is 'exists' and changes nothing (an operator's demotion/deactivation stands).
    if (dashboardOwner) {
      try {
        const owner = await linkDashboardOwner(pool, { authUserId: result.userId, email: result.email, linkUsername, linkAdminId });
        logger.info(`DASHBOARD_OWNER=${owner.action} admin_user=${owner.adminUserId} username=${owner.username}`);
      } catch (err) {
        if (err instanceof DashboardLinkRefused) {
          // A refusal is a FAILED provisioning step, not a skipped one: nonzero exit.
          logger.error(`DASHBOARD_OWNER=refused reason=${err.reason} ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    } else {
      logger.info('DASHBOARD_OWNER=skipped (MANDREL_OAUTH_SEED_DASHBOARD_OWNER=false)');
    }
    process.exit(0);
  } catch (err) {
    logger.error('SEED_RESULT=error seedFirstOAuthUser failed', err as Error);
    process.exit(1);
  } finally {
    await pool.end().catch(() => { /* already closed */ });
  }
}

// CLI-main guard (ESM): only run main() when this module is the process entry point, so
// importing `seedFirstOAuthUser` from a test does NOT execute the CLI.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
