/**
 * DB-integration test for ContextService.getContextLinks — the TYPED-EDGE (TreeWalker)
 * "thread box" data behind GET /api/contexts/:id/links.
 *
 * Proves the endpoint returns REAL rows from the `links` table (migration 049), in BOTH
 * directions, resolved to each other endpoint's title + kind by joining the endpoint's
 * own table (contexts / technical_decisions / tasks). We SEED the exact edges here (no
 * faked shape) and assert them back — this is structure, NOT the semantic `related`
 * list, so it must never depend on embeddings.
 *
 * Inserts into a throwaway test project and cleans up. Gated by describeDb
 * (helpers/dbContractGate): it RUNS whenever Postgres is reachable and FAILS
 * LOUDLY when it is not — it never silently skips in a gate.
 *
 * Run against a provisioned throwaway DB — PROVISION FIRST (that step runs migrate and
 * creates the `links` table); a bare `--print-env` does NOT migrate, so eval-ing it alone
 * yields `relation "links" does not exist`. Creds are deterministic per dbname, so the
 * two calls agree:
 *   bash scripts/provision-test-db.sh ci_ctxlinks_fm             # create + MIGRATE
 *   eval "$(bash scripts/provision-test-db.sh ci_ctxlinks_fm --print-env)"  # export DATABASE_* creds
 *   npm test -- contextLinks
 *   bash scripts/provision-test-db.sh ci_ctxlinks_fm --drop      # teardown
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { ContextService } from '../services/context';
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



describeDb('ContextService.getContextLinks — typed-edge thread (DB integration)', () => {
  let pool: Pool;
  let projectId: string;

  // The subject context whose thread we read, plus the three endpoints it links to.
  let subjectId: string; // the reader's context
  let decisionId: string; // subject --decided_by--> decision (outgoing)
  let taskId: string; // subject --informs--> task (outgoing)
  let otherCtxId: string; // otherCtx --supersedes--> subject (incoming)

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
    taskId = uuidv4();
    otherCtxId = uuidv4();

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [projectId, `ctxlinks-test-${projectId.slice(0, 8)}`, 'context links test', 'active'],
      );

      // The subject context (the one being read).
      await client.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [subjectId, projectId, 'milestone', 'Sessions screen mock LOCKED\nsecond line ignored', ['sessions-mock']],
      );
      // The other context that SUPERSEDES the subject (incoming edge).
      await client.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [otherCtxId, projectId, 'decision', 'Dashboard screen mock LOCKED', ['dashboard-mock']],
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
          'Sessions page — live stream = (actor x project)',
          'the live stream view decision',
          'derived view over atomic activity',
          'high',
          '{}',
        ],
      );
      // A task the subject informs (outgoing edge).
      await client.query(
        `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [taskId, projectId, 'Serialize actor on session read', 'a description', 'general', 'todo', 'medium', []],
      );

      // The three typed edges (real `links` rows). Two OUTGOING (subject is from_id),
      // one INCOMING (subject is to_id).
      const edges: Array<[string, string, string, string, string]> = [
        [subjectId, 'context', decisionId, 'decision', 'decided_by'],
        [subjectId, 'context', taskId, 'task', 'informs'],
        [otherCtxId, 'context', subjectId, 'context', 'supersedes'],
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
      await client.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } finally {
      client.release();
    }
    await pool.end();
  });

  it('returns all three real edges touching the subject (both directions)', async () => {
    const links = await ContextService.getContextLinks(subjectId);
    expect(links).toHaveLength(3);
  });

  it('resolves the OUTGOING decided_by edge to the decision title + kind', async () => {
    const links = await ContextService.getContextLinks(subjectId);
    const edge = links.find((l) => l.edgeType === 'decided_by');
    expect(edge).toBeDefined();
    expect(edge).toMatchObject({
      direction: 'outgoing',
      otherId: decisionId,
      otherType: 'decision',
      otherTitle: 'Sessions page — live stream = (actor x project)',
      otherKind: 'decision',
    });
  });

  it('resolves the OUTGOING informs edge to the task title + kind', async () => {
    const links = await ContextService.getContextLinks(subjectId);
    const edge = links.find((l) => l.edgeType === 'informs');
    expect(edge).toMatchObject({
      direction: 'outgoing',
      otherId: taskId,
      otherType: 'task',
      otherTitle: 'Serialize actor on session read',
      otherKind: 'task',
    });
  });

  it('resolves the INCOMING supersedes edge to the other context (first content line + context_type kind)', async () => {
    const links = await ContextService.getContextLinks(subjectId);
    const edge = links.find((l) => l.edgeType === 'supersedes');
    expect(edge).toMatchObject({
      direction: 'incoming',
      otherId: otherCtxId,
      otherType: 'context',
      otherTitle: 'Dashboard screen mock LOCKED',
      otherKind: 'decision', // the other context's context_type
    });
  });

  it('returns an empty array for a context with no edges', async () => {
    const lonely = uuidv4();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO contexts (id, project_id, context_type, content, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [lonely, projectId, 'discussion', 'no edges here'],
      );
      const links = await ContextService.getContextLinks(lonely);
      expect(links).toEqual([]);
    } finally {
      await client.query('DELETE FROM contexts WHERE id = $1', [lonely]);
      client.release();
    }
  });
});
