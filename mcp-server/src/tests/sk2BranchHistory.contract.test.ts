/**
 * SK2 — BRANCH MEMBERSHIP HISTORY, the acceptance contract
 * (STRONG BONES an earlier spine).
 *
 * THE QUESTION: after a branch is CLOSED, can a DIFFERENT session still get back exactly
 * the records that were written on it, in the order they were written?
 *
 * It is not obvious that the answer can be yes. `branch_close` is a HARD DELETE of the
 * branch_positions row (services/branchPosition.ts closePosition) and `openPosition`
 * overwrites on re-open, so the live pointer retains nothing. History survives only because
 * membership lives in `links`, which nothing prunes. That is currently a lucky property of
 * where the data sits; these tests make it a CONTRACT.
 *
 * Driven through the FULL public path (validate → routeExecutor — the path the HTTP bridge
 * uses) against the disposable migrated ci_* DB, same idiom as the SK1 suite.
 *
 * Embeddings mocked to zeros — similarity plays no part in positional membership.
 *
 * ROUND 3 (migration 086): membership is the position's ROOT SPINE, recorded in its OWN
 * TABLE at mint time and read by one flat equality. The tip-chain / nested-branch PAIR below
 * is the acceptance test for that — round 1 walked to_id transitively, which cannot tell the
 * two apart and over-counted a branch of 2 as 4. Round 2 stored the same value on the `links`
 * row, where an earlier tag mint could swallow it whole; see sk2MembershipDedupRace.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { BRANCH_HISTORY_CONFIG } from '../config/branchHistoryConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const responseText = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'SK2 acceptance fixture') RETURNING id`,
      [`sk2-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `sk2-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}
async function joinConn(projectId: string, label: string): Promise<string> {
  const conn = `sk2-conn-${label}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return conn;
}

const ctxId = (r: any) => r.structuredContent.context.id as string;
const taskId = (r: any) => r.structuredContent.task.id as string;
const decId = (r: any) => r.structuredContent.decision.id as string;

/** A spine task created UNPOSITIONED is a root, and is not itself a member. */
async function makeSpine(conn: string, title: string): Promise<string> {
  const r = await viaTool('task_create', { title, type: 'feature', priority: 'low' }, conn);
  await viaTool('branch_close', {}, conn); // R1 auto-opened us onto it; step off deliberately
  return taskId(r);
}

/** created_at has ms resolution; write order is the contract, so separate the writes. */
const tick = () => new Promise((r) => setTimeout(r, 5));

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* teardown noise */ }
  }
  await db.end();
});

