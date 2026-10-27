/**
 * dashboardOwner — give a provisioned better-auth login user their Command dashboard
 * (option A: ONE login; migration 109).
 *
 * A better-auth user can sign into the dashboard only through an admin_users row LINKED to
 * them (admin_users.auth_user_id). The link is made HERE, by the operator's provisioning act
 * (seed-first-oauth-user runs this for the customer it seeds) — never inferred at sign-in time
 * from a matching email. That keeps "who may use this instance's dashboard, and as what role"
 * an operator decision: a better-auth account that exists for any other reason (an open
 * sign-up instance, a connector login on prod) gets no dashboard until someone links it.
 *
 * THE RULE, in order (one transaction):
 *   0. the better-auth user must be emailVerified (created by provisioning, not by open
 *      sign-up) — else REFUSED (DashboardLinkRefused, nonzero exit from the seed CLI).
 *   1. a row is already linked to this better-auth user → 'exists'. Nothing changes — not the
 *      role, not is_active. A re-run of provisioning must never undo an operator's demotion
 *      or deactivation.
 *   2. the operator NAMED a row (linkAdminId, or linkUsername), or exactly ONE row carries the same email
 *      (case-insensitive) AND is already an admin → link it: 'linked-existing'. Two or more
 *      email matches, or a single non-admin match, are REFUSED — and with MORE THAN ONE admin
 *      row, email is not consulted at all: a row id (linkAdminId) is required (N5): admin_users.email is
 *      unverified and self-editable, so the operator must name the row.
 *      This is the migration path for an instance that already has an admin (prod, a
 *      self-hoster): the existing row keeps its password, its tokens, its preferences and its
 *      grants, and gains the better-auth login. Both logins work; nobody is locked out.
 *   3. otherwise → create the row: 'created'. role = DASHBOARD_AUTH_CONFIG.ownerRole (per
 *      instance, the hosted customer IS the owner), no dashboard password (better-auth holds
 *      the only credential — the has_credential CHECK accepts that because the row is linked),
 *      must_change_password false (they chose their password on the set-password page).
 *
 *   A row with the same email ALREADY linked to a DIFFERENT better-auth user is a conflict and
 *   throws — two logins must never resolve to one authorization record.
 */

import type { Pool, PoolClient } from 'pg';
import { DASHBOARD_AUTH_CONFIG } from '../config/dashboardAuthConfig.js';

export type DashboardOwnerAction = 'exists' | 'linked-existing' | 'created';

export interface DashboardOwnerResult {
  action: DashboardOwnerAction;
  /** admin_users.id */
  adminUserId: string;
  /** admin_users.username — the dashboard handle (the customer signs in with the email). */
  username: string;
}

/**
 * The Command dashboard's username rule (mandrel-command/backend/src/services/user.ts
 * USERNAME_RULES): 3-32 chars of [A-Za-z0-9._-]. A created row's handle must satisfy it, or the
 * customer could never save their own profile.
 */
export const DASHBOARD_USERNAME_RULE = { minLength: 3, maxLength: 32, disallowed: /[^A-Za-z0-9._-]+/g } as const;

