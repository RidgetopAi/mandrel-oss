/**
 * Command-auth leftovers (Reviewer on single login).
 *
 * N5: with more than one admin row, the seed's link-to-existing-admin step must not match by
 *     email (an admin can set their own email to the owner's) — it requires an operator-named
 *     admin_users.id. With exactly one admin it behaves as before.
 * N3: expired better-auth "session" rows are deleted; live ones stay.
 *
 * Runs against the disposable migrated scratch DB (DATABASE_*), directly against
 * linkDashboardOwner / deleteExpiredAuthSessions — no HTTP server needed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { requireScratchDb } from './helpers/scratchTestDb.js';
import { linkDashboardOwner, DashboardLinkRefused } from '../services/dashboardOwner.js';
import { deleteExpiredAuthSessions } from '../services/authSessionSweeper.js';

const SCRATCH = requireScratchDb('AUTHLEFT');
let pool: Pool;
const tag = `${Date.now() % 1e9}${Math.random().toString(36).slice(2, 6)}`;
const ownerEmail = `owner-${tag}@example.test`;
const createdAdminIds: string[] = [];
const createdUserIds: string[] = [];
let parked: string[] = [];

async function insertAdmin(username: string, email: string): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO admin_users (username, email, password_hash, role, is_active)
     VALUES ($1, $2, '$2b$04$notarealhashnotarealhashno', 'admin', true) RETURNING id`,
    [`${username}-${tag}`, email],
  )).rows[0].id as string;
  createdAdminIds.push(id);
  return id;
}

async function insertBaUser(email: string): Promise<string> {
  const id = `ba-${randomUUID()}`;
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, true, now(), now())`,
    [id, email],
  );
  createdUserIds.push(id);
  return id;
}

async function insertSession(userId: string, expiresAtSql: string): Promise<string> {
  const id = `sess-${randomUUID()}`;
  await pool.query(
    `INSERT INTO "session" (id, "expiresAt", token, "updatedAt", "userId") VALUES ($1, ${expiresAtSql}, $2, now(), $3)`,
    [id, `tok-${randomUUID()}`, userId],
  );
  return id;
}

beforeAll(() => {
  pool = new Pool({
    user: SCRATCH.user, host: SCRATCH.host, database: SCRATCH.name,
    password: SCRATCH.password, port: parseInt(SCRATCH.port, 10),
  });
});

afterAll(async () => {
  if (createdAdminIds.length) await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [createdAdminIds]);
  if (createdUserIds.length) await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [createdUserIds]);
  await pool.end();
});

describe('N5: the seed link names the admin row when more than one admin exists', () => {
  // A shared scratch DB accumulates admin rows from other suites; park them so "exactly one
  // admin" / "two admins" are the DB's real state during each test.
  beforeEach(async () => {
    parked = (await pool.query(`UPDATE admin_users SET role = 'user' WHERE role = 'admin' RETURNING id`)).rows.map((r) => r.id as string);
  });
  afterEach(async () => {
    if (parked.length) await pool.query(`UPDATE admin_users SET role = 'admin' WHERE id = ANY($1::uuid[])`, [parked]);
  });

  it('admin B set their email to the owner\'s: no row id → refused; owner\'s row id → owner linked, never B', async () => {
    const ownerRow = await insertAdmin('owner', `owner-old-${tag}@example.test`);
    const rowB = await insertAdmin('mallory', ownerEmail); // B retargeted the match by editing their own email
    const authUserId = await insertBaUser(ownerEmail);

    const refused = await linkDashboardOwner(pool, { authUserId, email: ownerEmail }).catch((e) => e);
    expect(refused).toBeInstanceOf(DashboardLinkRefused);
    expect(refused.reason).toBe('admin-row-id-required');
    expect(refused.message).toMatch(/row id is required/);
    expect(refused.message).toContain('MANDREL_OAUTH_SEED_DASHBOARD_LINK_ADMIN_ID');
    expect((await pool.query('SELECT count(*)::int AS n FROM admin_users WHERE auth_user_id = $1', [authUserId])).rows[0].n).toBe(0);

    const linked = await linkDashboardOwner(pool, { authUserId, email: ownerEmail, linkAdminId: ownerRow });
    expect(linked).toMatchObject({ action: 'linked-existing', adminUserId: ownerRow });
    const rows = await pool.query('SELECT id, auth_user_id FROM admin_users WHERE id = ANY($1::uuid[]) ORDER BY username', [[ownerRow, rowB]]);
    expect(rows.rows.find((r) => r.id === ownerRow).auth_user_id).toBe(authUserId);
    expect(rows.rows.find((r) => r.id === rowB).auth_user_id).toBeNull();
  });

  it('a row id that matches no row is refused (named-row-missing), never falls back to email', async () => {
    const email = `missing-${tag}@example.test`;
    await insertAdmin('a1', `a1-${tag}@example.test`);
    await insertAdmin('a2', email);
    const authUserId = await insertBaUser(email);
    for (const bad of [randomUUID(), 'not-a-uuid']) {
      const err = await linkDashboardOwner(pool, { authUserId, email, linkAdminId: bad }).catch((e) => e);
      expect(err.reason).toBe('named-row-missing');
    }
  });

  it('exactly one admin: the unambiguous email match still links, as before', async () => {
    const email = `only-${tag}@example.test`;
    const only = await insertAdmin('only', email);
    const authUserId = await insertBaUser(email);
    const linked = await linkDashboardOwner(pool, { authUserId, email });
    expect(linked).toMatchObject({ action: 'linked-existing', adminUserId: only });
  });
});

describe('N3: expired better-auth sessions are deleted', () => {
  it('the cleanup removes the expired session and keeps the live one', async () => {
    const userId = await insertBaUser(`sess-${tag}@example.test`);
    const expired = await insertSession(userId, `now() - interval '1 day'`);
    const live = await insertSession(userId, `now() + interval '7 days'`);

    const deleted = await deleteExpiredAuthSessions(pool);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const left = (await pool.query('SELECT id FROM "session" WHERE id = ANY($1::text[])', [[expired, live]])).rows.map((r) => r.id);
    expect(left).toEqual([live]);
  });
});
