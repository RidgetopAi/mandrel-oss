/**
 * DB-integration test for ProjectAccessService — the F-04 grant table end-to-end
 * (migration 075 user_project_access).
 *
 * Proves against the REAL migrated schema: deny-by-default for a non-admin with no
 * grant; grant → allow; revoke → deny again; grant idempotency; the admin role bypass
 * with ZERO rows in the table; project-reference resolution by id AND by name; and the
 * FK CASCADE (deleting the project deletes the grant).
 *
 * Gated by describeDb (helpers/dbContractGate): RUNS whenever Postgres is reachable,
 * FAILS LOUDLY when not — never a silent skip in a gate.
 *
 * Local run:
 *   bash scripts/provision-test-db.sh ci_projaccess_fm
 *   eval "$(bash scripts/provision-test-db.sh ci_projaccess_fm --print-env)"
 *   npm test -- projectAccess.db
 *   bash scripts/provision-test-db.sh ci_projaccess_fm --drop
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { ProjectAccessService } from '../services/projectAccess';
import { describeDb } from './helpers/dbContractGate';

describeDb('ProjectAccessService — user_project_access (DB integration)', () => {
  let pool: Pool;
  let userId: string;
  let adminId: string;
  let projectId: string;
  let otherProjectId: string;
  let projectName: string;

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    userId = uuidv4();
    adminId = uuidv4();
    projectId = uuidv4();
    otherProjectId = uuidv4();
    projectName = `fm-b3cff00d-${projectId.slice(0, 8)}`;

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, 'x', 'user', true), ($4, $5, $6, 'x', 'admin', true)`,
        [
          userId, `fm-user-${userId.slice(0, 8)}`, `fm-user-${userId.slice(0, 8)}@test.invalid`,
          adminId, `fm-admin-${adminId.slice(0, 8)}`, `fm-admin-${adminId.slice(0, 8)}@test.invalid`,
        ]
      );
      await client.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'an earlier change test project', 'active', NOW()),
                ($3, $4, 'an earlier change other project', 'active', NOW())`,
        [projectId, projectName, otherProjectId, `${projectName}-other`]
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      // Grants cascade off both parents; delete the parents.
      await client.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
      await client.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [[userId, adminId]]);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('deny-by-default: a non-admin with NO grant row is refused', async () => {
    await expect(
      ProjectAccessService.userHasProjectAccess({ id: userId, role: 'user' }, projectId)
    ).resolves.toBe(false);
  });

  it('admin bypass: allowed with ZERO rows in the table (the role IS the grant)', async () => {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM user_project_access WHERE user_id = $1',
      [adminId]
    );
    expect(rows[0].n).toBe(0);
    await expect(
      ProjectAccessService.userHasProjectAccess({ id: adminId, role: 'admin' }, projectId)
    ).resolves.toBe(true);
  });

  it('grant → allow (scoped to THAT project only) → revoke → deny again; grant is idempotent', async () => {
    await ProjectAccessService.grantAccess(userId, projectId, adminId);
    await ProjectAccessService.grantAccess(userId, projectId, adminId); // idempotent
    await expect(
      ProjectAccessService.userHasProjectAccess({ id: userId, role: 'user' }, projectId)
    ).resolves.toBe(true);
    // The grant is an edge, not a blanket: the OTHER project stays denied.
    await expect(
      ProjectAccessService.userHasProjectAccess({ id: userId, role: 'user' }, otherProjectId)
    ).resolves.toBe(false);
    await expect(ProjectAccessService.listAccessibleProjectIds(userId)).resolves.toEqual([projectId]);

    await ProjectAccessService.revokeAccess(userId, projectId);
    await expect(
      ProjectAccessService.userHasProjectAccess({ id: userId, role: 'user' }, projectId)
    ).resolves.toBe(false);
  });

  it('resolveProjectId resolves by UUID and by exact name; unknown → null', async () => {
    await expect(ProjectAccessService.resolveProjectId(projectId)).resolves.toBe(projectId);
    await expect(ProjectAccessService.resolveProjectId(projectName)).resolves.toBe(projectId);
    await expect(ProjectAccessService.resolveProjectId('no-such-project-b3cff00d')).resolves.toBeNull();
  });

  it('FK cascade: deleting the project deletes the grant (no dead-project grants)', async () => {
    const tempProject = uuidv4();
    await pool.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, 'temp', 'active', NOW())`,
      [tempProject, `fm-temp-${tempProject.slice(0, 8)}`]
    );
    await ProjectAccessService.grantAccess(userId, tempProject, adminId);
    await pool.query('DELETE FROM projects WHERE id = $1', [tempProject]);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM user_project_access WHERE project_id = $1',
      [tempProject]
    );
    expect(rows[0].n).toBe(0);
  });
});
