/**
 * DB-integration tests for the direct-SQL Command search services.
 *
 * TASKS still use the shared id-lookup + partial-tag predicate (buildSearchPredicate)
 * — tasks are NOT embedded, so literal task search is correct — and this proves it
 * returns the EXACT rows for full UUID, hex id-prefix, partial-tag, and title text.
 *
 * CONTEXTS: after search consolidation the literal context matcher
 * was DELETED. ContextService.searchContexts is now a STRUCTURED-COLUMN BROWSE only;
 * free-text context matching lives in the ONE engine (mcp-server), covered by
 * searchConsolidation.contract.test.ts + contextSearchAdapter.test.ts. The context
 * cases below assert the NEW browse contract (no text matching; structured filters).
 *
 * Inserts its own rows into a throwaway test project and cleans them up. Skipped
 * by describeDb (helpers/dbContractGate).
 *
 * Run against the real DB locally:
 *   DATABASE_NAME=mandrel DATABASE_USER=mandrel npm test -- searchIdTagLookup
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { ContextService } from '../services/context';
import { TaskService } from '../services/task';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';


describeDb('id-lookup + partial-tag search (DB integration)', () => {
  let pool: Pool;
  let projectId: string;

  // Known fixture ids — we generate them so we can assert exact-id lookup.
  let ctxIdA: string; // tagged ['ref:resume','bucket:alpha'], content 'CANONICAL anchor'
  let ctxIdB: string; // tagged ['ref:other'], content 'unrelated body'
  let taskIdA: string; // tagged ['bucket:alpha','quick-win'], title 'Build the thing'

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    projectId = uuidv4();
    ctxIdA = uuidv4();
    ctxIdB = uuidv4();
    taskIdA = uuidv4();

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [projectId, `search-test-${projectId.slice(0, 8)}`, 'id/tag search test', 'active'],
      );

      await client.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [ctxIdA, projectId, 'milestone', 'CANONICAL anchor body', ['ref:resume', 'bucket:alpha']],
      );
      await client.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [ctxIdB, projectId, 'discussion', 'unrelated body text', ['ref:other']],
      );

      await client.query(
        `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [taskIdA, projectId, 'Build the thing', 'a description', 'general', 'todo', 'medium', ['bucket:alpha', 'quick-win']],
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } finally {
      client.release();
    }
    await pool.end();
  });

  // ---- CONTEXTS ----------------------------------------------------------
  //
  // SEARCH CONSOLIDATION: the LITERAL context matcher
  // (buildSearchPredicate usage in ContextService.searchContexts) was DELETED.
  // ContextService.searchContexts is now a STRUCTURED-COLUMN BROWSE only — it NEVER
  // matches text/id/tag. Free-text context matching moved to the ONE engine
  // (mcp-server contextHandler.searchContext), reached via the backend proxy; its
  // coverage now lives in searchConsolidation.contract.test.ts (paraphrase/semantic)
  // + contextSearchAdapter.test.ts (arg routing incl. looksLikeId → by-id). Tasks
  // are NOT embedded, so literal task search correctly still uses the shared
  // predicate (the TASKS section below is unchanged).

  it('context BROWSE: a free-text query does NOT match/narrow (matching moved to the engine)', async () => {
    // The old path treated `query` as an id/tag/content matcher. Browse now IGNORES
    // it — proving the literal matcher is gone from this service. Both project rows
    // come back regardless of the "query" text.
    const res = await ContextService.searchContexts({ query: 'CANONICAL', scope: projectsScope([projectId])});
    const ids = res.contexts.map((c) => c.id);
    expect(ids).toContain(ctxIdA);
    expect(ids).toContain(ctxIdB); // NOT filtered out by the text — browse returns all
  });

  it('context BROWSE: structured type filter still narrows (no text matching)', async () => {
    const res = await ContextService.searchContexts({ type: 'milestone', scope: projectsScope([projectId])});
    const ids = res.contexts.map((c) => c.id);
    expect(ids).toContain(ctxIdA);       // the milestone
    expect(ids).not.toContain(ctxIdB);   // the discussion
  });

  it('context BROWSE: exact-tag chip filter narrows to rows carrying that tag', async () => {
    const res = await ContextService.searchContexts({ tags: ['ref:resume'], scope: projectsScope([projectId])});
    const ids = res.contexts.map((c) => c.id);
    expect(ids).toContain(ctxIdA);
    expect(ids).not.toContain(ctxIdB);
  });

  // ---- TASKS -------------------------------------------------------------

  it('task: full UUID returns the exact task', async () => {
    const res = await TaskService.getTasks({ search: taskIdA, scope: projectsScope([projectId])});
    expect(res.tasks.map((t) => t.id)).toContain(taskIdA);
  });

  it('task: hex id-prefix returns the exact task', async () => {
    const res = await TaskService.getTasks({ search: taskIdA.slice(0, 8), scope: projectsScope([projectId])});
    expect(res.tasks.map((t) => t.id)).toContain(taskIdA);
  });

  it('task: partial-tag "bucket" returns the bucket-tagged task', async () => {
    const res = await TaskService.getTasks({ search: 'bucket', scope: projectsScope([projectId])});
    expect(res.tasks.map((t) => t.id)).toContain(taskIdA);
  });

  it('task: title content search still works (no regression)', async () => {
    const res = await TaskService.getTasks({ search: 'Build the thing', scope: projectsScope([projectId])});
    expect(res.tasks.map((t) => t.id)).toContain(taskIdA);
  });
});