// ── THE CORE: history outlives the branch ────────────────────────────────────────────────
describe('branch_history — a CLOSED branch still returns its members, in write order', () => {
  test('open → 3 positioned writes → close → a DIFFERENT session reads back the same 3, same order', async () => {
    const { projectId, conn } = await freshCase('core');
    const spine = await makeSpine(conn, 'SK2 core spine');

    await viaTool('branch_open', { id: spine }, conn);
    const m1 = ctxId(await viaTool('context_store', { content: 'member one', type: 'planning' }, conn));
    await tick();
    const m2 = taskId(await viaTool('task_create', { title: 'member two', type: 'feature', priority: 'low' }, conn));
    await tick();
    const m3 = decId(await viaTool('decision_record', {
      title: 'member three', description: 'd', rationale: 'r',
      decisionType: 'process', impactLevel: 'low',
    }, conn));

    // While OPEN.
    const open = await viaTool('branch_history', { id: spine }, conn);
    expect(open.structuredContent.members.map((m: any) => m.id)).toEqual([m1, m2, m3]);
    expect(open.structuredContent.open).toBe(true);

    // CLOSE — and prove the live pointer really is gone, so the read below cannot be
    // served from it. Without this the durability claim is unfalsifiable.
    await viaTool('branch_close', {}, conn);
    const rows = await db.query('SELECT 1 FROM branch_positions WHERE project_id = $1', [projectId]);
    expect(rows.rowCount).toBe(0);

    const other = await joinConn(projectId, 'core-reader');
    const closed = await viaTool('branch_history', { id: spine }, other);
    expect(closed.structuredContent.members.map((m: any) => m.id)).toEqual([m1, m2, m3]);
    expect(closed.structuredContent.memberCount).toBe(3);
    expect(closed.structuredContent.totalMembers).toBe(3);
    expect(closed.structuredContent.omitted).toBe(0);
    expect(closed.structuredContent.truncated).toBe(false);
    expect(closed.structuredContent.open).toBe(false);

    // BOTH CHANNELS. SK8 shipped a populated structuredContent beside a text body that had
    // lost its payload, two releases ago; a member list that exists only in one channel is
    // invisible to half the clients. Assert the ids and the order in the PROSE too.
    const text = responseText(closed);
    for (const id of [m1, m2, m3]) expect(text).toContain(id.substring(0, 8));
    expect(text.indexOf(m1.substring(0, 8))).toBeLessThan(text.indexOf(m2.substring(0, 8)));
    expect(text.indexOf(m2.substring(0, 8))).toBeLessThan(text.indexOf(m3.substring(0, 8)));
  });

  test('NEGATIVE CONTROL — a record written off-branch is not a member of a POPULATED list', async () => {
    const { projectId, conn } = await freshCase('negctl');
    const spine = await makeSpine(conn, 'SK2 negative-control spine');
    await viaTool('branch_open', { id: spine }, conn);
    const member = ctxId(await viaTool('context_store', { content: 'on the branch', type: 'planning' }, conn));

    // A second session that is NOT on this spine (it auto-opened onto its own record).
    const outsiderConn = await joinConn(projectId, 'outsider');
    const outsider = ctxId(await viaTool('context_store', { content: 'off the branch', type: 'planning' }, outsiderConn));

    const h = await viaTool('branch_history', { id: spine }, conn);
    const ids = h.structuredContent.members.map((m: any) => m.id);
    // The positive set FIRST: "the outsider is absent" from an empty list is a pass that
    // survives the feature being deleted.
    expect(ids).toContain(member);
    expect(ids).not.toContain(outsider);
  });
});

