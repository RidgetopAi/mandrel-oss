/**
 * DB-integration test for the TYPED-EDGE (TreeWalker) "thread box" behind
 * GET /api/decisions/:id/links — exercised through the SHARED resolver
 * (LinkService.getLinksForRecord), the same one context + task links delegate to.
 *
 * Proves a DECISION's thread resolves REAL rows from the `links` table (migration 049) in
 * BOTH directions: an INCOMING `decided_by` from a context (what the decision decided) and
 * an OUTGOING `caused` to a task (what it caused), each resolved to the other endpoint's
 * title + kind by joining that endpoint's own table. We SEED the exact edges here and
 * assert them back — this is structure, NOT the semantic `related` list, so it must never
 * depend on embeddings. Also asserts the empty case (a decision with no edges).
 *
 * Inserts into a throwaway test project and cleans up. Gated by describeDb
 * (helpers/dbContractGate): it RUNS whenever Postgres is reachable and FAILS
 * LOUDLY when it is not — it never silently skips in a gate.
 *
 * Run against a provisioned throwaway DB — PROVISION FIRST (that step runs migrate and
 * creates the `links` table); a bare `--print-env` does NOT migrate, so eval-ing it alone
 * yields `relation "links" does not exist`. Creds are deterministic per dbname, so the
 * two calls agree:
 *   bash scripts/provision-test-db.sh ci_declinks_fm             # create + MIGRATE
 *   eval "$(bash scripts/provision-test-db.sh ci_declinks_fm --print-env)"  # export DATABASE_* creds
 *   npm test -- decisionLinks
 *   bash scripts/provision-test-db.sh ci_declinks_fm --drop      # teardown
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { LinkService } from '../services/links';
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



describeDb('LinkService.getLinksForRecord — decision typed-edge thread (DB integration)', () => {
  let pool: Pool;
  let projectId: string;

  // The subject DECISION whose thread we read, plus the two endpoints it links to.
  let decisionId: string; // the reader's decision
  let ctxId: string; // ctx --decided_by--> decision (INCOMING for the decision)
  let taskId: string; // decision --caused--> task (OUTGOING for the decision)

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    projectId = uuidv4();
    decisionId = uuidv4();
    ctxId = uuidv4();
    taskId = uuidv4();

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [projectId, `declinks-test-${projectId.slice(0, 8)}`, 'decision links test', 'active'],
      );

      // The subject decision (the one being read).
      await client.query(
        `INSERT INTO technical_decisions
           (id, project_id, decision_type, title, description, rationale, impact_level, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          decisionId,
          projectId,
          'architecture',
          'Sessions page — a live stream = (actor x project) as a view',
          'the live stream view decision',
          'derived view over atomic activity',
          'medium',
          '{}',
        ],
      );
      // A context this decision DECIDED (incoming decided_by edge).
      await client.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [ctxId, projectId, 'milestone', 'Sessions screen mock LOCKED — live streams\nsecond line ignored', ['sessions-mock']],
      );
      // A task this decision CAUSED (outgoing caused edge).
      await client.query(
        `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [taskId, projectId, 'Serialize actor on session read', 'a description', 'general', 'todo', 'medium', []],
      );

      // The two typed edges (real `links` rows). One INCOMING for the decision (a context is
      // decided_by it → from=context, to=decision), one OUTGOING (decision caused a task →
      // from=decision, to=task).
      const edges: Array<[string, string, string, string, string]> = [
        [ctxId, 'context', decisionId, 'decision', 'decided_by'],
        [decisionId, 'decision', taskId, 'task', 'caused'],
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

  it('returns both real edges touching the decision (both directions)', async () => {
    const links = await LinkService.getLinksForRecord(decisionId);
    expect(links).toHaveLength(2);
  });

  it('resolves the INCOMING decided_by edge to the context it decided (first line + context_type kind)', async () => {
    const links = await LinkService.getLinksForRecord(decisionId);
    const edge = links.find((l) => l.edgeType === 'decided_by');
    expect(edge).toBeDefined();
    expect(edge).toMatchObject({
      direction: 'incoming',
      otherId: ctxId,
      otherType: 'context',
      otherTitle: 'Sessions screen mock LOCKED — live streams',
      otherKind: 'milestone', // the context's context_type
    });
  });

  it('resolves the OUTGOING caused edge to the task title + kind', async () => {
    const links = await LinkService.getLinksForRecord(decisionId);
    const edge = links.find((l) => l.edgeType === 'caused');
    expect(edge).toMatchObject({
      direction: 'outgoing',
      otherId: taskId,
      otherType: 'task',
      otherTitle: 'Serialize actor on session read',
      otherKind: 'task',
    });
  });

  it('returns an empty array for a decision with no edges', async () => {
    const lonely = uuidv4();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO technical_decisions
           (id, project_id, decision_type, title, description, rationale, impact_level, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [lonely, projectId, 'process', 'a lonely decision', 'no edges', 'no rationale', 'low', '{}'],
      );
      const links = await LinkService.getLinksForRecord(lonely);
      expect(links).toEqual([]);
    } finally {
      await client.query('DELETE FROM technical_decisions WHERE id = $1', [lonely]);
      client.release();
    }
  });
});
