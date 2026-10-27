/**
 * DB-integration test for BROWSE mode archived-row exclusion (search consolidation).
 * The old literal path had NO archived_at filter, so soft-deleted
 * contexts leaked into the list. Browse now defaults to `archived_at IS NULL`.
 *
 * Also proves the honest COUNT(*) OVER() total counts only the returned (live) set.
 *
 * Inserts its own rows into a throwaway test project and cleans them up. Skipped
 * by describeDb (helpers/dbContractGate).
 *
 * Run against a disposable DB:
 *   DATABASE_NAME=ci_x DATABASE_USER=ci_role ... npm test -- browseArchivedExcluded
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { ContextService } from '../services/context';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';


describeDb('browse mode excludes archived rows (DB integration)', () => {
  let pool: Pool;
  let projectId: string;
  let liveA: string;
  let liveB: string;
  let archived: string;

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    projectId = uuidv4();
    liveA = uuidv4();
    liveB = uuidv4();
    archived = uuidv4();

    await pool.query(
      `INSERT INTO projects (id, name, status) VALUES ($1, $2, 'active')`,
      [projectId, `browse-archived-test-${projectId.slice(0, 8)}`],
    );

    // Two live rows + one archived row, all in this project.
    await pool.query(
      `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
       VALUES ($1,$2,'planning','live one', ARRAY['t']::text[], now() - interval '2 min'),
              ($3,$2,'planning','live two', ARRAY['t']::text[], now() - interval '1 min')`,
      [liveA, projectId, liveB],
    );
    await pool.query(
      `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at, archived_at)
       VALUES ($1,$2,'planning','ARCHIVED row', ARRAY['t']::text[], now(), now())`,
      [archived, projectId],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await pool.end();
  });

  it('returns only the LIVE rows, never the archived one', async () => {
    const result = await ContextService.searchContexts({ scope: projectsScope([projectId])});
    const ids = result.contexts.map((c) => c.id);
    expect(ids).toContain(liveA);
    expect(ids).toContain(liveB);
    expect(ids).not.toContain(archived);
  });

  it('COUNT(*) OVER() total reflects only the live set (2), not 3', async () => {
    const result = await ContextService.searchContexts({ scope: projectsScope([projectId]), limit: 1 });
    // limit 1 → one row returned, but the windowed total still counts all LIVE matches.
    expect(result.contexts.length).toBe(1);
    expect(result.total).toBe(2);
  });
});
