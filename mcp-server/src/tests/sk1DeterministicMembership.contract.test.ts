/**
 * SK1 — DETERMINISTIC BRANCH-MEMBERSHIP MINTING, the acceptance contract
 * (STRONG BONES an earlier spine).
 *
 * Driven through the FULL public path (validate → routeExecutor — the path the HTTP bridge
 * uses), against the disposable migrated ci_* DB. Each describe maps to one scope item:
 *
 *   (a) ONE body-composition rule, shared by all three write paths. The cross-path AGREEMENT
 *       itself is asserted in sk1MembershipCharacterization.contract.test.ts (the Step-0
 *       truth table, kept as the executable unification guard); here we pin the rule's own
 *       contract — which fields are scanned, and that an absent field contributes nothing.
 *   (a2) The measured DEFECT the unification exposed: `position.spineId` was excluded from
 *       the named-id scan even on an origin='trunk' row, where spine_id is provenance and
 *       not a position. A fanned-out session silently lost a real cross-reference.
 *   (c) A positioned write ALWAYS mints declared membership, or reports WHY — the closed
 *       MEMBERSHIP_OUTCOMES set, never a silent no-op.
 *   (d) Byproduct opens (task_claim, task_update→in_progress) still work, AND a byproduct
 *       no longer overwrites a DELIBERATELY opened position.
 *
 * Embeddings mocked to zeros — similarity plays no role in positional membership.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { composePositionalBody, MEMBERSHIP_OUTCOMES } from '../services/positionalMint.js';
import { POSITIONAL_BODY_FIELDS } from '../config/positionalMembershipConfig.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { collectNamedId8s, deriveDeclaredLimbs, buildId8Resolver } from '../services/declaredLimbs.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const responseText = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

let projectForCase = '';
async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'SK1 acceptance fixture') RETURNING id`,
      [`sk1-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  projectForCase = projectId;
  const conn = `sk1-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}
/** A second, independent connection in the SAME project (its own position slot). */
async function siblingConn(label: string): Promise<string> {
  const conn = `sk1-conn-${label}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`;
  await routeExecutor('project_switch', { project: projectForCase }, { connectionId: conn });
  return conn;
}

async function edgeRows(fromId: string): Promise<Array<{ edgeType: string; createdBy: string | null; toId: string; via: string | null }>> {
  return (
    await db.query(
      // `via` is the mint_via COLUMN since SK4 — it was metadata->>'via'
      // when this suite was written. Same values, same assertions; one normalized home.
      `SELECT edge_type, created_by, to_id, mint_via AS via
         FROM links WHERE from_id = $1 ORDER BY edge_type, to_id`,
      [fromId]
    )
  ).rows.map((r) => ({ edgeType: r.edge_type, createdBy: r.created_by, toId: r.to_id, via: r.via }));
}
const edgesTo = async (fromId: string, toId: string) => (await edgeRows(fromId)).filter((e) => e.toId === toId);

const positional = (resp: any, key: 'context' | 'task' | 'decision') => resp.structuredContent[key].positional;

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

// ── (a) ONE BODY-COMPOSITION RULE ────────────────────────────────────────────────────────
describe('(a) one body-composition rule, in one place', () => {
  test('composePositionalBody scans exactly the configured fields, and an absent field adds nothing', () => {
    expect(composePositionalBody('context', { content: 'hello' })).toBe('hello');
    expect(composePositionalBody('task', { title: 't', description: 'd' })).toBe('t\nd');
    expect(composePositionalBody('decision', {
      title: 't', description: 'd', rationale: 'r', problemStatement: 'p',
    })).toBe('t\nd\nr\np');

    // THE FAILURE THIS PREVENTS: `${args.description}` on an absent field used to be capable
    // of injecting the literal word "undefined" into the scanned text — characters the
    // writer never typed, feeding a matcher that decides membership.
    const composed = composePositionalBody('task', { title: 'only a title' });
    expect(composed).toBe('only a title\n');
    expect(composed).not.toContain('undefined');
    expect(composePositionalBody('decision', { title: 'x', rationale: null })).toBe('x\n\n\n');

    // A field NOT in the rule is not scanned, however it is passed.
    expect(composePositionalBody('task', { title: 't', description: 'd', outcomeNotes: 'IGNORED' }))
      .not.toContain('IGNORED');
    expect(Object.keys(POSITIONAL_BODY_FIELDS).sort()).toEqual(['context', 'decision', 'task']);
  });
});

