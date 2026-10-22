/**
 * DB-integration test for the TreeWalker thread endpoint service (services/treewalker.ts) —
 * proves the REAL traversal + trust SQL against a live, migrated schema (the `links` table
 * migration 049 + contexts/technical_decisions/tasks). We SEED a canonical little thread and
 * assert the shaped ThreadGraph back: anchor resolution from the `ref:resume` tag, ~2-hop BFS
 * (both directions), grounded CANONICAL trust (PHASE 2 item e, an earlier task — the same
 * bands the mcp-server surfaces render: fresh decision with a successful outcome → trusted,
 * cold-start records → unproven, a declared-superseded record → superseded), and the
 * CANONICAL recall_thread story order (anchor pinned first, causal rank, temporal).
 * Fixture dates are RELATIVE to the clock — freshness is part of the canonical model, so
 * fixed dates would rot the expected bands.
 *
 * Structure mirrors decisionLinks.db.test.ts. Skipped when describeDb's explicit local opt-out. Run against a PROVISIONED throwaway DB (provision FIRST — it migrates + creates
 * the `links` table):
 *   bash scripts/provision-test-db.sh ci_tw_fm
 *   eval "$(bash scripts/provision-test-db.sh ci_tw_fm --print-env)"
 *   npm test -- treewalker.db
 *   bash scripts/provision-test-db.sh ci_tw_fm --drop
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TreeWalkerService, AnchorNotFoundError } from '../services/treewalker';
import { TREEWALKER_CONFIG } from '../config/treewalkerConfig';
import { describeDb } from './helpers/dbContractGate';
import { allProjects, projectsScope } from '../services/projectListScope';

/**
 * links.mint_via is NOT NULL since migration 085 (SK4): every edge
 * names the path that minted it. These fixtures stand in for hand-made `link` tool calls,
 * so they carry that path's via. The vocabulary's home is the MCP server
 * (mcp-server/src/config/edgeProvenanceConfig.ts, EDGE_MINT_VIA); this package reads the
 * links table but never mints into it, so it holds no copy of the vocabulary — only the one
 * value its fixtures need.
 */
const MINT_VIA_FIXTURE = 'link-tool';



