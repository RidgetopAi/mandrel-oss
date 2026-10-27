/**
 * DB-integration tests for the PHASE 2 derived tiers:
 *   (a) getTrunk        — the handoff TIMELINE: created_at ordering ALWAYS, full count,
 *                         supersedes as per-entry CORROBORATION only.
 *   (b) getRootDoc      — the newest live `ref:canonical`/`ref:north-star` context.
 *   (c) getBranches     — spines with MEMBERS via the branch_membership VIEW (the
 *                         branch_memberships table, migration 086 — one row per write,
 *                         keyed on the RECORDED position spine). Was the LOOSE
 *                         declared+informs predicate over link_provenance until SK2
 *.
 *                         (P1 'auto:positional' + tag/links-arg provenance), newest-active
 *                         first, named by the once-on-the-spine `branch:` tag else title,
 *                         open positions marked. A GUESSED-only spine must NOT appear —
 *                         that is the declared/guessed split the meter exists for.
 *
 * Seeds a throwaway project in the provisioned test DB (real migrated schema incl. the
 * 079/081 view + 080 branch_positions) and cleans up. Gated by describeDb: runs whenever
 * Postgres is reachable, fails loudly when not (never a silent skip in a gate).
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TreeWalkerTiersService } from '../services/treewalkerTiers';
import { projectsScope } from '../services/projectListScope';
import { describeDb } from './helpers/dbContractGate';

/**
 * links.mint_via is NOT NULL since migration 085 (SK4) and, since the
 * same migration, provenance_class (declared vs guessed) is GENERATED from it — which is what
 * TreeWalkerTiersService.getBranches filters on. So the via is NOT a constant here: this
 * suite's whole point is that a GUESSED edge does not surface a branch while DECLARED ones do,
 * and stamping every fixture row with one via would erase exactly that distinction. Each stamp
 * therefore carries the via its real minter passes. The vocabulary's home is the MCP server
 * (mcp-server/src/config/edgeProvenanceConfig.ts); this package reads the links table but never
 * mints into it, so it holds no copy — only the values its fixtures need.
 */
const MINT_VIA_FOR_STAMP: Record<string, string> = {
  'auto:handoff-supersession': 'handoff-timeline', // declared
  'auto:positional': 'position',                   // declared
  'auto:context_store': 'tag',                     // declared
  link: 'link-tool',                               // declared
  'auto:belief-adjudicator': 'belief-adjudication', // GUESSED
  'auto:inference': 'inference',                    // GUESSED
};
function mintViaFor(createdBy: string): string {
  const v = MINT_VIA_FOR_STAMP[createdBy];
  if (!v) throw new Error(`treewalkerTiers fixture: no mint_via mapped for stamp "${createdBy}"`);
  return v;
}