// ── THE THREE BANDS ──────────────────────────────────────────────────────────────────────
// A member count over a corpus that straddles migration 086 cannot be ONE honest number. It
// is reported as three: recorded (exact), legacy-approx (inferred), and tag-only (visible but
// unattributable). Merging them is round 1's over-count; dropping the third is a seam nobody
// can see. `exact` is therefore a FORWARD-ONLY claim.
describe('branch_history reports three separate bands, and exact is forward-only', () => {
  test('a tag-only record is counted in its OWN band, never as a member, and it drops exact', async () => {
    const { projectId, conn } = await freshCase('bands');
    const spine = await makeSpine(conn, 'SK2 bands spine');
    await viaTool('branch_open', { id: spine }, conn);
    const member = ctxId(await viaTool('context_store', { content: 'a real member', type: 'planning' }, conn));

    // THE ZERO-LEGACY BOUNDARY — the control, and the case where exact:true IS correct. Every
    // record on this branch is post-086 and nothing merely tags it, so all three bands are
    // empty. Without this the assertions after the bait would be unfalsifiable: a response
    // that never claims exactness would pass them while saying nothing.
    const clean = await viaTool('branch_history', { id: spine }, conn);
    expect(clean.structuredContent.exact).toBe(true);
    expect(clean.structuredContent.approximateMembers).toBe(0);
    expect(clean.structuredContent.possiblyIncomplete).toBe(false);
    expect(clean.structuredContent.tagOnlyNoPosition).toBe(0);

    // THE BAIT: an UNPOSITIONED session tags the spine. On prod this is the shape left behind
    // by every write whose positional mint was swallowed by its own tag mint before 086 —
    // ~10 such records on the worked-example branch against 8 recorded members (measured 2026-08-15). Whether
    // its author was standing here is UNKNOWABLE: positions are hard-deleted on branch_close.
    const baitConn = await joinConn(projectId, 'bands-bait');
    const bait = ctxId(await viaTool('context_store', {
      content: 'tags the spine, no recorded position', type: 'planning',
      tags: [`task:${spine.replace(/-/g, '').slice(0, 8)}`],
    }, baitConn));

    const h = await viaTool('branch_history', { id: spine }, conn);
    // BAND 1 is unchanged — the bait is NOT promoted into the member set.
    expect(h.structuredContent.members.map((m: any) => m.id)).toEqual([member]);
    expect(h.structuredContent.totalMembers).toBe(1);
    // BAND 3 counts it, separately.
    expect(h.structuredContent.tagOnlyNoPosition).toBe(1);
    // And the claim of exactness is withdrawn, because it is no longer true.
    expect(h.structuredContent.exact).toBe(false);
    // BOTH CHANNELS: a band that exists only in structuredContent is invisible to the human
    // reading the tool output, which is the surface this defect class is judged on.
    expect(responseText(h)).toContain('carry no recorded position');
    void bait;
  });

  test('a record that tags this spine but is a MEMBER OF ANOTHER branch is in no band here', async () => {
    // The band must not become a dumping ground. A record with a recorded position elsewhere
    // is correctly a member of THAT branch; counting it as "unattributable" here would
    // manufacture doubt about a fact the system actually holds — the over-counting direction
    // wearing a caveat, which is exactly what rounds 1 and 2 did.
    const { projectId, conn } = await freshCase('bands-elsewhere');
    const spine = await makeSpine(conn, 'SK2 bands-elsewhere spine');
    await viaTool('branch_open', { id: spine }, conn);
    const member = ctxId(await viaTool('context_store', { content: 'my member', type: 'planning' }, conn));

    const otherConn = await joinConn(projectId, 'bands-other');
    const otherSpine = await makeSpine(otherConn, 'SK2 bands OTHER spine');
    await viaTool('branch_open', { id: otherSpine }, otherConn);
    const elsewhere = ctxId(await viaTool('context_store', {
      content: 'positioned on the other branch, tags this one', type: 'planning',
      tags: [`task:${spine.replace(/-/g, '').slice(0, 8)}`],
    }, otherConn));

    // PRECONDITION: the tag edge onto MY spine really exists, or this proves nothing.
    const tagEdge = await db.query(
      `SELECT 1 FROM links WHERE from_id = $1 AND to_id = $2 AND mint_via = 'tag' AND edge_type = 'informs'`,
      [elsewhere, spine]
    );
    expect(tagEdge.rowCount).toBe(1);

    const h = await viaTool('branch_history', { id: spine }, conn);
    expect(h.structuredContent.members.map((m: any) => m.id)).toEqual([member]);
    expect(h.structuredContent.tagOnlyNoPosition).toBe(0);
    expect(h.structuredContent.exact).toBe(true);

    // And it IS a member of the branch it was actually written on.
    const other = await viaTool('branch_history', { id: otherSpine }, otherConn);
    expect(other.structuredContent.members.map((m: any) => m.id)).toContain(elsewhere);
    void projectId;
  });
});