// ── (a2) THE TRUNK-PROVENANCE EXCLUSION DEFECT ───────────────────────────────────────────
describe('(a2) an origin=trunk spine_id is provenance, not a position — it must not be excluded from the scan', () => {
  test('after a fan-out revert, a record naming the reverted-from task still references it', async () => {
    const { conn } = await freshCase('trunkprov');
    // Two same-type creates in a row on a virgin session = R1 auto-open then R2 fan-out
    // revert. The session now sits at origin='trunk' with spine_id retaining task A.
    const tA = (await viaTool('task_create', { title: 'A', type: 'feature' }, conn)).structuredContent.task.id;
    const tB = (await viaTool('task_create', { title: 'B', type: 'feature' }, conn)).structuredContent.task.id;
    const posRow = await db.query(
      `SELECT origin, spine_id FROM branch_positions WHERE project_id = $1 AND session_key = $2`,
      [projectForCase, conn]
    );
    expect(posRow.rows[0], 'the fixture must actually be at trunk, retaining A').toMatchObject({
      origin: 'trunk', spine_id: tA,
    });

    // A record naming BOTH tasks is a 2-name TRUNK record. Before the fix, A was excluded
    // as "the spine", leaving one name — so it was classified as a 1-name record and the
    // reference edge to A was never minted at all.
    const resp = await viaTool(
      'context_store',
      { content: `this write names ${id8(tA)} and ${id8(tB)}`, type: 'discussion' },
      conn
    );
    const ctx = resp.structuredContent.context.id;
    const rep = positional(resp, 'context');
    expect(rep.namedTaskIds.sort()).toEqual([tA, tB].sort());
    expect(rep.trunk).toBe(true);

    for (const [label, t] of [['reverted-from A', tA], ['other B', tB]] as const) {
      expect(await edgesTo(ctx, t), `trunk reference edge to ${label}`).toEqual([
        { edgeType: 'related_to', createdBy: 'auto:positional', toId: t, via: 'trunk-ref' },
      ]);
    }
  });

  test('on a REAL (declared) position the spine is still excluded — naming your own branch is not a cross-reference', async () => {
    const { conn } = await freshCase('declaredexcl');
    const setup = await siblingConn('declaredexcl-setup');
    const tA = (await viaTool('task_create', { title: 'A', type: 'feature' }, setup)).structuredContent.task.id;
    const tB = (await viaTool('task_create', { title: 'B', type: 'feature' }, setup)).structuredContent.task.id;

    await viaTool('branch_open', { id: id8(tA) }, conn);
    const resp = await viaTool(
      'context_store',
      { content: `standing on ${id8(tA)}, also mentioning ${id8(tB)}`, type: 'discussion' },
      conn
    );
    const rep = positional(resp, 'context');
    expect(rep.namedTaskIds, 'the spine you are standing on is not a foreign name').toEqual([tB]);
    expect(rep.trunk).toBe(false);
    expect(rep.membership).toEqual({ minted: true, reason: 'minted' });
  });
});

