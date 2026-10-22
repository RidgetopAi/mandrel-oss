/**
 * MUTABLE BRANCH MEMBERSHIP — the acceptance contract for `branch_assign` / `branch_unassign`
 * (P3, migration 090).
 *
 * THE QUESTION: a record's branch was WRONG — often because the system opened a position its
 * author never asked for. Can it be corrected, and does the correction leave a trace that
 * survives even when the membership row itself is deleted?
 *
 * It was not possible before this change. `recordMembership` is ON CONFLICT DO NOTHING, so
 * the FIRST position won permanently. This is therefore the first tool in the product that
 * REWRITES a previously immutable historical fact, and `branch_membership_moves` is the only
 * reason that is acceptable rather than alarming — which is why T4 and T5 below assert the
 * LOG and not just the outcome.
 *
 * Driven through the FULL public path (validate → routeExecutor — the path the HTTP bridge
 * uses) against the disposable migrated ci_* DB, same idiom as the SK2 suite. Embeddings
 * mocked to zeros — similarity plays no part in membership.
 *
 * WHY THIS FILE EXISTS ALONGSIDE membershipApproximateSources.contract.test.ts: that file
 * injects the `'assigned'` source at each consumer's own boundary, because when it was written
 * the value could not be stored at all. This one drives the REAL store, through the REAL
 * tool. Both are kept on purpose — the other one still goes RED if a site reverts to
 * `!== recorded` at a moment when no assigned row happens to exist.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { Pool } from 'pg';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import {
  readMembershipMoves,
  readBranchMemberSummaries,
} from '../services/branchMembership.js';
import {
  MEMBERSHIP_SOURCE,
  MEMBERSHIP_SOURCE_VALUES,
} from '../config/membershipSourceConfig.js';
import { renderBriefing, briefingConfig, type BriefingData } from '../services/projectBriefing.js';
import { censusFor } from './helpers/briefingCensus.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';

const STAMP = Date.now();
const projectIds: string[] = [];
const ACTOR = 'p3-test-actor';

/**
 * AN UNGUARDED POOL, FOR T7 ONLY — and the reason it has to exist.
 *
 * `config/database.ts` wraps its pool in `guardPool` (utils/datastoreError.ts), which
 * REDACTS every driver error into an opaque `[DATASTORE_ERROR] … (ref: …)` before any caller
 * sees it. That is correct product behaviour — a constraint name is server-side detail — and
 * it means a test driven through `db` cannot tell "the source CHECK rejected this" from "the
 * FK failed" or "the connection dropped". A guard that passes on ANY failure is hollow, so
 * T7 opens its own raw connection to the SAME database, derived from the product pool's own
 * resolved options rather than re-read from env (C4: never hardcode a config-derived value;
 * take it from the source the product actually used).
 */
const PRODUCT_POOL_OPTIONS = (db as unknown as { options: Record<string, unknown> }).options;
const rawPool = new Pool({
  ...PRODUCT_POOL_OPTIONS,
  // `password` MUST be carried over EXPLICITLY. Measured, not assumed: pg defines it as a
  // NON-ENUMERABLE property on Pool.options, so a spread silently drops it and the first
  // connection fails with "SASL: client password must be a string" — a confusing auth error
  // several worktrees away from anything about branch membership. Object.keys(options) omits
  // it while `typeof options.password === 'string'` is true.
  password: PRODUCT_POOL_OPTIONS.password as string,
});

async function viaTool(
  toolName: string,
  rawArgs: any,
  conn: string,
  actor: string = ACTOR
): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn, actor });
}
const responseText = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'P3 reassignment fixture') RETURNING id`,
      [`p3-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `p3-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}
async function joinConn(projectId: string, label: string): Promise<string> {
  const conn = `p3-conn-${label}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return conn;
}

const ctxId = (r: any) => r.structuredContent.context.id as string;
const taskId = (r: any) => r.structuredContent.task.id as string;

