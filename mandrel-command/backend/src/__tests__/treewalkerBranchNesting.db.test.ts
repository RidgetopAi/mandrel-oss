/**
 * CONTRACT: the branches endpoint tells the truth about drawers vs sections (P1
 * , an earlier task — TreeWalker "a decision is the drawer"; SELECTION fixed in P2,
 * an earlier task — "select drawers before the cap").
 *
 * GET /api/treewalker/branches used to answer "which spines have members" and nothing
 * else: a nested spine (one that is ITSELF a member of some other branch) competed for the
 * same capped list slots as a genuine top-level drawer, and a caller had no way to tell a
 * truncated page from the whole population. P1 added the fields to tell drawers from
 * sections; P2 (this suite, updated) moved the filter INTO the query ahead of the LIMIT, so
 * a section no longer merely reports `isTopLevel: false` — it is absent from `branches`
 * entirely, and can never consume a page slot a genuine drawer needed. This suite pins that
 * directly against TreeWalkerTiersService.getBranches — no route/HTTP layer needed, since
 * the honesty lives entirely in the service's SQL and return shape:
 *
 *   - BranchSummary.isTopLevel  — ALWAYS true (P2): a section is filtered out of the query
 *     before it can ever reach this array, never merely flagged false on the way out.
 *   - BranchSummary.sectionCount — how many of THIS branch's own members are themselves
 *     branch spines (nested drawers), not how many members it has in total.
 *   - BranchListResult.total / .cap — the FULL DRAWER count for the scope (sections
 *     excluded, P2) and the limit that was actually applied, computed over the population
 *     BEFORE the LIMIT truncates the returned array.
 *
 * Fixture shape (all via branch_memberships, migration 086 — no `links` row needed, since
 * getBranches reads only branch_membership.{spine_id,spine_type,member_id,created_at}):
 *
 *   parent  (top-level, 3 members: childA, childB, leaf)
 *     childA (nested — a member of parent, and itself a spine with 1 member: grandA)
 *     childB (nested — a member of parent, and itself a spine with 1 member: grandB)
 *     leaf   (an ordinary member of parent — NOT itself a spine)
 *   extra   (a second, unrelated top-level branch with 1 ordinary member)
 *
 * So the scope holds 4 branch-shaped spines but only 2 are DRAWERS (parent, extra) — the
 * number every "honest total" assertion below is pinned against. childA/childB (sections)
 * are asserted ABSENT from `branches`, not merely flagged.
 *
 * Each assertion here FAILS against the pre-P1 code: BranchSummary carried no isTopLevel /
 * sectionCount field, and getBranches returned a bare BranchSummary[] with no total/cap —
 * so `{ branches, total, cap } = await getBranches(...)` destructures `branches` itself as
 * undefined and every field access throws or reads undefined. The nested-spine test also
 * fails against the P1-only code (pre-686a1698): there, childA/childB were PRESENT in
 * `branches` with `isTopLevel: false` rather than absent, and `total` counted all 4
 * spines rather than the 2 true drawers.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TreeWalkerTiersService, type BranchSummary } from '../services/treewalkerTiers';
import { TREEWALKER_CONFIG } from '../config/treewalkerConfig';
import { projectsScope } from '../services/projectListScope';
import { describeDb } from './helpers/dbContractGate';

describeDb('TreeWalker branches: isTopLevel / sectionCount / honest total+cap (P1)', () => {
  let pool: Pool;
  let projectId: string;
  let parent: string, childA: string, childB: string, extra: string;
  let leaf: string, grandA: string, grandB: string, extraLeaf: string;

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
    [parent, childA, childB, extra, leaf, grandA, grandB, extraLeaf] = [
      uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(),
    ];

    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'P1 branch-nesting fixture', 'active', NOW())`,
        [projectId, `p1-nesting-${Date.now()}`],
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
      await task(parent, 'parent — top-level drawer');
      await task(childA, 'childA — nested drawer under parent');
      await task(childB, 'childB — nested drawer under parent');
      await task(extra, 'extra — a second top-level drawer');
      await ctx(leaf, 'an ordinary member of parent, not itself a spine');
      await ctx(grandA, 'the only member of childA');
      await ctx(grandB, 'the only member of childB');
      await ctx(extraLeaf, 'the only member of extra');

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
      // parent's members — one of each shape: two nested spines + one ordinary leaf.
      await member(leaf, 'context', { id: parent, type: 'task' }, daysAgo(1));
      await member(childA, 'task', { id: parent, type: 'task' }, daysAgo(2));
      await member(childB, 'task', { id: parent, type: 'task' }, daysAgo(3));
      // childA / childB are themselves spines (each with exactly one ordinary member) —
      // this is what makes them SECTIONS of parent rather than plain leaves.
      await member(grandA, 'context', { id: childA, type: 'task' }, daysAgo(4));
      await member(grandB, 'context', { id: childB, type: 'task' }, daysAgo(5));
      // extra: unrelated second top-level branch, one ordinary member, newest activity —
      // exists purely to make the honest-total/cap assertions non-trivial (total > 1).
      await member(extraLeaf, 'context', { id: extra, type: 'task' }, new Date());
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

  it('a top-level spine with N spine-members reports isTopLevel true and sectionCount N', async () => {
    const { branches } = await TreeWalkerTiersService.getBranches(projectsScope([projectId]), undefined, pool);
    const byId = new Map(branches.map((b) => [b.spineId, b]));
    const p = byId.get(parent) as BranchSummary;
    expect(p).toBeDefined();
    expect(p.members).toBe(3); // childA, childB, leaf
    expect(p.isTopLevel).toBe(true); // parent is not anyone's member
    expect(p.sectionCount).toBe(2); // exactly childA and childB are themselves spines
  });

  it('a nested spine (a member of another branch) is EXCLUDED from branches entirely (P2)', async () => {
    const { branches } = await TreeWalkerTiersService.getBranches(projectsScope([projectId]), undefined, pool);
    const byId = new Map(branches.map((b) => [b.spineId, b]));
    // childA/childB ARE members of parent, so they are sections, not drawers — the P2 fix
    // filters them out of the query before the LIMIT, not merely flags them on the way out.
    expect(byId.has(childA)).toBe(false);
    expect(byId.has(childB)).toBe(false);
  });

  it('an unrelated top-level branch with only ordinary members reports isTopLevel true, sectionCount 0', async () => {
    const { branches } = await TreeWalkerTiersService.getBranches(projectsScope([projectId]), undefined, pool);
    const e = branches.find((b) => b.spineId === extra) as BranchSummary;
    expect(e).toBeDefined();
    expect(e.isTopLevel).toBe(true);
    expect(e.sectionCount).toBe(0);
    expect(e.members).toBe(1);
  });

  it('the totals field reports the TRUE DRAWER count for the scope, uncapped (sections excluded, P2 an earlier task)', async () => {
    const { branches, total, cap } = await TreeWalkerTiersService.getBranches(projectsScope([projectId]), undefined, pool);
    // 4 spines carry members in this scope, but only 2 are top-level DRAWERS: parent, extra.
    // childA/childB are sections of parent and do not count toward `total` any more than
    // they appear in `branches`.
    expect(total).toBe(2);
    expect(branches.length).toBe(2); // well under the default cap, so nothing is truncated
    expect(branches.map((b) => b.spineId).sort()).toEqual([extra, parent].sort());
    expect(cap).toBe(TREEWALKER_CONFIG.branchListMax);
  });

  it('total reports the true drawer count even when the returned array is CAPPED (never mistake a truncated page for the whole set)', async () => {
    const cappedConfig = { ...TREEWALKER_CONFIG, branchListMax: 1 };
    const { branches, total, cap } = await TreeWalkerTiersService.getBranches(
      projectsScope([projectId]), cappedConfig, pool,
    );
    // The returned page is truncated to the cap...
    expect(branches.length).toBe(1);
    expect(cap).toBe(1);
    // ...but total still reports the FULL drawer population (2: parent, extra), not the
    // truncated page length — asserted explicitly so a regression that silently drops
    // `total` to `branches.length` cannot pass by accident.
    expect(total).toBe(2);
    expect(total).not.toBe(branches.length);
    // extra is the newest-active drawer (its member was added `new Date()`, parent's
    // newest member was added a day ago) so it is the one that survives the cap.
    expect(branches.map((b) => b.spineId)).toEqual([extra]);
  });

  it('SELECTION BEFORE THE CAP (P2): sections newer than a drawer cannot push it off the page', async () => {
    // childA/childB (sections of parent) are more recently active than BOTH top-level
    // drawers in this scope (parent: daysAgo(1); extra: `new Date()` — wait, extra is
    // actually the newest of all. To isolate the selection bug from ordering, cap at 3:
    // under the pre-686a1698 code, ordering by last_active across drawers AND sections
    // mixed would rank [extra(now), parent(daysAgo1), childA(daysAgo4)] into the top 3,
    // silently including a SECTION on the page. The fix must never let a section occupy a
    // slot at all, regardless of its recency relative to a drawer.
    const cappedConfig = { ...TREEWALKER_CONFIG, branchListMax: 3 };
    const { branches, total } = await TreeWalkerTiersService.getBranches(
      projectsScope([projectId]), cappedConfig, pool,
    );
    expect(branches.every((b) => b.spineId !== childA && b.spineId !== childB)).toBe(true);
    expect(branches.map((b) => b.spineId).sort()).toEqual([extra, parent].sort());
    expect(total).toBe(2);
  });
});