// ── (c) POSITIONED WRITES MINT DECLARED MEMBERSHIP, OR SAY WHY ───────────────────────────
describe('(c) membership is never a silent no-op — minted, or a reason from the closed set', () => {
  test('a positioned context_store AND task_create both mint declared via:position membership', async () => {
    const { conn } = await freshCase('mint');
    const setup = await siblingConn('mint-setup');
    const spine = (await viaTool('task_create', { title: 'the spine', type: 'feature' }, setup)).structuredContent.task.id;
    await viaTool('branch_open', { id: id8(spine) }, conn);

    const ctxResp = await viaTool('context_store', { content: 'a capture on the branch', type: 'discussion' }, conn);
    const taskResp = await viaTool('task_create', { title: 'a task on the branch', type: 'feature' }, conn);

    for (const [label, resp, key] of [
      ['context_store', ctxResp, 'context'],
      ['task_create', taskResp, 'task'],
    ] as const) {
      expect(positional(resp, key).membership, `${label} membership report`).toEqual({ minted: true, reason: 'minted' });
      const recordId = resp.structuredContent[key].id;
      // THE ROW, not the report — the report is what we are also testing.
      expect(await edgesTo(recordId, spine), `${label} → spine row`).toEqual([
        { edgeType: 'informs', createdBy: 'auto:positional', toId: spine, via: 'position' },
      ]);
    }
  });

  test('every no-mint outcome reports a reason from the closed set, and the two silent ones now speak', async () => {
    const { conn } = await freshCase('reasons');
    const setup = await siblingConn('reasons-setup');
    const spine = (await viaTool('task_create', { title: 'spine', type: 'feature' }, setup)).structuredContent.task.id;
    const other = (await viaTool('task_create', { title: 'other', type: 'feature' }, setup)).structuredContent.task.id;

    // no-position: a virgin connection's capture.
    const unpositioned = await siblingConn('reasons-unpos');
    const noPos = await viaTool('context_store', { content: 'nowhere in particular', type: 'discussion' }, unpositioned);
    expect(positional(noPos, 'context').membership).toEqual({ minted: false, reason: 'no-position' });

    await viaTool('branch_open', { id: id8(spine) }, conn);

    // opted-out: minted nothing before, and said nothing. Now both.
    const opted = await viaTool(
      'context_store',
      { content: 'deliberately unthreaded', type: 'discussion', noAutoThread: true },
      conn
    );
    expect(positional(opted, 'context').membership).toEqual({ minted: false, reason: 'opted-out' });
    expect(responseText(opted)).toContain('auto-threading was opted out');

    // trunk-record: ≥2 named FOREIGN ids, from a connection that is NOT standing on a
    // deliberately opened branch. The position matters here since the precedence gate (a3):
    // a declared position outranks the multi-name rule, so this case must be measured where
    // no such stance exists — otherwise it exercises the gate rather than the demotion.
    const third = (await viaTool('task_create', { title: 'third', type: 'feature' }, setup)).structuredContent.task.id;
    const trunkConn = await siblingConn('reasons-trunkrec');
    const trunkRec2 = await viaTool(
      'context_store',
      { content: `covers ${id8(other)} and ${id8(third)}`, type: 'discussion' },
      trunkConn
    );
    expect(positional(trunkRec2, 'context').membership).toEqual({ minted: false, reason: 'trunk-record' });

    // record-is-spine: write onto the branch root itself (a decision spine keeps it simple).
    const decResp = await viaTool('decision_record', {
      decisionType: 'architecture', title: 'a spine decision', description: 'd', rationale: 'r', impactLevel: 'low',
    }, await siblingConn('reasons-selfspine'));
    // R1 auto-opened on that decision; a SECOND write of a different type extends the branch,
    // so to hit record-is-spine we branch_open the record and re-store it is not possible —
    // instead, stand ON the decision and observe the R1 case directly.
    expect(positional(decResp, 'decision').membership).toEqual({ minted: false, reason: 'record-is-spine' });
    expect(positional(decResp, 'decision').autoOpened).toBe(true);

    // Whatever the reason, it is always one of the declared outcomes — no free-form drift.
    for (const r of [noPos, opted, trunkRec2]) {
      expect(MEMBERSHIP_OUTCOMES).toContain(positional(r, 'context').membership.reason);
    }
  });
});

