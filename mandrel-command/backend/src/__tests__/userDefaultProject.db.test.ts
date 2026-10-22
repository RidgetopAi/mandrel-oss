/**
 * DB-integration guard for the PER-USER default project (epic 41293984 §A,
 * migration 076 `admin_users.default_project_id`).
 *
 * ── WHAT THIS GUARD IS ANCHORED ON, AND WHY ──────────────────────────────────────────
 * The thing being guarded is an AUTHORIZATION boundary: a user must not be able to pin a
 * project they cannot see. A test that asked the service "did you accept it?" and
 * believed the answer would be the app agreeing with itself — the service decides both
 * the answer and the assertion.
 *
 * So every scoping assertion here reads the RAW COLUMN with its own SQL, through a pool
 * this test owns, against the REAL migrated schema. The anchor is a PLANTED SECOND
 * PROJECT (`deniedProjectId`) that the non-admin user has no grant for: the assertion is
 * that this id is **ABSENT** from `admin_users.default_project_id` after the attempt, and
 * that the previously-set value is still exactly there. Non-interference, not
 * self-agreement — the service cannot move the value this test reads.
 *
 * ── THE POPULATION THIS GUARD ENUMERATES ─────────────────────────────────────────────
 * Every distinct outcome `UserPreferencesService.mayUseAsDefault` can produce, plus the
 * two write shapes that can silently destroy a stored value:
 *   granted / denied / nonexistent-for-nonadmin / nonexistent-for-admin / malformed /
 *   null-clear / theme-only-partial-update / FK ON DELETE SET NULL.
 * The empty + absent members (null clear, omitted key, zero grants) are in on purpose —
 * those are the values that slip through a check written as a truthiness test (C3).
 *
 * ── LOCAL RUN ────────────────────────────────────────────────────────────────────────
 *   bash scripts/provision-test-db.sh ci_sel_foundation
 *   eval "$(bash scripts/provision-test-db.sh ci_sel_foundation --print-env)"
 *   cd mandrel-command/backend && npx jest src/__tests__/userDefaultProject.db.test.ts
 *   bash scripts/provision-test-db.sh ci_sel_foundation --drop
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { UserPreferencesService } from '../services/userPreferences';
import { ProjectAccessService } from '../services/projectAccess';
import { db } from '../database/connection';
import { describeDb } from './helpers/dbContractGate';

describeDb('per-user default project — admin_users.default_project_id (DB integration)', () => {
  let pool: Pool;

  let userId: string;      // non-admin: granted grantedProjectId ONLY
  let adminId: string;     // admin: bypasses the grant table entirely
  let grantedProjectId: string;
  let deniedProjectId: string;  // THE PLANTED RECORD — must never appear in the column
  const ghostProjectId = uuidv4(); // syntactically valid, no such project

  /**
   * Read the stored default STRAIGHT OUT OF POSTGRES with this suite's own pool.
   * Deliberately NOT via UserPreferencesService.get(): the code under test must not be
   * the instrument that reports on the code under test.
   */
  const rawStoredDefault = async (id: string): Promise<string | null> => {
    const r = await pool.query('SELECT default_project_id FROM admin_users WHERE id = $1', [id]);
    return r.rows[0]?.default_project_id ?? null;
  };

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    });

    userId = uuidv4();
    adminId = uuidv4();
    grantedProjectId = uuidv4();
    deniedProjectId = uuidv4();

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, 'x', 'user', true), ($4, $5, $6, 'x', 'admin', true)`,
        [
          userId, `fm-41293984-u-${userId.slice(0, 8)}`, `fm-41293984-u-${userId.slice(0, 8)}@test.invalid`,
          adminId, `fm-41293984-a-${adminId.slice(0, 8)}`, `fm-41293984-a-${adminId.slice(0, 8)}@test.invalid`,
        ]
      );
      await client.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, '41293984 granted project', 'active', NOW()),
                ($3, $4, '41293984 PLANTED denied project', 'active', NOW())`,
        [
          grantedProjectId, `fm-41293984-granted-${grantedProjectId.slice(0, 8)}`,
          deniedProjectId, `fm-41293984-denied-${deniedProjectId.slice(0, 8)}`,
        ]
      );
      // ONE grant, deliberately. Migration 075 seeds every ACTIVE NON-ADMIN user against
      // every EXISTING project, but both this user and both projects are created AFTER
      // that seed ran, so the user starts with zero grants and gets exactly one here.
      await client.query(
        `INSERT INTO user_project_access (user_id, project_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, grantedProjectId]
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [
        [grantedProjectId, deniedProjectId],
      ]);
      await client.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [[userId, adminId]]);
    } finally {
      client.release();
      await pool.end();
      // The service's shared app pool — closed here so jest does not hang on an open handle.
      await db.end();
    }
  });

  // ── THE PRE-CONDITION THE WHOLE SUITE RESTS ON ────────────────────────────────────
  it('the fixture really is asymmetric: granted YES, planted-denied NO', async () => {
    const nonAdmin = { id: userId, role: 'user' };
    await expect(ProjectAccessService.userHasProjectAccess(nonAdmin, grantedProjectId)).resolves.toBe(true);
    await expect(ProjectAccessService.userHasProjectAccess(nonAdmin, deniedProjectId)).resolves.toBe(false);
    // ...and asymmetric in the grant TABLE itself, not just in the service's opinion.
    const rows = await pool.query(
      'SELECT project_id FROM user_project_access WHERE user_id = $1',
      [userId]
    );
    expect(rows.rows.map((r) => r.project_id)).toEqual([grantedProjectId]);
  });

  // ── THE HAPPY PATH (the control: without this, every RED below means nothing) ──────
  it('a granted project is accepted and lands in the raw column', async () => {
    const check = await UserPreferencesService.mayUseAsDefault({ id: userId, role: 'user' }, grantedProjectId);
    expect(check).toEqual({ ok: true });

    await UserPreferencesService.update(userId, { defaultProjectId: grantedProjectId });
    expect(await rawStoredDefault(userId)).toBe(grantedProjectId);
  });

  // ── THE NON-INTERFERENCE ASSERTION ────────────────────────────────────────────────
  it('the PLANTED denied project is refused AND is ABSENT from the column afterwards', async () => {
    // Precondition: the granted project is what is stored right now.
    await UserPreferencesService.update(userId, { defaultProjectId: grantedProjectId });
    expect(await rawStoredDefault(userId)).toBe(grantedProjectId);

    const check = await UserPreferencesService.mayUseAsDefault({ id: userId, role: 'user' }, deniedProjectId);
    expect(check).toEqual({ ok: false, reason: 'forbidden' });

    // The anchor: the planted id is NOT there, and the old value was not disturbed.
    const stored = await rawStoredDefault(userId);
    expect(stored).not.toBe(deniedProjectId);
    expect(stored).toBe(grantedProjectId);

    // ...and nowhere else in the table either (no other row picked it up).
    const anyRow = await pool.query(
      'SELECT count(*)::int AS n FROM admin_users WHERE default_project_id = $1',
      [deniedProjectId]
    );
    expect(anyRow.rows[0].n).toBe(0);
  });

  // ── NO EXISTENCE ORACLE: denied and nonexistent must be INDISTINGUISHABLE ─────────
  it('a non-admin gets the SAME rejection for a real-but-denied project and a ghost id', async () => {
    const nonAdmin = { id: userId, role: 'user' };
    const denied = await UserPreferencesService.mayUseAsDefault(nonAdmin, deniedProjectId);
    const ghost = await UserPreferencesService.mayUseAsDefault(nonAdmin, ghostProjectId);
    expect(denied).toEqual(ghost);
    expect(denied).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('an ADMIN bypasses the grant table but still gets an honest 404 for a ghost id', async () => {
    const admin = { id: adminId, role: 'admin' };
    // Admin holds every project by definition — including the one the user was denied.
    expect(await UserPreferencesService.mayUseAsDefault(admin, deniedProjectId)).toEqual({ ok: true });
    // ...but a nonexistent project is not-found, not a silent accept that the FK
    // would later turn into a 500.
    expect(await UserPreferencesService.mayUseAsDefault(admin, ghostProjectId)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    // Admin has ZERO rows in the grant table — the bypass is by role, not by seeding.
    const grants = await pool.query(
      'SELECT count(*)::int AS n FROM user_project_access WHERE user_id = $1',
      [adminId]
    );
    expect(grants.rows[0].n).toBe(0);
  });

  // ── MALFORMED INPUT ───────────────────────────────────────────────────────────────
  it.each([
    ['not-a-uuid', 'a bare word'],
    ['', 'the empty string'],
    ['aaaaaaaa-1111-4111-8111-11111111111', 'one hex digit short'],
    ["'; DROP TABLE admin_users; --", 'a SQL fragment'],
  ])('refuses %s (%s) as invalid, before any DB write', async (value) => {
    expect(await UserPreferencesService.mayUseAsDefault({ id: userId, role: 'user' }, value)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  // ── THE EMPTY / ABSENT POPULATION (C3: the values that slip through) ──────────────
  it('null CLEARS the default', async () => {
    await UserPreferencesService.update(userId, { defaultProjectId: grantedProjectId });
    expect(await rawStoredDefault(userId)).toBe(grantedProjectId);

    await UserPreferencesService.update(userId, { defaultProjectId: null });
    expect(await rawStoredDefault(userId)).toBeNull();
  });

  // ── PARTIAL UPDATE, BOTH DIRECTIONS (§A5) ────────────────────────────────────────
  // The pre-existing handler ran `UPDATE admin_users SET theme = $1` UNCONDITIONALLY, so
  // an absent `theme` wrote NULL. Extended naively, a `{defaultProjectId}` PATCH would
  // null the theme and a `{theme}` PATCH would null the default. BOTH directions are
  // asserted because a partial-update bug is trivially half-fixed, and the untested half
  // is the one that ships.
  it('an OMITTED defaultProjectId does NOT wipe the stored value (theme-only update)', async () => {
    await UserPreferencesService.update(userId, { defaultProjectId: grantedProjectId });
    expect(await rawStoredDefault(userId)).toBe(grantedProjectId);

    // The exact shape a theme-only PATCH produces. If `undefined` were collapsed onto
    // `null` anywhere in the update path, this is where it shows up.
    await UserPreferencesService.update(userId, { theme: 'dark' });

    expect(await rawStoredDefault(userId)).toBe(grantedProjectId);
    const theme = await pool.query('SELECT theme FROM admin_users WHERE id = $1', [userId]);
    expect(theme.rows[0].theme).toBe('dark');
  });

  it('an OMITTED theme does NOT wipe it (defaultProjectId-only update — the §A5 twin)', async () => {
    await UserPreferencesService.update(userId, { theme: 'dark', defaultProjectId: null });
    expect((await pool.query('SELECT theme FROM admin_users WHERE id = $1', [userId])).rows[0].theme)
      .toBe('dark');

    // The exact shape a default-project-only PATCH produces.
    await UserPreferencesService.update(userId, { defaultProjectId: grantedProjectId });

    const after = await pool.query('SELECT theme, default_project_id FROM admin_users WHERE id = $1', [userId]);
    expect(after.rows[0].theme).toBe('dark');
    expect(after.rows[0].default_project_id).toBe(grantedProjectId);
  });

  it('an EMPTY update touches nothing at all (neither column is written)', async () => {
    await UserPreferencesService.update(userId, { theme: 'light', defaultProjectId: grantedProjectId });

    // The degenerate member of the population: no fields. It must be a no-op read, not an
    // UPDATE with an empty SET list and not a write of two NULLs.
    const result = await UserPreferencesService.update(userId, {});

    expect(result).toEqual({ theme: 'light', defaultProjectId: grantedProjectId });
    const after = await pool.query('SELECT theme, default_project_id FROM admin_users WHERE id = $1', [userId]);
    expect(after.rows[0].theme).toBe('light');
    expect(after.rows[0].default_project_id).toBe(grantedProjectId);
  });

  it('reads back through the service exactly what the raw column holds', async () => {
    await UserPreferencesService.update(userId, { defaultProjectId: grantedProjectId, theme: 'light' });
    const prefs = await UserPreferencesService.get(userId);
    expect(prefs).toEqual({ theme: 'light', defaultProjectId: await rawStoredDefault(userId) });
    expect(prefs?.defaultProjectId).toBe(grantedProjectId);
  });

  it('get() returns null for a user that does not exist (not an empty preference object)', async () => {
    expect(await UserPreferencesService.get(uuidv4())).toBeNull();
  });

  // ── THE FK CONTRACT: the column can never hold a dangling id ──────────────────────
  it('deleting the defaulted project NULLs the column (ON DELETE SET NULL, not dangling)', async () => {
    const doomedId = uuidv4();
    await pool.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, '41293984 doomed project', 'active', NOW())`,
      [doomedId, `fm-41293984-doomed-${doomedId.slice(0, 8)}`]
    );
    await pool.query(
      'INSERT INTO user_project_access (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, doomedId]
    );

    expect(await UserPreferencesService.mayUseAsDefault({ id: userId, role: 'user' }, doomedId)).toEqual({ ok: true });
    await UserPreferencesService.update(userId, { defaultProjectId: doomedId });
    expect(await rawStoredDefault(userId)).toBe(doomedId);

    await pool.query('DELETE FROM projects WHERE id = $1', [doomedId]);

    // Not a dangling id, and not a blocked delete — NULL, i.e. "no default set".
    expect(await rawStoredDefault(userId)).toBeNull();
  });
});