// ── THE PREDICATE ────────────────────────────────────────────────────────────────────────
describe('the membership predicate is mint_via=position, not declared+informs', () => {
  test('a TAG-minted declared informs edge onto the spine is NOT membership', async () => {
    const { projectId, conn } = await freshCase('predicate');
    const spine = await makeSpine(conn, 'SK2 predicate spine');
    await viaTool('branch_open', { id: spine }, conn);
    const member = ctxId(await viaTool('context_store', { content: 'real member', type: 'planning' }, conn));

    // The BAIT: an unpositioned session naming the spine by tag. This mints exactly the edge
    // the dashboard's loose predicate counted — declared + informs — via a different path.
    const baitConn = await joinConn(projectId, 'bait');
    const spineId8 = spine.replace(/-/g, '').slice(0, 8);
    const bait = ctxId(await viaTool('context_store', {
      content: 'tag-minted, not a member', type: 'planning', tags: [`task:${spineId8}`],
    }, baitConn));

    // The bait edge EXISTS and IS declared+informs — otherwise this test proves nothing
    // about the two predicates, because they would not disagree on this row.
    const loose = await db.query(
      `SELECT mint_via FROM links
        WHERE from_id = $1 AND to_id = $2 AND edge_type = 'informs'
          AND provenance_class = 'declared'`,
      [bait, spine]
    );
    expect(loose.rowCount).toBe(1);
    expect(loose.rows[0].mint_via).not.toBe('position');

    const h = await viaTool('branch_history', { id: spine }, conn);
    const ids = h.structuredContent.members.map((m: any) => m.id);
    expect(ids).toEqual([member]);
    expect(h.structuredContent.memberCount).toBe(1);

    // And the shared view agrees at the DB layer — the loose predicate matches strictly more.
    const counts = await db.query(
      `SELECT (SELECT count(*)::int FROM branch_membership WHERE spine_id = $1) AS precise,
              (SELECT count(*)::int FROM links
                WHERE to_id = $1 AND provenance_class = 'declared' AND edge_type = 'informs') AS loose`,
      [spine]
    );
    expect(counts.rows[0].precise).toBe(1);
    expect(counts.rows[0].loose).toBe(2);
  });

  test('both consumers read the shared view — neither re-spells the predicate', () => {
    // The two copies of this fact used to disagree (17 vs 9 members for an earlier spine).
    // mandrel-command cannot import mcp-server TypeScript, so the shared definition is the
    // `branch_membership` VIEW; this asserts both call sites actually go through it rather
    // than inlining the predicate again.
    const walker = readFileSync(resolve(__dirname, '../services/branchMembership.ts'), 'utf8');
    const dashboard = readFileSync(
      resolve(__dirname, '../../../mandrel-command/backend/src/services/treewalkerTiers.ts'),
      'utf8'
    );
    for (const [name, src] of [['walker', walker], ['dashboard', dashboard]] as const) {
      expect(src, `${name} must SELECT from branch_membership`).toMatch(/FROM branch_membership/);
      // Scan only the SQL, not the prose: both files DOCUMENT the loose predicate they
      // replaced, and a whole-file scan would fail on the explanation of its own fix.
      const sql = src.split('\n').filter((l) => !/^\s*(\*|\/\/|--)/.test(l)).join('\n');
      expect(sql, `${name} must not re-spell the loose predicate in SQL`).not.toMatch(
        /provenance_class\s*=\s*'declared'/
      );
    }
  });
});
// ── THE TIP CHAIN, AND THE THING IT IS NOT ───────────────────────────────────────────────
//
// These two tests are a PAIR and must be read together. They are the same row shape in the
// links table — an edge pointing at a record that is itself a member — with opposite correct
// answers. Round 1 walked the chain transitively and therefore could not distinguish them:
// it passed the first and silently absorbed the second, returning 4 members with
// truncated:false for a branch with 2 (Reviewer). Membership is now the position's ROOT
// spine, RECORDED in branch_memberships at mint time (migration 086), so both are decided by a stored
// fact and neither needs traversal.
describe('a tip-chained write belongs to the branch; a nested branch does not', () => {
  test('a write attached to the advanced TIP is a member of the branch ROOT — found FLAT', async () => {
    const { projectId, conn } = await freshCase('tip');

    // A tip only ever advances on an origin='auto' position (migration 082 CHECK forbids a
    // tip on declared/byproduct), so this is the only shape that produces the chain.
    const root = taskId(await viaTool('task_create', { title: 'SK2 tip root', type: 'feature', priority: 'low' }, conn));
    const pos0 = await db.query('SELECT origin, tip_id FROM branch_positions WHERE project_id = $1', [projectId]);
    expect(pos0.rows[0].origin).toBe('auto');
    expect(pos0.rows[0].tip_id).toBeNull();

    await tick();
    // A capture FIRST, to spend the position's virginity. Without it R2 reads a second
    // same-type create as a coordinator batching siblings and reverts the session to TRUNK,
    // which mints nothing and advances no tip — measured while writing this test.
    const cap = ctxId(await viaTool('context_store', { content: 'working the branch', type: 'planning' }, conn));

    await tick();
    // A CREATE attaches to the ROOT and ADVANCES the tip onto itself.
    const mid = taskId(await viaTool('task_create', { title: 'SK2 tip mid', type: 'feature', priority: 'low' }, conn));
    const pos1 = await db.query('SELECT tip_id FROM branch_positions WHERE project_id = $1', [projectId]);
    expect(pos1.rows[0].tip_id).toBe(mid);

    await tick();
    // A CAPTURE attaches to the TIP — i.e. to `mid`, NOT to `root`.
    const leaf = ctxId(await viaTool('context_store', { content: 'attached to the tip', type: 'planning' }, conn));

    // PRECONDITION, or this test proves nothing: the edge really does point at `mid`, and
    // its RECORDED BRANCH really is `root`. Those two columns differing IS the mechanism.
    const edge = await db.query(
      `SELECT attached_to_id::text AS attached_to, spine_id::text AS spine, spine_source
         FROM branch_membership WHERE member_id = $1`,
      [leaf]
    );
    expect(edge.rows).toHaveLength(1);
    expect(edge.rows[0].attached_to).toBe(mid);
    expect(edge.rows[0].spine).toBe(root);
    expect(edge.rows[0].spine_source).toBe('recorded');

    // THE ASSERTION: ONE flat equality on the recorded spine returns all three. No walk, no
    // depth. Under the old to_id-keyed view this same query returned [cap, mid] and looked
    // complete — that is what the walk existed to patch around.
    const flat = await db.query(
      `SELECT member_id::text AS id FROM branch_membership WHERE spine_id = $1 ORDER BY created_at`,
      [root]
    );
    expect(flat.rows.map((r: any) => r.id)).toEqual([cap, mid, leaf]);

    const h = await viaTool('branch_history', { id: root }, conn);
    expect(h.structuredContent.members.map((m: any) => m.id)).toEqual([cap, mid, leaf]);
    expect(h.structuredContent.totalMembers).toBe(3);
    expect(h.structuredContent.truncated).toBe(false);
    // Recorded, therefore EXACT — no approximation caveat on a post-086 branch.
    expect(h.structuredContent.exact).toBe(true);
    expect(h.structuredContent.approximateMembers).toBe(0);
    expect(h.structuredContent.possiblyIncomplete).toBe(false);
    // The renderer marks WHERE the edge attaches, and says nothing about how it was found.
    // Round 1 rendered '[via tip +1]' — a causal claim the rows do not carry, and one that
    // was false for every nested-branch record the walk had absorbed.
    expect(responseText(h)).toContain(`[attached to ${mid.substring(0, 8)}]`);
    expect(responseText(h)).not.toContain('via tip');
  });

  test('THE ROUND-1 DEFECT: a NESTED branch’s writes are NOT absorbed into the parent', async () => {
    // Session A stands on S and writes M. Session B then opens a branch on M and writes two
    // records. Those records attach to M — the same shape as the tip-chained capture above —
    // but they were written on M's branch, not on S's. S has TWO members; the walk said 4.
    const { projectId, conn } = await freshCase('nested');
    const s = await makeSpine(conn, 'SK2 nested parent spine');
    await viaTool('branch_open', { id: s }, conn);
    const m1 = ctxId(await viaTool('context_store', { content: 'parent member one', type: 'planning' }, conn));
    await tick();
    const m = taskId(await viaTool('task_create', { title: 'SK2 nested child spine', type: 'feature', priority: 'low' }, conn));

    const nestedConn = await joinConn(projectId, 'nested-child');
    await viaTool('branch_open', { id: m }, nestedConn);
    await tick();
    const n1 = ctxId(await viaTool('context_store', { content: 'child member one', type: 'planning' }, nestedConn));
    await tick();
    const n2 = ctxId(await viaTool('context_store', { content: 'child member two', type: 'planning' }, nestedConn));

    // PRECONDITION: the nested writes really do attach to m, so a to_id walk from s WOULD
    // reach them. Without this the assertion below passes on a branch that never existed.
    const attach = await db.query(
      `SELECT member_id::text AS id FROM branch_membership WHERE attached_to_id = $1 ORDER BY created_at`,
      [m]
    );
    expect(attach.rows.map((r: any) => r.id).sort()).toEqual([n1, n2].sort());

    const parent = await viaTool('branch_history', { id: s }, conn);
    expect(parent.structuredContent.members.map((mm: any) => mm.id)).toEqual([m1, m]);
    expect(parent.structuredContent.totalMembers).toBe(2);
    expect(parent.structuredContent.truncated).toBe(false);
    expect(parent.structuredContent.exact).toBe(true);

    // And the child branch owns them, so they are not lost — excluded, not dropped.
    const child = await viaTool('branch_history', { id: m }, nestedConn);
    expect(child.structuredContent.members.map((mm: any) => mm.id)).toEqual([n1, n2]);
  });
});