// ── (a3) THE TRUNK-REVERSION PRECEDENCE GATE ────────────────────────────────────────────
describe('(a3) a DELIBERATE position outranks the multi-name rule — membership AND trunk-refs', () => {
  test('declared position + >=2 named ids: keeps membership, still attaches to each named task', async () => {
    const { conn } = await freshCase('precedence');
    const setup = await siblingConn('precedence-setup');
    const spine = (await viaTool('task_create', { title: 'the branch I opened', type: 'feature' }, setup)).structuredContent.task.id;
    const nA = (await viaTool('task_create', { title: 'cited A', type: 'feature' }, setup)).structuredContent.task.id;
    const nB = (await viaTool('task_create', { title: 'cited B', type: 'feature' }, setup)).structuredContent.task.id;

    await viaTool('branch_open', { id: id8(spine) }, conn);
    const resp = await viaTool(
      'context_store',
      { content: `coordination note citing ${id8(nA)} and ${id8(nB)}`, type: 'discussion' },
      conn
    );
    const ctx = resp.structuredContent.context.id;
    const rep = positional(resp, 'context');

    // The multi-topic FACT is still true; the DEMOTION is what the gate suppresses.
    expect(rep.multiName).toBe(true);
    expect(rep.trunk, 'a deliberately opened position is not demoted by prose').toBe(false);
    expect(rep.membership).toEqual({ minted: true, reason: 'minted' });

    // BOTH, at the row level — this is the whole point: additive, not a swap.
    expect(await edgesTo(ctx, spine), 'membership to the branch survives').toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: spine, via: 'position' },
    ]);
    for (const [label, t] of [['cited A', nA], ['cited B', nB]] as const) {
      expect(await edgesTo(ctx, t), `trunk-ref to ${label} still mints`).toEqual([
        { edgeType: 'related_to', createdBy: 'auto:positional', toId: t, via: 'trunk-ref' },
      ]);
    }
    expect(responseText(resp)).toContain('AND still a member of the branch you opened deliberately');
  });

  test('a BYPRODUCT position is NOT protected — today\'s demotion is unchanged there', async () => {
    // The control for the gate's SCOPE. Only 'declared' is protected; an inferred position
    // does not outrank a prose signal. Without this, the gate could be widened to every
    // origin and nothing would notice.
    const { conn } = await freshCase('precedence-byproduct');
    const setup = await siblingConn('precedence-byproduct-setup');
    const work = (await viaTool('task_create', { title: 'work started via status flip', type: 'feature' }, setup)).structuredContent.task.id;
    const nA = (await viaTool('task_create', { title: 'cited A', type: 'feature' }, setup)).structuredContent.task.id;
    const nB = (await viaTool('task_create', { title: 'cited B', type: 'feature' }, setup)).structuredContent.task.id;

    await viaTool('task_update', { taskId: id8(work), status: 'in_progress' }, conn);
    const row = await db.query(
      `SELECT origin FROM branch_positions WHERE project_id = $1 AND session_key = $2`,
      [projectForCase, conn]
    );
    expect(row.rows[0].origin, 'the fixture must really be on a byproduct position').toBe('byproduct');

    const resp = await viaTool(
      'context_store',
      { content: `note citing ${id8(nA)} and ${id8(nB)}`, type: 'discussion' },
      conn
    );
    const rep = positional(resp, 'context');
    expect(rep.multiName).toBe(true);
    expect(rep.trunk, 'an inferred position does NOT outrank the multi-name rule').toBe(true);
    expect(rep.membership).toEqual({ minted: false, reason: 'trunk-record' });
    expect(await edgesTo(resp.structuredContent.context.id, work), 'no membership from a byproduct position').toEqual([]);
  });
});