describeDb('TreeWalker derived tiers (PHASE 2, DB integration)', () => {
  let pool: Pool;
  let projectId: string;
  // Trunk: three handoffs, oldest→newest H1 H2 H3; corroboration edges H3→H2, H2→H1.
  let h1: string, h2: string, h3: string;
  // Roots: the canonical doc.
  let rootDocId: string;
  // Branches: named spine T (2 declared members, open), unnamed spine T2 (1 declared,
  // older), guessed-only spine T3 (must not appear).
  let tNamed: string, tUnnamed: string, tGuessed: string;
  let noteId: string;
  /** A tip-chained member of tNamed (attaches to h1, recorded branch tNamed). */
  let tipWrite: string;
  /**
   * CLAUSE 5: two ARCHIVED drawer spines, each a drawer by every other
   * test — position-minted members, nobody's member — differing from tNamed/tUnnamed only
   * in that their task row carries archived_at. M = 4 drawer-shaped spines, N = 2 archived,
   * so a correct getBranches reports total = 2 AND 2 rows. Before the fix the archived pair
   * rode through the `drawers` CTE into `count(*) OVER ()` and was then dropped from the
   * rows, giving total=4 with 2 rows — the dishonest denominator.
   */
  let tArchivedA: string, tArchivedB: string;
  /** The member records of the two archived spines (one each; PK is record_id). */
  let archivedMemberA: string, archivedMemberB: string;

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });
    projectId = uuidv4();
    [h1, h2, h3, rootDocId, tNamed, tUnnamed, tGuessed, noteId, tipWrite] = [
      uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(),
    ];
    [tArchivedA, tArchivedB, archivedMemberA, archivedMemberB] = [
      uuidv4(), uuidv4(), uuidv4(), uuidv4(),
    ];

    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'P2 tiers fixture', 'active', NOW())`,
        [projectId, `p2tiers-${Date.now()}`],
      );
      const ctx = (id: string, type: string, content: string, tags: string[], created: Date) =>
        c.query(
          `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, projectId, type, content, tags, created],
        );
      await ctx(h1, 'handoff', '★ HANDOFF one — oldest', [], daysAgo(3));
      await ctx(h2, 'handoff', '★ HANDOFF two — middle', [], daysAgo(2));
      await ctx(h3, 'handoff', '★ HANDOFF three — newest', [], daysAgo(1));
      await ctx(rootDocId, 'milestone', '★ CANONICAL — the north star doc', ['ref:canonical'], daysAgo(5));
      await ctx(noteId, 'discussion', 'a member note', [], daysAgo(1));
      await ctx(tipWrite, 'discussion', 'written on tNamed after its tip advanced', [], daysAgo(1));

      const task = (id: string, title: string, tags: string[]) =>
        c.query(
          `INSERT INTO tasks (id, project_id, title, status, type, tags, created_at)
           VALUES ($1, $2, $3, 'in_progress', 'feature', $4, NOW())`,
          [id, projectId, title, tags],
        );
      await task(tNamed, 'the spine record title', ['branch:phase2-test-branch']);
      await task(tUnnamed, 'unnamed-branch-spine', []);
      await task(tGuessed, 'guessed-only-spine', []);
      // CLAUSE 5: the same shape as tUnnamed in every respect EXCEPT archived_at. The
      // archive stamp is the ONLY difference, so a test that distinguishes them is
      // testing the liveness predicate and nothing else.
      const archivedTask = (id: string, title: string) =>
        c.query(
          `INSERT INTO tasks (id, project_id, title, status, type, tags, created_at, archived_at)
           VALUES ($1, $2, $3, 'completed', 'feature', '{}', NOW(), NOW())`,
          [id, projectId, title],
        );
      await archivedTask(tArchivedA, 'archived-drawer-spine-a');
      await archivedTask(tArchivedB, 'archived-drawer-spine-b');
      await ctx(archivedMemberA, 'discussion', 'a member of archived drawer a', [], daysAgo(4));
      await ctx(archivedMemberB, 'discussion', 'a member of archived drawer b', [], daysAgo(4));

      const link = (from: string, fromType: string, to: string, toType: string, edgeType: string, createdBy: string, created: Date) =>
        c.query(
          `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [from, fromType, to, toType, edgeType, projectId, createdBy, mintViaFor(createdBy), created],
        );
      // MEMBERSHIP IS ITS OWN ROW (branch_memberships, migration 086) — deliberately written
      // here as a SEPARATE act from the edge, because that is what it is in the product: the
      // positional edge can be deduped away by an earlier tag mint on the same triple, and
      // membership must not ride on it. `spine` is the BRANCH (the position's ROOT) and
      // `attachedTo` is where the edge points; they DIFFER when the branch advanced its tip,
      // which is the case this fixture exists to cover.
      const member = (
        recordId: string, recordType: string, spine: { id: string; type: string },
        attachedTo: { id: string; type: string }, created: Date,
      ) =>
        c.query(
          `INSERT INTO branch_memberships
             (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
              source, project_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'recorded', $7, $8)`,
          [recordId, recordType, spine.id, spine.type, attachedTo.id, attachedTo.type, projectId, created],
        );
      // Trunk corroboration (declared handoff-supersession chain — a LINE, not a web).
      await link(h3, 'context', h2, 'context', 'supersedes', 'auto:handoff-supersession', daysAgo(1));
      await link(h2, 'context', h1, 'context', 'supersedes', 'auto:handoff-supersession', daysAgo(2));
      // A SOFT (belief-adjudicator) supersession onto the NEWEST handoff: the trunk's
      // corroboration flag promises DECLARED, so this must NOT flip h3 (Reviewer NIT 1).
      //
      // an earlier change: this row used to be edge_type='supersedes' with the adjudicator stamp. That
      // combination is now UNWRITABLE — links_supersedes_declared_only (migration 087) rejects
      // any `supersedes` whose GENERATED provenance_class is not 'declared' — so the fixture
      // carries the channel an inferred supersession can actually occupy. The assertion is
      // unchanged and still discriminating: getTrunk's corroboration query matches on
      // edge_type='supersedes', so this row must not set h3.superseded either way.
      //
      // COVERAGE CHANGED: the `created_by IS DISTINCT FROM BELIEF_EDGE_CREATED_BY` clause in
      // treewalkerTiers.ts is no longer reachable by any writable row — the DB constraint now
      // guarantees what that clause was checking. It is left in place (it is the safety net if
      // 087 is rolled back) but it is dead-by-constraint and worth a follow-up.
      await link(noteId, 'context', h3, 'context', 'possibly_supersedes', 'auto:belief-adjudicator', daysAgo(1));
      // Declared members: two onto the NAMED spine (newest activity), one older onto the
      // unnamed spine. One GUESSED edge onto tGuessed — must not surface a branch.
      await link(h1, 'context', tNamed, 'task', 'informs', 'auto:positional', new Date());
      await member(h1, 'context', { id: tNamed, type: 'task' }, { id: tNamed, type: 'task' }, new Date());
      await link(noteId, 'context', tNamed, 'task', 'informs', 'auto:context_store', daysAgo(1));
      await link(h2, 'context', tUnnamed, 'task', 'informs', 'auto:positional', daysAgo(2));
      await member(h2, 'context', { id: tUnnamed, type: 'task' }, { id: tUnnamed, type: 'task' }, daysAgo(2));
      await link(noteId, 'context', tGuessed, 'task', 'informs', 'auto:inference', new Date());
      // A TIP-CHAINED member of tNamed: written while standing on tNamed AFTER its tip
      // advanced onto h1, so the edge ATTACHES to h1 while its recorded branch is tNamed.
      // This is the case the two surfaces used to disagree about — the walk in mcp-server
      // reached it and this GROUP BY did not. Both now key on the recorded spine.
      await link(tipWrite, 'context', h1, 'context', 'informs', 'auto:positional', new Date());
      await member(tipWrite, 'context', { id: tNamed, type: 'task' }, { id: h1, type: 'context' }, new Date());
      // CLAUSE 5: one position-minted member onto each ARCHIVED spine. These make
      // tArchivedA/B drawer-shaped in branch_membership (they have members, and nobody
      // has them as a member), which is precisely why they used to reach the total.
      await link(archivedMemberA, 'context', tArchivedA, 'task', 'informs', 'auto:positional', daysAgo(4));
      await member(archivedMemberA, 'context', { id: tArchivedA, type: 'task' }, { id: tArchivedA, type: 'task' }, daysAgo(4));
      await link(archivedMemberB, 'context', tArchivedB, 'task', 'informs', 'auto:positional', daysAgo(4));
      await member(archivedMemberB, 'context', { id: tArchivedB, type: 'task' }, { id: tArchivedB, type: 'task' }, daysAgo(4));
      // An open position on the named spine.
      await c.query(
        `INSERT INTO branch_positions (project_id, session_key, spine_id, spine_type, opened_at, updated_at)
         VALUES ($1, $2, $3, 'task', NOW(), NOW())`,
        [projectId, `p2tiers-session-${Date.now()}`, tNamed],
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM branch_positions WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM links WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.end();
  });

  it('(a) trunk: TIME orders (newest first), full count, head = newest handoff', async () => {
    const trunk = await TreeWalkerTiersService.getTrunk(projectsScope([projectId]), undefined, pool);
    expect(trunk.count).toBe(3);
    expect(trunk.headId).toBe(h3);
    expect(trunk.entries.map((e) => e.id)).toEqual([h3, h2, h1]);
    expect(trunk.entries[0].title).toBe('★ HANDOFF three — newest');
  });

  it('(a) supersession is DECLARED corroboration only — flags, never order; a soft (adjudicator) edge does not corroborate', async () => {
    const trunk = await TreeWalkerTiersService.getTrunk(projectsScope([projectId]), undefined, pool);
    // h3 carries a SOFT supersedes edge (auto:belief-adjudicator) and must stay FALSE —
    // the flag promises DECLARED (the canonical BL-4 split). h2/h1 carry declared
    // handoff-supersession edges → TRUE.
    expect(trunk.entries.map((e) => e.superseded)).toEqual([false, true, true]);
  });

  it('(b) roots resolve to the newest live root-tagged doc (id + title, from data)', async () => {
    const root = await TreeWalkerTiersService.getRootDoc(projectsScope([projectId]), undefined, pool);
    expect(root).toMatchObject({ id: rootDocId, title: '★ CANONICAL — the north star doc' });
  });

  it('(b) a project with no root-tagged doc resolves null (honest, no fake canonical)', async () => {
    const root = await TreeWalkerTiersService.getRootDoc(projectsScope([uuidv4()]), undefined, pool);
    expect(root).toBeNull();
  });

  it('(c) branch list: POSITION-minted members only, newest-active first, named by the spine tag else title, open marked', async () => {
    const { branches, total, cap } = await TreeWalkerTiersService.getBranches(projectsScope([projectId]), undefined, pool);
    expect(branches.map((b) => b.spineId)).toEqual([tNamed, tUnnamed]);
    expect(total).toBe(2);
    expect(cap).toBe(30); // TREEWALKER_CONFIG.branchListMax default, unchanged by P1
    expect(branches[0]).toMatchObject({
      name: 'phase2-test-branch', // the once-on-the-spine `branch:` tag — NOT the title
      named: true,
      // TWO things are being asserted by this one number, and each was a separate defect.
      //
      // 2 -> 1 (SK2 round 1). tNamed carries TWO declared informs edges pointing AT it, and
      // exactly one is membership: the 'auto:positional' one (mint_via 'position'). The
      // other is 'auto:context_store' (mint_via 'tag') — a record that NAMED this spine, not
      // one written while standing on it. This query counted both: measured on prod
      // 2026-08-15, an earlier spine reported 17 members against a true 9, corpus 1979 vs 77.
      //
      // 1 -> 2 (SK2 round 2). `tipWrite` was written while standing on tNamed after its tip
      // advanced, so its edge points at h1 and NOT at tNamed. This GROUP BY keys on
      // branch_memberships.spine_id (migration 086), so it is counted here without any
      // traversal — the residual divergence between this surface and branch_history is
      // closed, and closed by the stored value rather than by two walkers agreeing.
      members: 2,
      open: true,
      spineType: 'task',
      isTopLevel: true, // neither fixture spine is itself anyone's member
      sectionCount: 0, // none of tNamed's members are themselves branch spines
    });
    expect(branches[1]).toMatchObject({
      name: 'unnamed-branch-spine', // no name tag → the spine's own title
      named: false,
      members: 1,
      open: false,
      isTopLevel: true,
      sectionCount: 0,
    });
    // The guessed-only spine is ABSENT — a guessed edge is not membership.
    expect(branches.map((b) => b.spineId)).not.toContain(tGuessed);
  });

  it('(c) the DECLARED-but-not-POSITIONAL edge is the one this list used to over-count', async () => {
    // The differential, asserted directly rather than left implicit in a count above: the
    // loose predicate this query used to run still matches strictly MORE rows than the
    // membership predicate it runs now. If somebody re-inlines the loose predicate, the
    // count above changes and this row explains why.
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM branch_membership WHERE spine_id = $1) AS precise,
              (SELECT count(*)::int FROM links
                WHERE to_id = $1 AND provenance_class = 'declared' AND edge_type = 'informs') AS loose`,
      [tNamed],
    );
    expect(rows[0].precise).toBe(2);
    expect(rows[0].loose).toBe(2);
  });

  it('(c) the tip-chained member is NOT also listed as a branch of its own', async () => {
    // The over-count the round-1 walk produced, asserted from the other side. `tipWrite`
    // attaches to h1, so under a to_id-keyed view h1 would surface as its own branch with
    // one member. Keyed on the recorded membership row, h1 is not a branch at all — nobody
    // ever stood on it — and the write that attached to it belongs to tNamed.
    const { branches } = await TreeWalkerTiersService.getBranches(projectsScope([projectId]), undefined, pool);
    expect(branches.map((b) => b.spineId)).not.toContain(h1);
    expect(branches.map((b) => b.spineId)).toEqual([tNamed, tUnnamed]);
  });

  it('(c) CLAUSE 5: archiving N of M drawers removes them from the TOTAL as well as the rows', async () => {
    // The arithmetic the count line depends on, asserted as arithmetic rather than as two
    // magic numbers: M drawer-shaped spines exist in this project, N of them are archived,
    // so an honest getBranches reports total = M - N and returns exactly M - N rows.
    const { rows } = await pool.query(
      `WITH scoped AS (
         SELECT spine_id, member_id FROM branch_membership WHERE project_id = $1
       )
       SELECT count(*)::int AS m
         FROM (SELECT DISTINCT spine_id FROM scoped) d
        WHERE NOT EXISTS (SELECT 1 FROM scoped s WHERE s.member_id = d.spine_id)`,
      [projectId],
    );
    const M = rows[0].m as number;
    const N = 2; // tArchivedA, tArchivedB
    expect(M).toBe(4); // tNamed, tUnnamed, tArchivedA, tArchivedB — all drawer-shaped

    const { branches, total, cap } = await TreeWalkerTiersService.getBranches(
      projectsScope([projectId]), undefined, pool,
    );
    // No cap is in play (4 << 30), so total MUST equal the row count: any gap here is a
    // count line claiming drawers the user can never reach.
    expect(M).toBeLessThan(cap);
    expect(total).toBe(M - N);
    expect(branches).toHaveLength(M - N);
    expect(total).toBe(branches.length);
    // And the archived spines are absent from the rows, in both directions.
    expect(branches.map((b) => b.spineId)).not.toContain(tArchivedA);
    expect(branches.map((b) => b.spineId)).not.toContain(tArchivedB);
  });

  it('(c) the empty population: a project with no members lists no branches, honest zero total', async () => {
    const result = await TreeWalkerTiersService.getBranches(projectsScope([uuidv4()]), undefined, pool);
    expect(result.branches).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.cap).toBe(30);
  });
});