describeDb('TreeWalkerService — thread graph (DB integration)', () => {
  let pool: Pool;
  let projectId: string;

  const anchorId = uuidv4(); // resume handoff context (the anchor)
  const spineId = uuidv4(); // command-redesign task (the spine; inherits the decision outcome)
  const decId = uuidv4(); // design-language decision (fresh + successful → trusted)
  const ctxAId = uuidv4(); // feeder context (informs spine)
  const ctxBId = uuidv4(); // feeder context (informs spine)
  const nextId = uuidv4(); // open todo task (the "next" step)
  const priorId = uuidv4(); // prior handoff, declared-SUPERSEDED by the resume anchor

  /** ISO date N days ago — the canonical model decays freshness, so dates are relative. */
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    projectId = uuidv4();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [projectId, `tw-test-${projectId.slice(0, 8)}`, 'treewalker test', 'active'],
      );

      // Contexts: the resume anchor (newest), two feeders, and a prior (superseded) handoff.
      const ctxRows: Array<[string, string, string, string[], string]> = [
        [anchorId, 'handoff', '★ Handoff — resume here; TreeWalker next', ['ref:resume', 'tree:mandrel-product'], daysAgo(1)],
        [ctxAId, 'milestone', 'Sessions locked — live streams', ['sessions'], daysAgo(10)],
        [ctxBId, 'milestone', 'Decisions locked — the why ledger', ['decisions'], daysAgo(7)],
        [priorId, 'handoff', 'Prior handoff — earlier resume', ['ref:resume'], daysAgo(13)],
      ];
      for (const [id, type, content, tags, createdAt] of ctxRows) {
        await client.query(
          `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, projectId, type, content, tags, createdAt],
        );
      }

      // Decision (successful outcome → proven).
      await client.query(
        `INSERT INTO technical_decisions
           (id, project_id, decision_type, title, description, rationale, impact_level, status, outcome_status, decision_date, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [decId, projectId, 'architecture', 'Visual design language LOCKED', 'desc', 'rationale', 'high', 'active', 'successful', daysAgo(25), '{}'],
      );

      // Tasks: the spine (in_progress) + a next (todo).
      const taskRows: Array<[string, string, string, string]> = [
        [spineId, 'Command UI redesign — mocks', 'in_progress', daysAgo(14)],
        [nextId, 'Design the TreeWalker page', 'todo', daysAgo(5)],
      ];
      for (const [id, title, status, createdAt] of taskRows) {
        await client.query(
          `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, projectId, title, 'a description', 'general', status, 'medium', [], createdAt],
        );
      }

      // Edges (real `links` rows): anchor→spine (informs), spine→dec (decided_by),
      // ctxA/ctxB→spine (informs), spine→next (informs), anchor→prior (supersedes).
      const edges: Array<[string, string, string, string, string]> = [
        [anchorId, 'context', spineId, 'task', 'informs'],
        [spineId, 'task', decId, 'decision', 'decided_by'],
        [ctxAId, 'context', spineId, 'task', 'informs'],
        [ctxBId, 'context', spineId, 'task', 'informs'],
        [spineId, 'task', nextId, 'task', 'informs'],
        [anchorId, 'context', priorId, 'context', 'supersedes'],
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

  it('resolves the NEWEST ref:resume context as the anchor (project-scoped)', async () => {
    const resolved = await TreeWalkerService.resolveAnchorId(projectsScope([projectId]), TREEWALKER_CONFIG, pool);
    expect(resolved).toBe(anchorId); // 2026-07-14 anchor, not the 2026-07-01 prior
  });

  it('walks the thread ~2 hops both directions and shapes the full graph', async () => {
    const graph = await TreeWalkerService.getThread({ scope: projectsScope([projectId]) }, TREEWALKER_CONFIG, pool);
    expect(graph.anchor.anchorId).toBe(anchorId);
    // anchor + spine + dec + ctxA + ctxB + next + prior = 7 records.
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids).toEqual(new Set([anchorId, spineId, decId, ctxAId, ctxBId, nextId, priorId]));
    expect(graph.nodes.find((n) => n.id === spineId)?.isSpine).toBe(true);
    expect(graph.nodes.find((n) => n.id === anchorId)?.isCurrent).toBe(true);
  });

  it('derives the CANONICAL trust bands from real columns/edges (PHASE 2 item e)', async () => {
    const graph = await TreeWalkerService.getThread({ scope: projectsScope([projectId]) }, TREEWALKER_CONFIG, pool);
    const trust = (id: string) => graph.nodes.find((n) => n.id === id)?.trust;
    // Fresh decision carrying its OWN successful outcome → trusted (outcome + freshness).
    expect(trust(decId)).toBe('trusted');
    // The spine INHERITS the decision's outcome over its decided_by edge (the moat path)
    // → trusted too. Its own in_progress status is not evidence (canonical).
    expect(trust(spineId)).toBe('trusted');
    expect(trust(anchorId)).toBe('unproven'); // fresh handoff, no outcome → cold-start
    // A `supersedes` edge with a non-adjudicator created_by is a DECLARED supersession —
    // the canonical hard cap is the `superseded` band (this used to read 'stale').
    expect(trust(priorId)).toBe('superseded');
    // ctxA/ctxB inform the spine, but do NOT have their OWN outcome edge to the decision,
    // so they stay unproven (honest — inheritance follows their own out-edges).
    expect(trust(ctxAId)).toBe('unproven');
  });

  it('feeder context that DOES have an outcome edge to a successful decision → trusted', async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
         VALUES ($1,'context',$2,'decision','informs',$3,'link','link-tool')`,
        [ctxAId, decId, projectId],
      );
      const graph = await TreeWalkerService.getThread({ scope: projectsScope([projectId]) }, TREEWALKER_CONFIG, pool);
      expect(graph.nodes.find((n) => n.id === ctxAId)?.trust).toBe('trusted');
    } finally {
      await client.query(
        `DELETE FROM links WHERE from_id = $1 AND to_id = $2 AND edge_type = 'informs'`,
        [ctxAId, decId],
      );
      client.release();
    }
  });

  it('orders the story CANONICALLY: anchor pinned first, then causal rank, then older-first', async () => {
    const graph = await TreeWalkerService.getThread({ scope: projectsScope([projectId]) }, TREEWALKER_CONFIG, pool);
    // Canonical recall_thread order (PHASE 2 item e, story half): the anchor is FIRST —
    // the old hand-made "why first" slot order is gone. prior precedes everything else
    // causally (supersedes is a reverse edge: the superseded came first), feeders precede
    // the spine, the spine precedes its decision and the next task.
    expect(graph.story[0].id).toBe(anchorId);
    expect(graph.story[0].marker).toBe('now');
    const markers = graph.story.map((s) => s.marker);
    expect(markers).toContain('decided');
    expect(markers).toContain('next');
    expect(graph.story.find((s) => s.marker === 'decided')?.id).toBe(decId);
    expect(graph.story.find((s) => s.marker === 'next')?.id).toBe(nextId);
    // Rank order after the anchor: prior (deepest upstream) before the feeders, feeders
    // (older ctxA before ctxB) before the spine, spine before decision/next.
    expect(graph.story.map((s) => s.id)).toEqual([anchorId, priorId, ctxAId, ctxBId, spineId, decId, nextId]);
  });

  it('throws AnchorNotFoundError for an explicit anchor that resolves to nothing', async () => {
    await expect(
      TreeWalkerService.getThread({ scope: allProjects, anchorId: uuidv4() }, TREEWALKER_CONFIG, pool),
    ).rejects.toBeInstanceOf(AnchorNotFoundError);
  });
});