// ── (d) BYPRODUCT OPENS ──────────────────────────────────────────────────────────────────
describe('(d) byproduct opens still work, and yield to a deliberately opened position', () => {
  test('task_claim opens the position; a SECOND live claim contests the slot instead of taking it', async () => {
    const { conn } = await freshCase('byproduct');
    const setup = await siblingConn('byproduct-setup');
    const t1 = (await viaTool('task_create', { title: 'claim me', type: 'feature' }, setup)).structuredContent.task.id;
    const t2 = (await viaTool('task_create', { title: 'progress me', type: 'feature' }, setup)).structuredContent.task.id;

    // The claim feature defaults dark (MANDREL_TASK_CLAIM_ENABLED=false); flip the live
    // config for this case exactly as positionalMembership.contract.test.ts does.
    TASK_CLAIM_CONFIG.enabled = true;
    const claim = await viaTool('task_claim', { taskId: id8(t1), actor: 'sk1-test' }, conn);
    TASK_CLAIM_CONFIG.enabled = false;
    expect(claim.structuredContent.claimed).toBe(true);
    expect(claim.structuredContent.position).toEqual({ spineId: t1, spineType: 'task' });
    expect(claim.structuredContent.positionYielded).toBe(false);

    // MIGRATION 084: the stored row must say this was a BYPRODUCT. Before 084 it stored
    // 'declared' — the same value a deliberate branch_open stores — which is precisely why
    // no yield rule could be written against the row.
    const claimRow = await db.query(
      `SELECT origin, tip_id FROM branch_positions WHERE project_id = $1 AND session_key = $2`,
      [projectForCase, conn]
    );
    expect(claimRow.rows[0]).toMatchObject({ origin: 'byproduct', tip_id: null });

    // A write now lands on t1 — the byproduct open is REAL, not just reported.
    const w1 = await viaTool('context_store', { content: 'working the claimed task', type: 'discussion' }, conn);
    expect(await edgesTo(w1.structuredContent.context.id, t1)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: t1, via: 'position' },
    ]);

    // in_progress on a DIFFERENT task NO LONGER MOVES IT — it CONTESTS it.
    //
    // THIS ASSERTION WAS INVERTED DELIBERATELY, and the old one is worth quoting because it
    // is the defect written down as a contract: "in_progress on a DIFFERENT task moves it
    // (both byproducts — neither is protected)". That is last-writer-wins on a slot, and on
    // a shared transport it is what let eight concurrent Builders stamp DECLARED membership
    // onto each other's spines — four confirmations in an earlier task's noteLog, and 93
    // edges on prod whose author's own `task:` tag names a different task than the edge.
    //
    // Two live claims cannot share one slot and the slot cannot say which agent it belongs
    // to, so it goes to TRUNK and SAYS SO. The rule, its population and its price:
    // config/positionContentionConfig.ts.
    const upd = await viaTool('task_update', { taskId: id8(t2), status: 'in_progress' }, conn);
    expect(String(upd.content?.[0]?.text ?? '')).toContain('TRUNK');
    const w2 = await viaTool('context_store', { content: 'now on the second task', type: 'discussion' }, conn);
    expect(await edgesTo(w2.structuredContent.context.id, t2)).toEqual([]);
    expect(await edgesTo(w2.structuredContent.context.id, t1)).toEqual([]);

    // AND THE WAY BACK, exercised here rather than asserted elsewhere: one DECLARED act
    // takes a real position again and membership resumes. Without this the test would read
    // as "the second claim breaks positioning", which is not what the rule says.
    await viaTool('branch_open', { id: id8(t2) }, conn);
    const w3 = await viaTool('context_store', { content: 'declared onto the second task', type: 'discussion' }, conn);
    expect(await edgesTo(w3.structuredContent.context.id, t2)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: t2, via: 'position' },
    ]);
  });

  test('a byproduct does NOT drag a position the session opened deliberately', async () => {
    const { conn } = await freshCase('yield');
    const setup = await siblingConn('yield-setup');
    const spine = (await viaTool('task_create', { title: 'the branch I chose', type: 'feature' }, setup)).structuredContent.task.id;
    const dispatched = (await viaTool('task_create', { title: 'a task I am only dispatching', type: 'feature' }, setup)).structuredContent.task.id;

    await viaTool('branch_open', { id: id8(spine) }, conn);

    // THE MEASURED SHAPE (prod, 2026-08-15): a coordinator flips someone else's task to
    // in_progress. Last-write-wins dragged the position onto it, and every following write
    // minted a DECLARED — and wrong — membership edge to a task nobody was working on.
    const upd = await viaTool('task_update', { taskId: id8(dispatched), status: 'in_progress' }, conn);
    expect(upd.structuredContent.positionYielded, 'the byproduct must yield').toBe(true);
    expect(upd.structuredContent.position, 'and report where the session actually still is').toEqual({
      spineId: spine, spineType: 'task',
    });
    expect(responseText(upd)).toContain('Branch position KEPT');
    expect(responseText(upd), 'the override must be named, not implied').toContain(`branch_open ${id8(dispatched)}`);

    // The DB row is the authority: the declared position is untouched.
    const row = await db.query(
      `SELECT spine_id, origin FROM branch_positions WHERE project_id = $1 AND session_key = $2`,
      [projectForCase, conn]
    );
    expect(row.rows[0]).toMatchObject({ spine_id: spine, origin: 'declared' });

    // And the consequence that actually matters: the next write is still a member of the
    // branch the writer chose, not of the task they merely dispatched.
    const w = await viaTool('context_store', { content: 'a note while coordinating', type: 'discussion' }, conn);
    const ctx = w.structuredContent.context.id;
    expect(await edgesTo(ctx, spine)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: spine, via: 'position' },
    ]);
    expect(await edgesTo(ctx, dispatched), 'ZERO edges to the merely-dispatched task').toEqual([]);

    // A byproduct onto the SAME task you are declared-standing on is not a yield — nothing
    // moves and nothing needs saying.
    const same = await viaTool('task_update', { taskId: id8(spine), status: 'in_progress' }, conn);
    expect(same.structuredContent.positionYielded).toBe(false);
    expect(same.structuredContent.position).toEqual({ spineId: spine, spineType: 'task' });

    // THE STORED ROW IS THE AUTHORITY, and this is the assertion whose ABSENCE hid a real
    // defect (Reviewer REJECT r1). The two response assertions above pass whether or not
    // the row was damaged: the spine genuinely did not move and nothing was declined, so the
    // ONLY field that changed — `origin` — is not visible in either of them. The first
    // version of the yield guard also required `spineId !== input.spineId`, so a same-spine
    // byproduct fell through to openPosition's UPSERT (`origin = EXCLUDED.origin`) and
    // rewrote 'declared' as 'byproduct'. One downgraded row disarmed BOTH shipped rules at
    // once — the next byproduct stopped yielding, and the multi-name gate resumed demoting
    // deliberate writes — while every response field still read exactly as expected.
    const sameRow = await db.query(
      `SELECT origin FROM branch_positions WHERE project_id = $1 AND session_key = $2`,
      [projectForCase, conn]
    );
    expect(sameRow.rows[0].origin, 'a byproduct must NEVER overwrite a declared origin — not even onto the same spine').toBe('declared');

    // THE CONSEQUENCE, exercised rather than argued: with the row intact, a byproduct onto a
    // DIFFERENT task still yields, and a multi-name write is still protected by the gate.
    const upd2 = await viaTool('task_update', { taskId: id8(dispatched), status: 'in_progress' }, conn);
    expect(upd2.structuredContent.positionYielded, 'the yield rule survives a same-spine byproduct').toBe(true);
    const mn = await viaTool(
      'context_store',
      { content: `after the same-spine flip, citing ${id8(dispatched)} and ${id8(spine)}`, type: 'discussion' },
      conn
    );
    expect(positional(mn, 'context').trunk, 'the multi-name gate survives a same-spine byproduct').toBe(false);

    // An explicit branch_open still moves it — the deliberate act is never blocked.
    await viaTool('branch_open', { id: id8(dispatched) }, conn);
    const w2 = await viaTool('context_store', { content: 'now deliberately here', type: 'discussion' }, conn);
    expect(await edgesTo(w2.structuredContent.context.id, dispatched)).toHaveLength(1);
  });
});

