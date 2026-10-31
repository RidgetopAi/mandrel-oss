/**
 * DB-integration test for the TreeWalker BRANCH thread (services/treewalker.ts, thread v2)
 * — proves the REAL spine resolution, member/ghost/edge SQL and trust reads
 * against a live, migrated schema (links migration 049/085, branch_membership view 086).
 *
 * One fixture spine S with: a position member (a), a tag-minted declared `informs` context
 * (b), a decision D that (a) is decided_by and that is not a member, 40 unrelated contexts
 * decided_by D, guessed neighbours (inference related_to, belief-adjudication
 * possibly_supersedes), a handoff with a declared edge to S, an `alert:test` error with a
 * declared informs edge, and a `trunk-ref` informs edge. Plus a second project with a
 * NEWER branch to prove no anchor never crosses projects.
 * Fixture dates are RELATIVE to the clock — freshness is part of the canonical trust model.
 *
 * Run against a PROVISIONED throwaway DB:
 *   bash scripts/provision-test-db.sh ci_tw_fm
 *   eval "$(bash scripts/provision-test-db.sh ci_tw_fm --print-env)"
 *   npm test -- treewalker.db
 *   bash scripts/provision-test-db.sh ci_tw_fm --drop
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TreeWalkerService, AnchorNotFoundError } from '../services/treewalker';
import { TreeWalkerTiersService } from '../services/treewalkerTiers';
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



describeDb('TreeWalkerService — branch thread (DB integration)', () => {
  let pool: Pool;
  let projectId: string;
  let otherProjectId: string;

  const S = uuidv4(); // the spine (task)
  const A = uuidv4(); // position member (context)
  const B = uuidv4(); // tag-minted declared informs context
  const D = uuidv4(); // decision A is decided_by (NOT a member)
  const NOISE = Array.from({ length: 40 }, () => uuidv4()); // unrelated contexts decided_by D
  const GUESS_REL = uuidv4(); // inference related_to S
  const GUESS_SUP = uuidv4(); // belief-adjudication possibly_supersedes S
  const HANDOFF = uuidv4(); // handoff with a declared edge to S
  const ALERT = uuidv4(); // error tagged alert:test with a declared informs edge to S
  const TRUNKREF = uuidv4(); // declared but mint_via trunk-ref informs edge to S
  const OTHER_SPINE = uuidv4(); // other project's (newer) branch spine
  const OTHER_MEMBER = uuidv4();

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  const addContext = (id: string, pid: string, type: string, content: string, tags: string[], created: string) =>
    pool.query(
      `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, pid, type, content, tags, created],
    );
  const addTask = (id: string, pid: string, title: string, created: string) =>
    pool.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags, created_at)
       VALUES ($1,$2,$3,'d','general','in_progress','medium',$4,$5)`,
      [id, pid, title, ['branch:fixture'], created],
    );
  const addLink = (
    from: string, fromType: string, to: string, toType: string, edge: string, via: string, pid = projectId,
  ) =>
    pool.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
       VALUES ($1,$2,$3,$4,$5,$6,'link',$7)`,
      [from, fromType, to, toType, edge, pid, via],
    );
  const addMembership = (record: string, spine: string, pid: string, created: string) =>
    pool.query(
      `INSERT INTO branch_memberships
         (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type, source, project_id, created_at)
       VALUES ($1,'context',$2,'task',$2,'task','recorded',$3,$4)`,
      [record, spine, pid, created],
    );

  const threadIds = async (anchorId?: string) => {
    const g = await TreeWalkerService.getThread({ anchorId, scope: projectsScope([projectId]) }, TREEWALKER_CONFIG, pool);
    return { g, ids: new Set(g.nodes.map((n) => n.id)) };
  };

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });
    projectId = uuidv4();
    otherProjectId = uuidv4();
    for (const [id, name] of [[projectId, 'tw-test'], [otherProjectId, 'tw-other']]) {
      await pool.query(
        `INSERT INTO projects (id, name, description, status, created_at) VALUES ($1,$2,'treewalker test','active',NOW())`,
        [id, `${name}-${id.slice(0, 8)}`],
      );
    }

    await addTask(S, projectId, 'Fixture spine', daysAgo(30));
    await addContext(A, projectId, 'milestone', 'Position member', ['sessions'], daysAgo(10));
    await addContext(B, projectId, 'milestone', 'Tag-minted informs', ['sessions'], daysAgo(8));
    await pool.query(
      `INSERT INTO technical_decisions
         (id, project_id, decision_type, title, description, rationale, impact_level, status, outcome_status, decision_date, metadata)
       VALUES ($1,$2,'architecture','The hub decision','d','r','high','active','successful',$3,'{}')`,
      [D, projectId, daysAgo(20)],
    );
    for (const id of NOISE) await addContext(id, projectId, 'note', `noise ${id}`, [], daysAgo(5));
    await addContext(GUESS_REL, projectId, 'note', 'guessed related', [], daysAgo(4));
    await addContext(GUESS_SUP, projectId, 'note', 'guessed supersedes', [], daysAgo(3));
    await addContext(HANDOFF, projectId, 'handoff', 'a handoff', ['ref:resume'], daysAgo(2));
    await addContext(ALERT, projectId, 'error', 'an alert', ['alert:test'], daysAgo(1));
    await addContext(TRUNKREF, projectId, 'note', 'trunk-ref pointer', [], daysAgo(6));

    await addMembership(A, S, projectId, daysAgo(10));
    await addLink(A, 'context', S, 'task', 'informs', 'position');
    await addLink(B, 'context', S, 'task', 'informs', 'tag');
    await addLink(A, 'context', D, 'decision', 'decided_by', 'tag');
    for (const id of NOISE) await addLink(id, 'context', D, 'decision', 'decided_by', 'tag');
    await addLink(GUESS_REL, 'context', S, 'task', 'related_to', 'inference');
    await addLink(GUESS_SUP, 'context', S, 'task', 'possibly_supersedes', 'belief-adjudication');
    await addLink(HANDOFF, 'context', S, 'task', 'informs', 'tag');
    await addLink(ALERT, 'context', S, 'task', 'informs', 'tag');
    await addLink(TRUNKREF, 'context', S, 'task', 'informs', 'trunk-ref');

    // Another project with a NEWER branch — a no-anchor read scoped to `projectId` must never see it.
    await addTask(OTHER_SPINE, otherProjectId, 'Other project spine', daysAgo(2));
    await addContext(OTHER_MEMBER, otherProjectId, 'note', 'other member', [], daysAgo(1));
    await addMembership(OTHER_MEMBER, OTHER_SPINE, otherProjectId, daysAgo(1));
  });

  afterAll(async () => {
    for (const pid of [projectId, otherProjectId]) {
      await pool.query('DELETE FROM branch_memberships WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM projects WHERE id = $1', [pid]);
    }
    await pool.end();
  });

  it('(1) the thread for S is exactly S, a, b (inBranch) + D (ghost) — none of the 40, guesses, handoff, alert, trunk-ref', async () => {
    const { g, ids } = await threadIds(S);
    expect(ids).toEqual(new Set([S, A, B, D]));
    const by = (id: string) => g.nodes.find((n) => n.id === id);
    expect(by(S)?.inBranch).toBe(true);
    expect(by(A)?.inBranch).toBe(true);
    expect(by(B)?.inBranch).toBe(true);
    expect(by(D)?.inBranch).toBe(false);
    for (const gone of [...NOISE, GUESS_REL, GUESS_SUP, HANDOFF, ALERT, TRUNKREF]) expect(ids.has(gone)).toBe(false);
    expect(g.memberTotal).toBe(3);
    expect(g.truncated).toBe(false);
    expect(g.edges.length).toBeGreaterThan(0);
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
      expect(e.provenance).toBe('declared');
      expect(typeof e.mintVia).toBe('string');
    }
    expect(g.edges.find((e) => e.source === A && e.target === D)).toMatchObject({ edgeType: 'decided_by', mintVia: 'tag' });
  });

  it('nodes carry createdAt/inBranch and the kind-specific fields', async () => {
    const { g } = await threadIds(S);
    for (const n of g.nodes) expect(new Date(n.createdAt).toISOString()).toBe(n.createdAt);
    expect(g.nodes.find((n) => n.id === A)?.contextType).toBe('milestone');
    expect(g.nodes.find((n) => n.id === S)?.status).toBe('in_progress');
    expect(g.nodes.find((n) => n.id === D)?.outcomeStatus).toBe('successful');
    expect(g.anchor.anchorId).toBe(S);
    expect(g.nodes.find((n) => n.id === S)?.isSpine).toBe(true);
  });

  it('(2) a member anchor returns the same node set as the spine anchor', async () => {
    const fromSpine = await threadIds(S);
    const fromMember = await threadIds(A);
    expect(fromMember.ids).toEqual(fromSpine.ids);
    expect(fromMember.g.anchor.anchorId).toBe(S);
  });

  it('(2) a non-member, non-spine anchor is its own spine', async () => {
    const { g } = await threadIds(GUESS_REL);
    expect(g.anchor.anchorId).toBe(GUESS_REL);
  });

  it('(2) no anchor = the first branch GET /branches returns for the project, never another project', async () => {
    const branches = await TreeWalkerTiersService.getBranches(projectsScope([projectId]), TREEWALKER_CONFIG, pool);
    expect(branches.branches[0].spineId).toBe(S);
    const { g, ids } = await threadIds(undefined);
    expect(g.anchor.anchorId).toBe(branches.branches[0].spineId);
    expect(ids).toEqual(new Set([S, A, B, D]));
    expect(ids.has(OTHER_SPINE)).toBe(false);
    expect(ids.has(OTHER_MEMBER)).toBe(false);
  });

  it('(2) an anchor from another project is not found under this scope', async () => {
    await expect(
      TreeWalkerService.getThread({ anchorId: OTHER_SPINE, scope: projectsScope([projectId]) }, TREEWALKER_CONFIG, pool),
    ).rejects.toBeInstanceOf(AnchorNotFoundError);
  });

  it('a project with no branch returns the honest empty graph', async () => {
    const empty = uuidv4();
    await pool.query(`INSERT INTO projects (id, name, description, status, created_at) VALUES ($1,$2,'e','active',NOW())`, [empty, `tw-empty-${empty.slice(0, 8)}`]);
    try {
      const g = await TreeWalkerService.getThread({ scope: projectsScope([empty]) }, TREEWALKER_CONFIG, pool);
      expect(g.nodes).toEqual([]);
      expect(g.memberTotal).toBe(0);
    } finally {
      await pool.query('DELETE FROM projects WHERE id = $1', [empty]);
    }
  });

  it('a real maxMembers cap keeps the newest and reports the true total', async () => {
    const cfg = { ...TREEWALKER_CONFIG, maxMembers: 2 };
    const g = await TreeWalkerService.getThread({ anchorId: S, scope: projectsScope([projectId]) }, cfg, pool);
    expect(g.memberTotal).toBe(3);
    expect(g.truncated).toBe(true);
    // spine (oldest, pinned) + newest member B; A dropped.
    expect(new Set(g.nodes.filter((n) => n.inBranch).map((n) => n.id))).toEqual(new Set([S, B]));
  });

  it('a real maxGhosts of 0-effective cap never exceeds the limit', async () => {
    const cfg = { ...TREEWALKER_CONFIG, maxGhosts: 1 };
    const g = await TreeWalkerService.getThread({ anchorId: S, scope: projectsScope([projectId]) }, cfg, pool);
    expect(g.nodes.filter((n) => !n.inBranch).length).toBeLessThanOrEqual(1);
  });

  it('derives CANONICAL trust from real columns/edges', async () => {
    const { g } = await threadIds(S);
    const trust = (id: string) => g.nodes.find((n) => n.id === id)?.trust;
    expect(trust(D)).toBe('trusted'); // own successful outcome, still fresh
    expect(trust(A)).toBe('trusted'); // inherits the outcome over its declared decided_by edge
    expect(trust(B)).toBe('unproven'); // informs the spine only — no outcome edge of its own
  });

  it('throws AnchorNotFoundError for an explicit anchor that resolves to nothing', async () => {
    await expect(
      TreeWalkerService.getThread({ scope: allProjects, anchorId: uuidv4() }, TREEWALKER_CONFIG, pool),
    ).rejects.toBeInstanceOf(AnchorNotFoundError);
  });
});
