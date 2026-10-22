/**
 * CONTRACT (P2, an earlier task — "select drawers before the cap"): a
 * section can never consume a branch-list page slot a genuine top-level drawer needed,
 * no matter how recently the section was active relative to that drawer.
 *
 * WHY THIS SUITE EXISTS, SEPARATELY FROM treewalkerBranchNesting.db.test.ts. That P1 suite's
 * fixture happens to have its lone unrelated top-level branch (`extra`) be the single
 * MOST-recently-active spine in the whole scope, so a cap tight enough to exercise the
 * mutation there never actually needs the P2 fix to pass — the old, buggy
 * mix-drawers-and-sections-then-LIMIT query would already keep `extra` on top by luck.
 * This suite's fixture is built the other way round on purpose: THREE sections are made
 * more recently active than a real top-level drawer, and the cap is set to exactly the
 * number of spines those three sections plus the shared parent would occupy — enough to
 * consume the whole limit before the older drawer ever gets a turn under the pre-P2 query
 * (`ORDER BY last_active DESC LIMIT $3` over drawers AND sections mixed together).
 *
 *   parentX   (top-level drawer; members: sectionA, sectionB, sectionC — all VERY recent)
 *     sectionA  (nested under parentX; itself a spine with 1 ordinary member, recent)
 *     sectionB  (nested under parentX; itself a spine with 1 ordinary member, recent)
 *     sectionC  (nested under parentX; itself a spine with 1 ordinary member, recent)
 *   drawerD   (a second, unrelated top-level drawer; 1 ordinary member, created DAYS ago —
 *              the oldest-active spine in the whole scope)
 *
 * Reverting the P2 fix in treewalkerTiers.ts (dropping the `drawers` CTE so `LIMIT $3` sits
 * on `totals`, mixing drawers and sections by recency again) turns this suite red: with
 * cap=3 the pre-P2 query's top 3 by last_active are [parentX, sectionA, sectionB] —
 * drawerD is evicted entirely, and a section (sectionA or sectionB) occupies a page slot.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TreeWalkerTiersService } from '../services/treewalkerTiers';
import { TREEWALKER_CONFIG } from '../config/treewalkerConfig';
import { projectsScope } from '../services/projectListScope';
import { describeDb } from './helpers/dbContractGate';

describeDb('TreeWalker branches: drawers are selected BEFORE the cap (P2)', () => {
  let pool: Pool;
  let projectId: string;
  let parentX: string, drawerD: string;
  let sectionA: string, sectionB: string, sectionC: string;
  let parentXLeaf: string, drawerDLeaf: string, aLeaf: string, bLeaf: string, cLeaf: string;

  const msAgo = (n: number) => new Date(Date.now() - n);
  const daysAgo = (n: number) => msAgo(n * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });
    projectId = uuidv4();
    [parentX, drawerD, sectionA, sectionB, sectionC, parentXLeaf, drawerDLeaf, aLeaf, bLeaf, cLeaf] = [
      uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(),
    ];

    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'P2 drawer-selection fixture', 'active', NOW())`,
        [projectId, `p2-drawer-selection-${Date.now()}`],
      );
      const task = (id: string, title: string) =>
        c.query(
          `INSERT INTO tasks (id, project_id, title, status, type, tags, created_at)
           VALUES ($1, $2, $3, 'in_progress', 'feature', '{}', NOW())`,
          [id, projectId, title],
        );
      const ctx = (id: string, content: string) =>
        c.query(
          `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
           VALUES ($1, $2, 'discussion', $3, '{}', NOW())`,
          [id, projectId, content],
        );
      await task(parentX, 'parentX — top-level drawer holding three sections');
      await task(drawerD, 'drawerD — a second, older top-level drawer');
      await task(sectionA, 'sectionA — nested under parentX, very recently active');
      await task(sectionB, 'sectionB — nested under parentX, very recently active');
      await task(sectionC, 'sectionC — nested under parentX, very recently active');
      await ctx(parentXLeaf, 'an ordinary member of parentX directly (not itself a spine)');
      await ctx(drawerDLeaf, 'the only member of drawerD');
      await ctx(aLeaf, 'the only member of sectionA');
      await ctx(bLeaf, 'the only member of sectionB');
      await ctx(cLeaf, 'the only member of sectionC');

      const member = (
        recordId: string, recordType: string, spine: { id: string; type: string }, created: Date,
      ) =>
        c.query(
          `INSERT INTO branch_memberships
             (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
              source, project_id, created_at)
           VALUES ($1, $2, $3, $4, $3, $4, 'recorded', $5, $6)`,
          [recordId, recordType, spine.id, spine.type, projectId, created],
        );
      // drawerD: the oldest-active spine in the whole scope — this is the drawer the P2
      // fix must still surface despite three much-more-recent sections elsewhere.
      await member(drawerDLeaf, 'context', { id: drawerD, type: 'task' }, daysAgo(30));
      // parentX's members: sectionA/B/C (each itself a spine) — all made VERY recent so
      // parentX and its sections dominate a recency-only ordering.
      await member(sectionC, 'task', { id: parentX, type: 'task' }, msAgo(1000));
      await member(sectionB, 'task', { id: parentX, type: 'task' }, msAgo(2000));
      await member(sectionA, 'task', { id: parentX, type: 'task' }, msAgo(3000));
      // sectionA/B/C are themselves spines (one ordinary member each) — this is what makes
      // them SECTIONS of parentX rather than plain leaves.
      await member(aLeaf, 'context', { id: sectionA, type: 'task' }, msAgo(4000));
      await member(bLeaf, 'context', { id: sectionB, type: 'task' }, msAgo(5000)); // reserved-port-ok: milliseconds-ago argument, not a port
      await member(cLeaf, 'context', { id: sectionC, type: 'task' }, msAgo(6000));
      // parentX's own last_active is driven by its newest member (sectionC, msAgo(1000)),
      // making parentX itself the single most-recently-active spine in the whole scope —
      // deliberately, so this fixture pins the SELECTION guarantee, not mere ordering.
      await member(parentXLeaf, 'context', { id: parentX, type: 'task' }, msAgo(1000));
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM branch_memberships WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.end();
  });

  it('uncapped: reports exactly the 2 true drawers (parentX, drawerD), sections excluded, total=2', async () => {
    const { branches, total, cap } = await TreeWalkerTiersService.getBranches(
      projectsScope([projectId]), undefined, pool,
    );
    expect(branches.map((b) => b.spineId).sort()).toEqual([drawerD, parentX].sort());
    expect(total).toBe(2);
    expect(cap).toBe(TREEWALKER_CONFIG.branchListMax);
  });

  it('CAPPED at exactly the section-crowd size: drawerD still survives despite 3 more-recent sections (the mutation clause)', async () => {
    // cap=3: under the PRE-P2 query (LIMIT sitting on drawers+sections mixed by
    // last_active), the top 3 most-recently-active spines in this scope are
    // [parentX, sectionC, sectionB] — drawerD (the oldest-active spine) is evicted
    // entirely and a section occupies a page slot. Under the FIXED query, sections never
    // enter the candidate pool at all, so the LIMIT applies only to the 2 real drawers
    // and drawerD is never at risk.
    const cappedConfig = { ...TREEWALKER_CONFIG, branchListMax: 3 };
    const { branches, total, cap } = await TreeWalkerTiersService.getBranches(
      projectsScope([projectId]), cappedConfig, pool,
    );
    expect(cap).toBe(3);
    expect(total).toBe(2); // still just the 2 drawers — total is never sections+drawers
    expect(branches.map((b) => b.spineId).sort()).toEqual([drawerD, parentX].sort());
    expect(branches.some((b) => b.spineId === drawerD)).toBe(true);
    expect(branches.some((b) => [sectionA, sectionB, sectionC].includes(b.spineId))).toBe(false);
  });

  it('CAPPED at 1: only the single newest DRAWER (parentX) survives — never a section standing in for it', async () => {
    const cappedConfig = { ...TREEWALKER_CONFIG, branchListMax: 1 };
    const { branches, total, cap } = await TreeWalkerTiersService.getBranches(
      projectsScope([projectId]), cappedConfig, pool,
    );
    expect(cap).toBe(1);
    expect(total).toBe(2);
    expect(branches.length).toBe(1);
    expect(branches[0].spineId).toBe(parentX); // parentX out-recencies drawerD among drawers
    expect(branches[0].isTopLevel).toBe(true);
    expect(branches[0].sectionCount).toBe(3); // sectionA, sectionB, sectionC
  });
});