// ── FOLD-IN: does LIMB_ID8_PATTERN mis-parse a full UUID? (asked during SK1 mapping) ─────
//
// THE CONCERN: positionalMint's ID8_RE carries `(?!-)` so a full UUID's leading octet is not
// ALSO matched as a bare id8; declaredLimbsConfig's LIMB_ID8_PATTERN carries no such guard,
// and it runs on the SAME writes one layer down to materialise `declared_limbs`.
//
// THE ANSWER, measured below rather than argued: it is HARMLESS, and the guard would be
// WRONG to add. The leading octet of a UUID IS that record's id8 — resolution is
// `left(id::text, 8) = <token>` (declaredLimbsStore.ts) — so the "spurious" match resolves
// to the very record the UUID names. The two layers reach the same limb by different routes:
// positionalMint matches the whole UUID and excludes the octet; declaredLimbs matches the
// octet and never looks at the whole. Adding `(?!-)` here would make a body that cites a
// record ONLY in full-UUID form declare no limb at all — a real regression — and it would
// break the golden parity with hierarchy.py that the measured P/R numbers rest on
// (declaredLimbsGoldenParity.contract.test.ts). So: NOT a defect, and deliberately unchanged.
describe('fold-in — LIMB_ID8_PATTERN on a full UUID: measured, not assumed', () => {
  test('a full UUID in the body yields exactly its own id8, which resolves to that same record', () => {
    const uuid = '2e21d2ac-1111-4222-8333-444455556666';
    const rec = {
      id: 'aaaaaaaa-0000-4000-8000-000000000000',
      type: 'context' as const,
      body: `see ${uuid} for the rationale`,
      tags: [] as string[],
    };
    const { bodyId8s } = collectNamedId8s(rec);
    // EXACTLY ONE token — not zero (which would mean full-UUID citations declare nothing)
    // and not two (which would be the double-count the guard is meant to prevent).
    expect(bodyId8s).toEqual(['2e21d2ac']);

    // And it resolves to the record the UUID actually names — the octet is not "bogus".
    const derived = deriveDeclaredLimbs(rec, buildId8Resolver([{ id: uuid, type: 'task' }]));
    expect(derived.limbs).toEqual([uuid]);
    expect(derived.ambiguousDrops).toBe(0);
  });

  test('the same body through BOTH layers agrees on the count Coordinator measured live: two', () => {
    // Coordinator's prod fixture: two ids, cited in mixed full-UUID and bare-id8 form. The live
    // mint report resolved exactly 2. The limb layer must not see 4.
    const a = 'efc03f42-1111-4222-8333-444455556666';
    const b = '2e21d2ac-9999-4888-8777-666655554444';
    const rec = {
      id: 'bbbbbbbb-0000-4000-8000-000000000000',
      type: 'decision' as const,
      body: `supersedes ${a} and relates to 2e21d2ac (full: ${b})`,
      tags: ['task:efc03f42'],
    };
    const derived = deriveDeclaredLimbs(
      rec,
      buildId8Resolver([{ id: a, type: 'task' }, { id: b, type: 'task' }])
    );
    // The record's own id is a limb root (it is a decision), plus the two cited tasks.
    expect(derived.limbs.filter((l) => l !== rec.id).sort()).toEqual([a, b].sort());
  });

  test('a 40-hex commit sha and a 7-hex short sha still match nothing', () => {
    const rec = {
      id: 'cccccccc-0000-4000-8000-000000000000',
      type: 'context' as const,
      body: 'at a66f93a and 0123456789abcdef0123456789abcdef01234567',
      tags: [] as string[],
    };
    expect(collectNamedId8s(rec).bodyId8s).toEqual([]);
  });
});
