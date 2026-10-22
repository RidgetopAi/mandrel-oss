/**
 * DB-integration test for TaskService.getTaskLinks — the TYPED-EDGE (TreeWalker)
 * "build story" data behind GET /api/tasks/:id/links.
 *
 * Proves the endpoint returns REAL rows from the `links` table (migration 049), in BOTH
 * directions, resolved to each other endpoint's title + kind by joining the endpoint's
 * own table (contexts / technical_decisions / tasks). We SEED the exact edges here (no
 * faked shape) and assert them back — this is structure, NOT the task's `dependencies`
 * array and NOT any semantic list, so it must never depend on embeddings.
 *
 * Inserts into a throwaway test project and cleans up. Gated by describeDb
 * (helpers/dbContractGate): it RUNS whenever Postgres is reachable and FAILS
 * LOUDLY when it is not — it never silently skips in a gate.
 *
 * Run against a provisioned throwaway DB — PROVISION FIRST (that step runs migrate and
 * creates the `links` table); a bare `--print-env` does NOT migrate, so eval-ing it alone
 * yields `relation "links" does not exist`. Creds are deterministic per dbname, so the
 * two calls agree:
 *   bash scripts/provision-test-db.sh ci_tasklinks_fm             # create + MIGRATE
 *   eval "$(bash scripts/provision-test-db.sh ci_tasklinks_fm --print-env)"  # export DATABASE_* creds
 *   npm test -- taskLinks
 *   bash scripts/provision-test-db.sh ci_tasklinks_fm --drop      # teardown
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TaskService } from '../services/task';
import { describeDb } from './helpers/dbContractGate';

/**
 * links.mint_via is NOT NULL since migration 085 (SK4): every edge
 * names the path that minted it. These fixtures stand in for hand-made `link` tool calls,
 * so they carry that path's via. The vocabulary's home is the MCP server
 * (mcp-server/src/config/edgeProvenanceConfig.ts, EDGE_MINT_VIA); this package reads the
 * links table but never mints into it, so it holds no copy of the vocabulary — only the one
 * value its fixtures need.
 */
const MINT_VIA_FIXTURE = 'link-tool';



describeDb('TaskService.getTaskLinks — typed-edge build story (DB integration)', () => {
  let pool: Pool;
  let projectId: string;

  // The subject task whose thread we read, plus the three endpoints it links to.
  let subjectId: string; // the task being read
  let decisionId: string; // subject --decided_by--> decision (outgoing)
  let contextId: string; // subject --produced_outcome--> context (outgoing)
  let otherTaskId: string; // otherTask --informs--> subject (incoming)

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    projectId = uuidv4();
    subjectId = uuidv4();
    decisionId = uuidv4();
    contextId = uuidv4();
    otherTaskId = uuidv4();

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [projectId, `tasklinks-test-${projectId.slice(0, 8)}`, 'task links test', 'active'],
      );

      // The subject task (the one being read).
      await client.query(
        `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [subjectId, projectId, 'Size-aware dispatch timeout', 'a description', 'feature', 'in_progress', 'high', []],
      );
      // The other task that INFORMS the subject (incoming edge).
      await client.query(
        `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [otherTaskId, projectId, 'Runtime tick auto-builds tagged todos', 'x', 'feature', 'completed', 'medium', []],
      );
      // A technical decision the subject was decided_by (outgoing edge).
      await client.query(
        `INSERT INTO technical_decisions
           (id, project_id, decision_type, title, description, rationale, impact_level, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          decisionId,
          projectId,
          'architecture',
          'Dispatch timeout scales with task size',
          'the timeout decision',
          'large tasks need longer budgets',
          'high',
          '{}',
        ],
      );
      // A context the subject produced (outgoing edge).
      await client.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [contextId, projectId, 'completion', 'Size-aware dispatch timeout shipped\nsecond line ignored', ['runtime']],
      );

      // The three typed edges (real `links` rows). Two OUTGOING (subject is from_id),
      // one INCOMING (subject is to_id).
      const edges: Array<[string, string, string, string, string]> = [
        [subjectId, 'task', decisionId, 'decision', 'decided_by'],
        [subjectId, 'task', contextId, 'context', 'produced_outcome'],
        [otherTaskId, 'task', subjectId, 'task', 'informs'],
      ];
      for (const [fromId, fromType, toId, toType, edgeType] of edges) {
        await client.query(
          `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [fromId, fromType, toId, toType, edgeType, projectId, 'link', MINT_VIA_FIXTURE],
        );
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } finally {
      client.release();
    }
    await pool.end();
  });

  it('returns all three real edges touching the subject (both directions)', async () => {
    const links = await TaskService.getTaskLinks(subjectId);
    expect(links).toHaveLength(3);
  });

  it('resolves the OUTGOING decided_by edge to the decision title + kind', async () => {
    const links = await TaskService.getTaskLinks(subjectId);
    const edge = links.find((l) => l.edgeType === 'decided_by');
    expect(edge).toBeDefined();
    expect(edge).toMatchObject({
      direction: 'outgoing',
      otherId: decisionId,
      otherType: 'decision',
      otherTitle: 'Dispatch timeout scales with task size',
      otherKind: 'decision',
    });
  });

  it('resolves the OUTGOING produced_outcome edge to the context (first content line + context_type kind)', async () => {
    const links = await TaskService.getTaskLinks(subjectId);
    const edge = links.find((l) => l.edgeType === 'produced_outcome');
    expect(edge).toMatchObject({
      direction: 'outgoing',
      otherId: contextId,
      otherType: 'context',
      otherTitle: 'Size-aware dispatch timeout shipped',
      otherKind: 'completion', // the context's context_type
    });
  });

  it('resolves the INCOMING informs edge to the other task title + kind', async () => {
    const links = await TaskService.getTaskLinks(subjectId);
    const edge = links.find((l) => l.edgeType === 'informs');
    expect(edge).toMatchObject({
      direction: 'incoming',
      otherId: otherTaskId,
      otherType: 'task',
      otherTitle: 'Runtime tick auto-builds tagged todos',
      otherKind: 'task',
    });
  });

  it('returns an empty array for a task with no edges', async () => {
    const lonely = uuidv4();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [lonely, projectId, 'no edges here', 'x', 'general', 'todo', 'low', []],
      );
      const links = await TaskService.getTaskLinks(lonely);
      expect(links).toEqual([]);
    } finally {
      await client.query('DELETE FROM tasks WHERE id = $1', [lonely]);
      client.release();
    }
  });
});