/** A spine task created UNPOSITIONED is a root, and is not itself a member. */
async function makeSpine(conn: string, title: string): Promise<string> {
  const r = await viaTool('task_create', { title, type: 'feature', priority: 'low' }, conn);
  await viaTool('branch_close', {}, conn); // the create auto-opened us onto it; step off
  return taskId(r);
}

/** An UNPOSITIONED context — a member of nothing. */
async function unpositionedContext(projectId: string, label: string, content: string) {
  const conn = await joinConn(projectId, label);
  await viaTool('branch_close', {}, conn);
  return { id: ctxId(await viaTool('context_store', { content, type: 'planning' }, conn)), conn };
}

/** created_at has ms resolution; write order is the contract, so separate the writes. */
const tick = () => new Promise((r) => setTimeout(r, 5));

const memberIds = (h: any): string[] => h.structuredContent.members.map((m: any) => m.id);
const short = (id: string) => id.substring(0, 8);

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM branch_membership_moves WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_memberships WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* teardown noise */ }
  }
  await rawPool.end().catch(() => { /* teardown noise */ });
  await db.end();
});

// ── T1: ASSIGN WHERE THERE WAS NOTHING ───────────────────────────────────────────────────
describe('T1 — branch_assign makes a member out of a record that was on no branch', () => {
  test('a row appears with source=assigned and branch_history lists it in write order', async () => {
    const { projectId, conn } = await freshCase('t1');
    const spine = await makeSpine(conn, 'P3 T1 spine');

    // A REAL member first, so the assigned one has to take its place in an ORDER rather than
    // being the only thing in the list (a one-element list cannot show order at all).
    await viaTool('branch_open', { id: spine }, conn);
    const recorded = ctxId(await viaTool('context_store', { content: 'recorded member', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);
    await tick();

    const outsider = await unpositionedContext(projectId, 't1-outsider', 'was on no branch');

    // CONTROL: it is a member of nothing, and branch_history does not list it. Without this
    // the assertion after the assign could pass because it was there all along.
    const before = await viaTool('branch_history', { id: spine }, conn);
    expect(memberIds(before)).toEqual([recorded]);
    const noRow = await db.query('SELECT 1 FROM branch_memberships WHERE record_id = $1', [outsider.id]);
    expect(noRow.rowCount).toBe(0);

    const assigned = await viaTool('branch_assign', { id: outsider.id, spine }, conn);
    expect(assigned.isError).toBeFalsy();
    expect(assigned.structuredContent.action).toBe('assigned');
    expect(assigned.structuredContent.previousSpineId).toBeNull();
    expect(assigned.structuredContent.spineSource).toBe(MEMBERSHIP_SOURCE.assigned);

    const row = await db.query(
      `SELECT spine_id::text AS spine_id, source, project_id::text AS project_id
         FROM branch_memberships WHERE record_id = $1`,
      [outsider.id]
    );
    expect(row.rows[0]).toMatchObject({
      spine_id: spine,
      source: MEMBERSHIP_SOURCE.assigned,
      project_id: projectId,
    });

    const after = await viaTool('branch_history', { id: spine }, conn);
    expect(memberIds(after)).toEqual([recorded, outsider.id]);
    expect(after.structuredContent.totalMembers).toBe(2);
    // BOTH CHANNELS: a declared branch is a fact, so it carries no approximation caveat — but
    // it is a DIFFERENT fact from an observed position and the text channel says so too.
    expect(responseText(after)).toContain('[branch assigned]');
  });
});

// ── T2: A MOVE, AND THE BRANCH IT LEFT ───────────────────────────────────────────────────
describe('T2 — a move is visible from both ends, and never silent', () => {
  test('branch A loses it, branch B gains it, and the response names A', async () => {
    const { projectId, conn } = await freshCase('t2');
    const spineA = await makeSpine(conn, 'P3 T2 spine A');
    const spineB = await makeSpine(conn, 'P3 T2 spine B');

    await viaTool('branch_open', { id: spineA }, conn);
    const rec = ctxId(await viaTool('context_store', { content: 'written on A', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);

    const historyA0 = await viaTool('branch_history', { id: spineA }, conn);
    expect(memberIds(historyA0)).toEqual([rec]);
    const createdAtBefore = (
      await db.query('SELECT created_at FROM branch_memberships WHERE record_id = $1', [rec])
    ).rows[0].created_at;

    const moved = await viaTool('branch_assign', { id: rec, spine: spineB }, conn);
    expect(moved.structuredContent.action).toBe('moved');
    expect(moved.structuredContent.previousSpineId).toBe(spineA);
    expect(responseText(moved)).toContain(short(spineA));

    expect(memberIds(await viaTool('branch_history', { id: spineA }, conn))).toEqual([]);
    expect(memberIds(await viaTool('branch_history', { id: spineB }, conn))).toEqual([rec]);

    // ★ created_at IS THE BRANCH'S WRITE-ORDER KEY (ORDER BY bm.created_at ASC, both readers).
    // A move must not touch it, or every branch a moved record joins silently reorders itself.
    const createdAtAfter = (
      await db.query('SELECT created_at FROM branch_memberships WHERE record_id = $1', [rec])
    ).rows[0].created_at;
    expect(createdAtAfter.getTime()).toBe(createdAtBefore.getTime());
    void projectId;
  });

  test('assigning to the branch it is already on is `unchanged` and writes NO move row', async () => {
    // A no-op is not an event. Logging one would fabricate a history, and an audit trail that
    // records changes that did not happen is worth no more than one that misses changes that did.
    const { projectId, conn } = await freshCase('t2-noop');
    const spine = await makeSpine(conn, 'P3 T2 noop spine');
    await viaTool('branch_open', { id: spine }, conn);
    const rec = ctxId(await viaTool('context_store', { content: 'already here', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);

    const r = await viaTool('branch_assign', { id: rec, spine }, conn);
    expect(r.structuredContent.action).toBe('unchanged');
    expect(r.structuredContent.spineSource).toBeNull();
    expect(await readMembershipMoves({ recordId: rec, projectId })).toEqual([]);
    // And the source is NOT rewritten: it was observed at mint time and still was.
    const src = await db.query('SELECT source FROM branch_memberships WHERE record_id = $1', [rec]);
    expect(src.rows[0].source).toBe(MEMBERSHIP_SOURCE.recorded);
  });

  test('a record cannot be assigned to itself — an actionable refusal, not a constraint error', async () => {
    const { conn } = await freshCase('t2-self');
    const spine = await makeSpine(conn, 'P3 T2 self spine');
    const r = await viaTool('branch_assign', { id: spine, spine }, conn);
    expect(r.isError).toBe(true);
    expect(responseText(r)).toContain('cannot be a member of itself');
    expect(responseText(r)).not.toContain('violates check constraint');
  });
});

// ── T3 ★ THE C4 TEST — A DECLARED MEMBERSHIP IS NOT AN APPROXIMATION ─────────────────────
// The defect this change introduces if written naively. Four product sites answered "was this
// member's branch DERIVED rather than known" as `spineSource !== recorded`. That proxy is
// behaviour-identical for two values and WRONG for three: it would report a deliberately
// declared fact as "branch INFERRED, not recorded" and drop `exact:false` on a branch that is
// perfectly exact — a confident wrong number understating trust in the strongest fact we hold.
describe('T3 — a branch of one recorded + one ASSIGNED member is EXACT and uncaveated', () => {
  test('branch_history: approximateMembers 0, possiblyIncomplete false, exact true', async () => {
    const { projectId, conn } = await freshCase('t3');
    const spine = await makeSpine(conn, 'P3 T3 spine');

    await viaTool('branch_open', { id: spine }, conn);
    const recorded = ctxId(await viaTool('context_store', { content: 'observed at mint time', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);
    await tick();

    const declared = await unpositionedContext(projectId, 't3-declared', 'declared after the fact');
    await viaTool('branch_assign', { id: declared.id, spine }, conn);

    const h = await viaTool('branch_history', { id: spine }, conn);
    expect(memberIds(h).sort()).toEqual([recorded, declared.id].sort());
    expect(h.structuredContent.approximateMembers).toBe(0);
    expect(h.structuredContent.possiblyIncomplete).toBe(false);
    // BAND 3 must also be empty, or `exact` would be false for a reason unrelated to C4 and
    // this case would pass while proving nothing about the classification.
    expect(h.structuredContent.tagOnlyNoPosition).toBe(0);
    expect(h.structuredContent.exact).toBe(true);
    // The per-member marker: NO approximation caveat on the declared row, in either channel.
    expect(
      h.structuredContent.members.find((m: any) => m.id === declared.id).spineSource
    ).toBe(MEMBERSHIP_SOURCE.assigned);
    expect(responseText(h)).not.toContain('branch inferred');
    expect(responseText(h)).not.toContain('branch is INFERRED, not recorded');
  });

  test('the briefing renders NO [spine-source:] marker for the assigned row', async () => {
    // END-TO-END through the REAL store: the rows come from readBranchMemberSummaries, which
    // is what projectBriefing calls, so this exercises the whole path rather than a fabricated
    // member list. That is the half membershipApproximateSources could not reach.
    const { projectId, conn } = await freshCase('t3-briefing');
    const spine = await makeSpine(conn, 'P3 T3 briefing spine');
    await viaTool('branch_open', { id: spine }, conn);
    const recorded = ctxId(await viaTool('context_store', { content: 'observed member', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);
    await tick();
    const declared = await unpositionedContext(projectId, 't3b-declared', 'declared member');
    await viaTool('branch_assign', { id: declared.id, spine }, conn);

    const { members } = await readBranchMemberSummaries({ projectId, spineId: spine, limit: 50 });
    expect(members.map((m) => m.id).sort()).toEqual([recorded, declared.id].sort());
    expect(members.find((m) => m.id === declared.id)!.spineSource).toBe(MEMBERSHIP_SOURCE.assigned);

    const data: BriefingData = {
      projectId,
      projectName: 'p3-t3-briefing',
      handoffHead: resolvedHead(null),
      handoff: null,
      tasks: [],
      decisions: [],
      conventions: [],
      deadEnds: [],
      branch: { spineId: spine, members },
      // P5.5: no "Waiting on a human" section in this fabricated corpus — the section is
      // exercised by the waitingOnHuman contract tests. `null` says ABSENT, which is the true
      // claim here; a fabricated EMPTY section would assert a zero nobody measured.
      waiting: null,
      census: censusFor({ tasks: [], decisions: [], conventions: [], deadEnds: [], branchMembers: members }),
    };
    const r = renderBriefing(data, { ...briefingConfig(), branchScopeEnabled: true });
    const branchLines = (() => {
      const ls = r.markdown.split('\n');
      const start = ls.findIndex((l) => l.startsWith('## On this branch'));
      if (start < 0) return [];
      const out: string[] = [];
      for (const l of ls.slice(start + 1)) {
        if (l.startsWith('## ')) break;
        if (l.startsWith('- ')) out.push(l);
      }
      return out;
    })();
    expect(branchLines, 'both members must render, or the assertion below is vacuous').toHaveLength(2);
    expect(branchLines.filter((l) => l.includes('spine-source:'))).toHaveLength(0);
    expect(r.markdown).not.toContain('APPROXIMATE members');
  });

  test('CONTROL — a legacy-approx member on the same shape still drops exact and IS marked', async () => {
    // Without this, T3 above would pass on a build where the classification stopped working
    // entirely (nothing is ever approximate → nothing is ever marked → every assertion holds).
    const { projectId, conn } = await freshCase('t3-control');
    const spine = await makeSpine(conn, 'P3 T3 control spine');
    await viaTool('branch_open', { id: spine }, conn);
    const legacy = ctxId(await viaTool('context_store', { content: 'pre-086 member', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);
    await db.query(`UPDATE branch_memberships SET source = $2 WHERE record_id = $1`, [
      legacy,
      MEMBERSHIP_SOURCE.legacyApprox,
    ]);

    const h = await viaTool('branch_history', { id: spine }, conn);
    expect(h.structuredContent.approximateMembers).toBe(1);
    expect(h.structuredContent.exact).toBe(false);
    expect(responseText(h)).toContain('[branch inferred: pre-086 write]');
    void projectId;
  });
});

// ── T4: PROVENANCE SURVIVES EVERY MOVE, NOT JUST THE LAST ────────────────────────────────
describe('T4 — A→B→C leaves three move rows, and the first branch is still recoverable', () => {
  test('null→A, A→B, B→C — each with an actor and a timestamp', async () => {
    // THIS IS THE CASE A `previous_spine_id` COLUMN CANNOT SERVE. A column holds one prior
    // value, so after the second move the A→B step is gone and "which branch was this on
    // originally" becomes unanswerable — the same durable-fact-on-a-deletable-carrier mistake
    // migration 086 exists to undo, one table further on.
    const { projectId, conn } = await freshCase('t4');
    const A = await makeSpine(conn, 'P3 T4 spine A');
    const B = await makeSpine(conn, 'P3 T4 spine B');
    const C = await makeSpine(conn, 'P3 T4 spine C');
    const rec = await unpositionedContext(projectId, 't4-rec', 'travels three branches');

    await viaTool('branch_assign', { id: rec.id, spine: A }, conn);
    await tick();
    await viaTool('branch_assign', { id: rec.id, spine: B, reason: 'was actually B' }, conn);
    await tick();
    await viaTool('branch_assign', { id: rec.id, spine: C }, conn);

    const moves = await readMembershipMoves({ recordId: rec.id, projectId });
    expect(moves.map((m) => [m.fromSpineId, m.toSpineId])).toEqual([
      [null, A],
      [A, B],
      [B, C],
    ]);
    for (const m of moves) {
      expect(m.actor).toBe(ACTOR);
      expect(new Date(m.movedAt).getTime()).toBeGreaterThan(0);
    }
    expect(moves[1].reason).toBe('was actually B');
    expect(moves[0].reason).toBeNull();

    // A IS STILL RECOVERABLE — the point of the whole table.
    expect(moves[0].toSpineId).toBe(A);
    // …and the current membership is C, and only C.
    expect(memberIds(await viaTool('branch_history', { id: C }, conn))).toEqual([rec.id]);
    expect(memberIds(await viaTool('branch_history', { id: A }, conn))).toEqual([]);
  });

  test('the actor is the CALLER\'s, and an unidentified caller is recorded as such', async () => {
    // The audit column is what makes rewriting an immutable fact acceptable, so "who" must
    // come from the call and not from a default that would make every row look the same.
    const { projectId, conn } = await freshCase('t4-actor');
    const spine = await makeSpine(conn, 'P3 T4 actor spine');
    const one = await unpositionedContext(projectId, 't4-a1', 'moved by alice');
    const two = await unpositionedContext(projectId, 't4-a2', 'moved by nobody');

    await viaTool('branch_assign', { id: one.id, spine }, conn, 'alice');
    await routeExecutor(
      'branch_assign',
      validateToolArguments('branch_assign', { id: two.id, spine }),
      { connectionId: conn } // no actor presented at all
    );

    const [m1] = await readMembershipMoves({ recordId: one.id, projectId });
    const [m2] = await readMembershipMoves({ recordId: two.id, projectId });
    expect(m1.actor).toBe('alice');
    // Not NULL and not 'alice': "this call presented no identity" is a specific, knowable
    // fact and the column states it. (On prod MANDREL_SESSION_REQUIRE_ACTOR=true means this
    // path is unreachable — it describes in-process callers, which is what produced it here.)
    expect(m2.actor).not.toBe('alice');
    expect(m2.actor.length).toBeGreaterThan(0);
  });
});

// ── T5: AN UNASSIGN LEAVES A TRACE ───────────────────────────────────────────────────────
describe('T5 — branch_unassign removes the membership and records the removal', () => {
  test('no row, not listed, and a move row with to_spine_id NULL', async () => {
    const { projectId, conn } = await freshCase('t5');
    const spine = await makeSpine(conn, 'P3 T5 spine');
    await viaTool('branch_open', { id: spine }, conn);
    const rec = ctxId(await viaTool('context_store', { content: 'wrongly auto-membered', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);

    expect(memberIds(await viaTool('branch_history', { id: spine }, conn))).toEqual([rec]);

    const r = await viaTool('branch_unassign', { id: rec, reason: 'auto-open, never declared' }, conn);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.action).toBe('unassigned');
    expect(r.structuredContent.previousSpineId).toBe(spine);

    expect((await db.query('SELECT 1 FROM branch_memberships WHERE record_id = $1', [rec])).rowCount).toBe(0);
    expect(memberIds(await viaTool('branch_history', { id: spine }, conn))).toEqual([]);

    // THE EVENT NO ROW-COLUMN SCHEME CAN REPRESENT: after the delete there is no membership
    // row left to carry a `previous_spine_id`, so the log is the only place this can live —
    // and it is also why branch_membership_moves carries no FK back to branch_memberships.
    const moves = await readMembershipMoves({ recordId: rec, projectId });
    expect(moves).toHaveLength(1);
    expect(moves[0].fromSpineId).toBe(spine);
    expect(moves[0].toSpineId).toBeNull();
    expect(moves[0].reason).toBe('auto-open, never declared');
    expect(moves[0].actor).toBe(ACTOR);

    // The record itself is untouched — an unassign is not a delete.
    expect((await db.query('SELECT 1 FROM contexts WHERE id = $1', [rec])).rowCount).toBe(1);
  });

  test('unassigning a record that is on no branch is `absent` and logs nothing', async () => {
    const { projectId, conn } = await freshCase('t5-absent');
    const rec = await unpositionedContext(projectId, 't5-absent-rec', 'never on a branch');
    const r = await viaTool('branch_unassign', { id: rec.id }, conn);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.action).toBe('absent');
    expect(r.structuredContent.previousSpineId).toBeNull();
    expect(await readMembershipMoves({ recordId: rec.id, projectId })).toEqual([]);
  });
});

// ── T6: CROSS-PROJECT REFUSAL, BOTH LAYERS ───────────────────────────────────────────────
describe('T6 — a membership cannot be assigned or moved across a project boundary', () => {
  test('LAYER 1 (the one that fires in product): a foreign spine resolves to nothing', async () => {
    const foreign = await freshCase('t6-foreign');
    const foreignSpine = await makeSpine(foreign.conn, 'P3 T6 foreign spine');

    const mine = await freshCase('t6-mine');
    const rec = await unpositionedContext(mine.projectId, 't6-rec', 'my record');

    const leaked = await viaTool('branch_assign', { id: rec.id, spine: foreignSpine }, mine.conn);
    expect(leaked.isError).toBe(true);
    expect(responseText(leaked)).toContain('resolves to no context, decision, or task');
    expect((await db.query('SELECT 1 FROM branch_memberships WHERE record_id = $1', [rec.id])).rowCount).toBe(0);

    // The other direction: a foreign RECORD is equally unreachable.
    const foreignRec = await unpositionedContext(foreign.projectId, 't6-frec', 'their record');
    const mySpine = await makeSpine(mine.conn, 'P3 T6 my spine');
    const other = await viaTool('branch_assign', { id: foreignRec.id, spine: mySpine }, mine.conn);
    expect(other.isError).toBe(true);
    expect(responseText(other)).toContain('there is no record to assign');
  });

  test('LAYER 2: a hand-written membership row carrying a FOREIGN project_id is not moved', async () => {
    // The resolver alone will NOT make this red. Record ids are UUIDs, so no PRODUCT path can
    // put a foreign membership row behind a resolvable record — this layer bites only on rows
    // written outside the mint (raw SQL, a migration, a future service), which the table
    // permits. Exactly the argument branch.routes.ts documents for branch_history's own
    // project filter, and the same reason that filter needed a hand-written row to test it.
    const { projectId, conn } = await freshCase('t6-layer2');
    const spine = await makeSpine(conn, 'P3 T6 layer2 spine');
    const otherSpine = await makeSpine(conn, 'P3 T6 layer2 other spine');
    const foreign = await freshCase('t6-layer2-foreign');

    // A record that lives in MY project, whose membership row carries THEIR project id.
    const rec = await unpositionedContext(projectId, 't6-l2-rec', 'mine, mis-scoped row');
    await db.query(
      `INSERT INTO branch_memberships
         (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
          source, project_id)
       VALUES ($1,'context',$2,'task',$2,'task','recorded',$3)`,
      [rec.id, spine, foreign.projectId]
    );

    // PRECONDITION: the row exists and names the foreign project. Without this the refusal
    // below could be a broken tool rather than a scope boundary.
    const pre = await db.query(
      `SELECT project_id::text AS pid FROM branch_memberships WHERE record_id = $1`,
      [rec.id]
    );
    expect(pre.rows[0].pid).toBe(foreign.projectId);

    const refused = await viaTool('branch_assign', { id: rec.id, spine: otherSpine }, conn);
    expect(refused.isError).toBe(true);
    expect(responseText(refused)).toContain("DIFFERENT project's id");

    // AND THE ROW DID NOT MOVE. NOTE WHAT THIS DOES *NOT* PROVE: dropping `AND project_id
    // = $n` from the UPDATE leaves this assertion GREEN, because the handler's pre-check
    // refuses first (measured, Reviewer). The SQL filter is real
    // defense-in-depth — disabling only the pre-check fails here with "membership UPDATE
    // affected 0 rows" — but this test attributes the refusal to the pre-check, not to it.
    const post = await db.query(
      `SELECT spine_id::text AS spine_id, project_id::text AS pid, source
         FROM branch_memberships WHERE record_id = $1`,
      [rec.id]
    );
    expect(post.rows[0]).toMatchObject({ spine_id: spine, pid: foreign.projectId, source: 'recorded' });

    // The same holds for the DELETE.
    const refusedRemove = await viaTool('branch_unassign', { id: rec.id }, conn);
    expect(refusedRemove.isError).toBe(true);
    expect((await db.query('SELECT 1 FROM branch_memberships WHERE record_id = $1', [rec.id])).rowCount).toBe(1);

    // No move was logged for a refusal — an audit trail must not record attempts as changes.
    expect(await readMembershipMoves({ recordId: rec.id, projectId })).toEqual([]);
    expect(await readMembershipMoves({ recordId: rec.id, projectId: foreign.projectId })).toEqual([]);
  });
});

// ── T7: THE TS ENUM AND THE DB CHECK CANNOT DRIFT APART ──────────────────────────────────
describe('T7 — every declared MEMBERSHIP_SOURCE is accepted by the DB, and nothing else is', () => {
  test('all MEMBERSHIP_SOURCE_VALUES insert; a bogus value is rejected by the CHECK', async () => {
    // THE POPULATION IS MEMBERSHIP_SOURCE_VALUES ITSELF, derived from the enum — not a hand
    // list — so a value added to the TS enum without widening migration 090's CHECK is RED
    // here, in the round that adds it. This is what makes the enum and the constraint one
    // fact in two languages rather than two facts that agree today.
    const { projectId, conn } = await freshCase('t7');
    const spine = await makeSpine(conn, 'P3 T7 spine');
    expect(MEMBERSHIP_SOURCE_VALUES.length).toBeGreaterThan(1);

    for (const source of MEMBERSHIP_SOURCE_VALUES) {
      const rec = await unpositionedContext(projectId, `t7-${source}`, `carrier for ${source}`);
      await db.query('DELETE FROM branch_memberships WHERE record_id = $1', [rec.id]);
      await expect(
        rawPool.query(
          `INSERT INTO branch_memberships
             (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
              source, project_id)
           VALUES ($1,'context',$2,'task',$2,'task',$3,$4)`,
          [rec.id, spine, source, projectId]
        ),
        `MEMBERSHIP_SOURCE '${source}' is declared in TypeScript but rejected by the DB CHECK`
      ).resolves.toBeTruthy();
    }

    const bogus = await unpositionedContext(projectId, 't7-bogus', 'carrier for a bogus source');
    await db.query('DELETE FROM branch_memberships WHERE record_id = $1', [bogus.id]);
    // NAMED, not merely "it threw": every other column in this INSERT is byte-identical to
    // the accepted ones above, so a bare rejection would still leave open which constraint
    // fired. This is the assertion that goes RED when the TS enum gains a value the CHECK
    // does not know about — and the one that would have stayed GREEN on any failure at all if
    // it were driven through the redacting product pool.
    await expect(
      rawPool.query(
        `INSERT INTO branch_memberships
           (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
            source, project_id)
         VALUES ($1,'context',$2,'task',$2,'task','not-a-real-source',$3)`,
        [bogus.id, spine, projectId]
      )
    ).rejects.toThrow(/branch_memberships_source_check/);
  });
});

// ── T8: BAND 3 SELF-DRAINS ───────────────────────────────────────────────────────────────
describe('T8 — assigning a band-3 record moves it out of band 3 and into the member set', () => {
  test('tagOnlyNoPosition −1, totalMembers +1, and no code change made that happen', async () => {
    // Band 3 counts records that TAG a spine but carry no membership row anywhere. It is the
    // DISCOVERY SURFACE for branch_assign, and it drains for free: the NOT EXISTS subquery
    // stops counting a record the moment it has a membership row. Deleting that subquery
    // double-counts the record as both a member and unattributable.
    const { projectId, conn } = await freshCase('t8');
    const spine = await makeSpine(conn, 'P3 T8 spine');
    await viaTool('branch_open', { id: spine }, conn);
    const member = ctxId(await viaTool('context_store', { content: 'a real member', type: 'planning' }, conn));
    await viaTool('branch_close', {}, conn);

    // The bait: an unpositioned write that TAGS the spine — the shape a pre-086 write left.
    const baitConn = await joinConn(projectId, 't8-bait');
    await viaTool('branch_close', {}, baitConn);
    const bait = ctxId(
      await viaTool(
        'context_store',
        {
          content: 'tags the spine, no recorded position',
          type: 'planning',
          tags: [`task:${spine.replace(/-/g, '').slice(0, 8)}`],
        },
        baitConn
      )
    );

    const before = await viaTool('branch_history', { id: spine }, conn);
    expect(before.structuredContent.tagOnlyNoPosition).toBe(1);
    expect(before.structuredContent.totalMembers).toBe(1);
    expect(before.structuredContent.exact).toBe(false);
    // BAND 3 NOW RETURNS ITS IDS — the precomputed list of exactly what branch_assign resolves.
    expect(before.structuredContent.tagOnlyNoPositionIds).toEqual([bait]);
    expect(before.structuredContent.tagOnlyIdsTruncated).toBe(false);
    // Both channels: the text names the remedy rather than calling the band a dead end.
    expect(responseText(before)).toContain('branch_assign');

    await viaTool('branch_assign', { id: bait, spine }, conn);

    const after = await viaTool('branch_history', { id: spine }, conn);
    expect(after.structuredContent.tagOnlyNoPosition).toBe(0);
    expect(after.structuredContent.tagOnlyNoPositionIds).toEqual([]);
    expect(after.structuredContent.totalMembers).toBe(2);
    expect(memberIds(after).sort()).toEqual([member, bait].sort());
    // …and with band 3 drained and nothing approximate, the branch is exact again.
    expect(after.structuredContent.exact).toBe(true);
  });
});