// ── THE LEGACY APPROXIMATION IS NEVER PRESENTED AS A FACT ────────────────────────────────
describe('pre-086 writes are marked approximate in both channels', () => {
  test('a backfilled member reports approximateMembers and drops exact; a recorded one does not', async () => {
    const { projectId, conn } = await freshCase('legacy');
    const spine = await makeSpine(conn, 'SK2 legacy spine');
    await viaTool('branch_open', { id: spine }, conn);
    const recorded = ctxId(await viaTool('context_store', { content: 'post-086 member', type: 'planning' }, conn));
    await tick();
    const legacy = ctxId(await viaTool('context_store', { content: 'pre-086 member', type: 'planning' }, conn));

    // CONTROL FIRST: with both rows 'recorded', the answer claims to be exact. If this line
    // ever fails, the assertions after the mutation mean nothing.
    const before = await viaTool('branch_history', { id: spine }, conn);
    expect(before.structuredContent.exact).toBe(true);
    expect(before.structuredContent.approximateMembers).toBe(0);

    // Age ONE membership row into the pre-086 shape: what migration 086's backfill produces
    // for a directly-attached member. Done by hand because the product cannot mint one —
    // which is the point: the class is closed and can only shrink.
    await db.query(
      `UPDATE branch_memberships SET source = 'legacy-approx' WHERE record_id = $1`,
      [legacy]
    );

    const h = await viaTool('branch_history', { id: spine }, conn);
    expect(h.structuredContent.members.map((m: any) => m.id)).toEqual([recorded, legacy]);
    expect(h.structuredContent.approximateMembers).toBe(1);
    expect(h.structuredContent.exact).toBe(false);
    expect(h.structuredContent.members.find((m: any) => m.id === legacy).spineSource).toBe('legacy-approx');
    expect(h.structuredContent.members.find((m: any) => m.id === recorded).spineSource).toBe('recorded');
    // BOTH CHANNELS — a caveat that exists only in structuredContent is invisible to a human
    // reading the tool output, which is the surface this defect class is judged on.
    expect(responseText(h)).toContain('branch is INFERRED, not recorded');
    expect(responseText(h)).toContain('[branch inferred: pre-086 write]');
    void projectId;
  });

  test('a pre-086 write hanging off a member makes the branch say it may be INCOMPLETE', async () => {
    // The other half of the honesty story, and the one that is easy to omit:
    // approximateMembers covers rows that ARE here. This covers a row that may be MISSING —
    // a legacy write whose branch is the member itself, which was either a tip write on this
    // branch or a nested branch's write, unrecoverably.
    const { projectId, conn } = await freshCase('incomplete');
    const spine = await makeSpine(conn, 'SK2 incomplete spine');
    await viaTool('branch_open', { id: spine }, conn);
    const member = ctxId(await viaTool('context_store', { content: 'the member', type: 'planning' }, conn));
    await tick();

    const otherConn = await joinConn(projectId, 'incomplete-child');
    await viaTool('branch_open', { id: member }, otherConn);
    const dangling = ctxId(await viaTool('context_store', { content: 'attached to the member', type: 'planning' }, otherConn));

    // CONTROL: while that edge is 'recorded', it names its own branch and there is no doubt.
    const before = await viaTool('branch_history', { id: spine }, conn);
    expect(before.structuredContent.possiblyIncomplete).toBe(false);
    expect(before.structuredContent.exact).toBe(true);

    await db.query(
      `UPDATE branch_memberships SET source = 'legacy-approx' WHERE record_id = $1`,
      [dangling]
    );

    const h = await viaTool('branch_history', { id: spine }, conn);
    expect(h.structuredContent.possiblyIncomplete).toBe(true);
    expect(h.structuredContent.exact).toBe(false);
    // The dangling record is still NOT counted as a member — the honest answer is "it might
    // belong here and I cannot tell", not "I will claim it".
    expect(h.structuredContent.members.map((m: any) => m.id)).toEqual([member]);
    expect(h.structuredContent.totalMembers).toBe(1);
    expect(responseText(h)).toContain('may be INCOMPLETE');
    void dangling;
  });
});