/** The base handle for an email: its local part, reduced to the dashboard's allowed alphabet. */
export function usernameBaseFor(email: string): string {
  const local = email.split('@')[0] ?? '';
  let base = local.replace(DASHBOARD_USERNAME_RULE.disallowed, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (base.length < DASHBOARD_USERNAME_RULE.minLength) base = `${base || 'owner'}-user`.slice(0, DASHBOARD_USERNAME_RULE.maxLength);
  return base.slice(0, DASHBOARD_USERNAME_RULE.maxLength);
}

async function pickFreeUsername(client: PoolClient, email: string): Promise<string> {
  const base = usernameBaseFor(email);
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${base.slice(0, DASHBOARD_USERNAME_RULE.maxLength - suffix.length)}${suffix}`;
    const taken = await client.query('SELECT 1 FROM admin_users WHERE lower(username) = lower($1)', [candidate]);
    if (taken.rowCount === 0) return candidate;
  }
  throw new Error(`linkDashboardOwner: no free dashboard username for base '${base}'`);
}

/**
 * A refusal to link — a nonzero exit for the seed CLI, never a silent skip. `reason` is a
 * stable code the shell wrapper and tests can match; `message` says what the operator does next.
 */
const UUID_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DashboardLinkRefused extends Error {
  constructor(
    readonly reason: 'email-not-verified' | 'no-such-login' | 'ambiguous-email' | 'not-admin' | 'named-row-missing' | 'already-linked-elsewhere' | 'admin-row-id-required',
    message: string,
  ) {
    super(message);
    this.name = 'DashboardLinkRefused';
  }
}

export async function linkDashboardOwner(
  pool: Pick<Pool, 'connect'>,
  input: {
    authUserId: string;
    email: string;
    /**
     * The operator's EXPLICIT choice of the existing dashboard row to link (its username).
     * When given, only that row is considered — no inference from email. Seed CLI env:
     * MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME.
     */
    linkUsername?: string;
    /**
     * The operator's EXPLICIT choice of the existing dashboard row to link, by admin_users.id.
     * REQUIRED when more than one admin row exists (N5): an email match is then never trusted.
     * Takes precedence over linkUsername. Seed CLI env: MANDREL_OAUTH_SEED_DASHBOARD_LINK_ADMIN_ID.
     */
    linkAdminId?: string;
  },
): Promise<DashboardOwnerResult> {
  const email = input.email.trim();
  const linkUsername = input.linkUsername?.trim() || undefined;
  const linkAdminId = input.linkAdminId?.trim() || undefined;
  if (!input.authUserId) throw new Error('linkDashboardOwner: authUserId is required');
  if (!email) throw new Error('linkDashboardOwner: email is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // F1 (Reviewer): only a VERIFIED better-auth user may own a dashboard. The seed
    // creates its users emailVerified=true; open sign-up (MANDREL_OAUTH_ALLOW_SIGNUP=true)
    // creates them false. Without this, whoever self-registered the owner's address first
    // became the instance owner when the operator ran provisioning (the seed reports `exists`
    // and leaves THEIR password in place).
    const ba = await client.query<{ emailVerified: boolean }>(
      'SELECT "emailVerified" FROM "user" WHERE id = $1 FOR SHARE',
      [input.authUserId],
    );
    if (!ba.rows[0]) {
      throw new DashboardLinkRefused('no-such-login', `no better-auth login with id ${input.authUserId}`);
    }
    if (ba.rows[0].emailVerified !== true) {
      throw new DashboardLinkRefused(
        'email-not-verified',
        `the better-auth login for ${email} was not created by provisioning (emailVerified=false — e.g. ` +
          'self-registered through open sign-up), so it is NOT given the dashboard. Investigate who created ' +
          'it; delete it and re-run provisioning if it is not the customer.',
      );
    }

    const linked = await client.query<{ id: string; username: string }>(
      'SELECT id, username FROM admin_users WHERE auth_user_id = $1',
      [input.authUserId],
    );
    if (linked.rows[0]) {
      await client.query('COMMIT');
      return { action: 'exists', adminUserId: linked.rows[0].id, username: linked.rows[0].username };
    }

    type Row = { id: string; username: string; role: string | null; auth_user_id: string | null };
    let target: Row | undefined;
    if (linkAdminId) {
      // The operator NAMED the row by id: that row and only that row.
      const named = UUID_RULE.test(linkAdminId)
        ? await client.query<Row>(
            'SELECT id, username, role, auth_user_id FROM admin_users WHERE id = $1 FOR UPDATE',
            [linkAdminId],
          )
        : { rows: [] as Row[] };
      if (!named.rows[0]) {
        throw new DashboardLinkRefused('named-row-missing', `no dashboard user with row id '${linkAdminId}'`);
      }
      target = named.rows[0];
    } else if (linkUsername) {
      // The operator NAMED the row: that row and only that row.
      const named = await client.query<Row>(
        'SELECT id, username, role, auth_user_id FROM admin_users WHERE username = $1 FOR UPDATE',
        [linkUsername],
      );
      if (!named.rows[0]) {
        throw new DashboardLinkRefused('named-row-missing', `no dashboard user named '${linkUsername}'`);
      }
      target = named.rows[0];
    } else {
      // F2 (Reviewer): admin_users.email is unverified and self-editable (PUT
      // /users/profile), so an email match alone is not the operator's intent. Inferred only
      // when it is UNAMBIGUOUS and the row is ALREADY an admin; anything else is refused and
      // the operator names the row explicitly.
      const byEmail = await client.query<Row>(
        'SELECT id, username, role, auth_user_id FROM admin_users WHERE lower(email) = lower($1) ORDER BY id FOR UPDATE',
        [email],
      );
      // N5 (Reviewer): with MORE THAN ONE admin row, an existing admin can retarget
      // this match by setting their own email to the owner's. The email is then no evidence at
      // all, so the operator must name the row by id. Exactly one admin: unchanged.
      const admins = await client.query<{ id: string; username: string }>(
        'SELECT id, username FROM admin_users WHERE role = $1 ORDER BY id FOR UPDATE',
        [DASHBOARD_AUTH_CONFIG.ownerRole],
      );
      if (byEmail.rows.length > 0 && admins.rows.length > 1) {
        throw new DashboardLinkRefused(
          'admin-row-id-required',
          `${admins.rows.length} ${DASHBOARD_AUTH_CONFIG.ownerRole} rows exist (${admins.rows.map((r) => `${r.username}=${r.id}`).join(', ')}); ` +
            'an email match is not trusted with more than one admin — a row id is required: ' +
            'set MANDREL_OAUTH_SEED_DASHBOARD_LINK_ADMIN_ID to the owner\'s admin_users.id',
        );
      }
      if (byEmail.rows.length > 1) {
        throw new DashboardLinkRefused(
          'ambiguous-email',
          `${byEmail.rows.length} dashboard users carry the email ${email} (${byEmail.rows.map((r) => r.username).join(', ')}); ` +
            'name the one to link with MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME',
        );
      }
      if (byEmail.rows[0] && byEmail.rows[0].role !== DASHBOARD_AUTH_CONFIG.ownerRole) {
        throw new DashboardLinkRefused(
          'not-admin',
          `dashboard user '${byEmail.rows[0].username}' carries the email ${email} but is not an ${DASHBOARD_AUTH_CONFIG.ownerRole}; ` +
            'an email match alone is not trusted for a non-admin row (anyone can set their own email). Name the row ' +
            'with MANDREL_OAUTH_SEED_DASHBOARD_LINK_USERNAME if it really is this person',
        );
      }
      target = byEmail.rows[0];
    }

    if (target) {
      if (target.auth_user_id !== null) {
        throw new DashboardLinkRefused(
          'already-linked-elsewhere',
          `dashboard user '${target.username}' already belongs to a different sign-in; refusing to re-link it`,
        );
      }
      await client.query('UPDATE admin_users SET auth_user_id = $1 WHERE id = $2', [input.authUserId, target.id]);
      await client.query('COMMIT');
      return { action: 'linked-existing', adminUserId: target.id, username: target.username };
    }

    const username = await pickFreeUsername(client, email);
    const created = await client.query<{ id: string }>(
      `INSERT INTO admin_users (username, email, password_hash, role, is_active, must_change_password, auth_user_id)
       VALUES ($1, $2, NULL, $3, true, false, $4)
       RETURNING id`,
      [username, email, DASHBOARD_AUTH_CONFIG.ownerRole, input.authUserId],
    );
    await client.query('COMMIT');
    return { action: 'created', adminUserId: created.rows[0].id, username };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
    throw err;
  } finally {
    client.release();
  }
}