// ── BOUNDS ARE REPORTED, NEVER SILENT ────────────────────────────────────────────────────
describe('a short answer says it is short', () => {
  test('limit truncates the list AND reports omitted in both channels', async () => {
    const { conn } = await freshCase('limit');
    const spine = await makeSpine(conn, 'SK2 limit spine');
    await viaTool('branch_open', { id: spine }, conn);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(ctxId(await viaTool('context_store', { content: `limit member ${i}`, type: 'planning' }, conn)));
      await tick();
    }

    const h = await viaTool('branch_history', { id: spine, limit: 2 }, conn);
    expect(h.structuredContent.members.map((m: any) => m.id)).toEqual(ids.slice(0, 2));
    expect(h.structuredContent.memberCount).toBe(2);
    expect(h.structuredContent.totalMembers).toBe(4);
    expect(h.structuredContent.omitted).toBe(2);
    expect(h.structuredContent.truncated).toBe(true);
    expect(responseText(h)).toContain('2 further members NOT shown');
  });

  test('a limit above the ceiling is clamped and said out loud, never silently honoured', async () => {
    const { conn } = await freshCase('clamp');
    const spine = await makeSpine(conn, 'SK2 clamp spine');
    const over = BRANCH_HISTORY_CONFIG.maxLimit + 1;
    const h = await viaTool('branch_history', { id: spine, limit: over }, conn);
    expect(h.structuredContent.limitUsed).toBe(BRANCH_HISTORY_CONFIG.maxLimit);
    expect(responseText(h)).toContain(`clamped to ${BRANCH_HISTORY_CONFIG.maxLimit}`);
  });

  test('an EMPTY branch is an honest empty answer, not an error and not a fabricated one', async () => {
    const { conn } = await freshCase('empty');
    const spine = await makeSpine(conn, 'SK2 empty spine');
    const h = await viaTool('branch_history', { id: spine }, conn);
    expect(h.isError).toBeFalsy();
    expect(h.structuredContent.members).toEqual([]);
    expect(h.structuredContent.memberCount).toBe(0);
    expect(h.structuredContent.omitted).toBe(0);
    expect(h.structuredContent.truncated).toBe(false);
    expect(responseText(h)).toContain('no members');
  });
});

// ── SCOPE + RESOLUTION ───────────────────────────────────────────────────────────────────
describe('project scope and id resolution', () => {
  test('a spine in ANOTHER project does not resolve, and leaks none of its members', async () => {
    const foreign = await freshCase('foreign');
    const foreignSpine = await makeSpine(foreign.conn, 'SK2 foreign spine');
    await viaTool('branch_open', { id: foreignSpine }, foreign.conn);
    const foreignMember = ctxId(
      await viaTool('context_store', { content: 'foreign member', type: 'planning' }, foreign.conn)
    );

    // Control: it IS readable from its own project. Without this, the refusal below could be
    // a broken tool rather than a scope boundary.
    const own = await viaTool('branch_history', { id: foreignSpine }, foreign.conn);
    expect(own.structuredContent.members.map((m: any) => m.id)).toEqual([foreignMember]);

    const mine = await freshCase('mine');
    const leaked = await viaTool('branch_history', { id: foreignSpine }, mine.conn);
    expect(leaked.isError).toBe(true);
    expect(responseText(leaked)).toContain('resolves to no context, decision, or task');
    expect(responseText(leaked)).not.toContain(foreignMember.substring(0, 8));
  });

  test('a membership row carrying a FOREIGN project_id is not returned (F2 — the scope filter can fail)', async () => {
    // SK2 round 1 claimed project scoping as "two independent layers" and Reviewer proved
    // layer 2 unfalsifiable: deleting `AND project_id = $2` left all 11 tests green, because
    // record ids are UUIDs and no product path can put a foreign row behind a resolvable
    // spine. The claim is now either exercised or deleted — this is the exercise. The row is
    // written by hand precisely because the product cannot produce one; the table permits it
    // (raw SQL, a migration, a future service), and that is the state the filter defends.
    const { projectId, conn } = await freshCase('scopefilter');
    const spine = await makeSpine(conn, 'SK2 scope-filter spine');
    await viaTool('branch_open', { id: spine }, conn);
    const mine = ctxId(await viaTool('context_store', { content: 'my member', type: 'planning' }, conn));

    const foreign = await freshCase('scopefilter-foreign');
    const intruder = ctxId(
      await viaTool('context_store', { content: 'foreign record', type: 'planning' }, foreign.conn)
    );
    // A membership row that names MY spine while carrying THEIR project_id.
    await db.query(
      `INSERT INTO branch_memberships
         (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
          source, project_id)
       VALUES ($1,'context',$2,'task',$2,'task','recorded',$3)`,
      [intruder, spine, foreign.projectId]
    );
    // PRECONDITION: the row exists and IS selected by the predicate minus the project filter.
    // Without this the assertion below could pass because nothing was ever inserted.
    const unscoped = await db.query(
      `SELECT member_id::text AS id FROM branch_membership WHERE spine_id = $1`,
      [spine]
    );
    expect(unscoped.rows.map((r: any) => r.id).sort()).toEqual([mine, intruder].sort());

    const h = await viaTool('branch_history', { id: spine }, conn);
    expect(h.structuredContent.members.map((m: any) => m.id)).toEqual([mine]);
    expect(responseText(h)).not.toContain(intruder.substring(0, 8));
    void projectId;
  });

  test('an 8-hex short id that matches MORE THAN ONE record is refused, never first-match', async () => {
    const { conn } = await freshCase('ambig');
    // Force a collision: two records whose ids share the first 8 hex characters. The product
    // cannot be made to generate one on demand, so the ids are planted — this is about the
    // RESOLVER's behaviour, and a first-match resolver would confidently answer about the
    // wrong branch, which is worse than any error.
    const prefix = 'abcd1234';
    const cid = `${prefix}-0000-4000-8000-000000000001`;
    const tid = `${prefix}-0000-4000-8000-000000000002`;
    const pid = projectIds[projectIds.length - 1];
    await db.query(
      `INSERT INTO contexts (id, project_id, context_type, content) VALUES ($1,$2,'planning','collision ctx')`,
      [cid, pid]
    );
    await db.query(
      `INSERT INTO tasks (id, project_id, title, type, status, priority) VALUES ($1,$2,'collision task','feature','todo','low')`,
      [tid, pid]
    );

    const h = await viaTool('branch_history', { id: prefix }, conn);
    expect(h.isError).toBe(true);
    expect(h.structuredContent.ambiguous).toBe(true);
    expect(h.structuredContent.candidates.sort()).toEqual([cid, tid].sort());
  });
});
