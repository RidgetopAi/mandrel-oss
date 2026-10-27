/**
 * P1 — A HANDOFF IS TRUNK MATERIAL BY TYPE
 * (spec an earlier context.)
 *
 * THE RULE UNDER TEST: a context whose `context_type` is `handoff` is ALWAYS a trunk record
 * and NEVER a branch member. The classification is made from the TYPE alone; the branch the
 * author happened to be standing on must not enter it.
 *
 * ── WHY THE FIXTURE LOOKS THE WAY IT DOES ────────────────────────────────────────────
 * THE SMALLEST INPUT WHERE THE FIXED AND BROKEN BRANCHES DIVERGE is a handoff that
 *   (a) is written from a position whose origin is 'declared', and
 *   (b) names ZERO task ids.
 * Both halves are load-bearing, and a fixture missing either one passes over the defect:
 *   (a) 'declared' is the ONE origin the pre-P1 rule PROTECTED from demotion, so any other
 *       origin would have reached the trunk anyway and the assertion would prove nothing.
 *       Measured on prod 2026-08-21: the only 2 handoffs of 33 that were trapped as branch
 *       members were trapped precisely because their authors had opened a position
 *       deliberately.
 *   (b) zero named ids keeps the record OUT of the `multiName` block in positionalMint.ts,
 *       which contains an early `return` of its own. A handoff naming >= 2 ids leaves that
 *       block before the membership mint is ever reached, so it would report `trunk: true`
 *       under BOTH a correct fix and the hollow one-line version — see PROBE 2 below.
 *
 * ── WHAT MAKES THIS GUARD NON-HOLLOW ─────────────────────────────────────────────────
 * A rule that trunks EVERYTHING would satisfy every handoff assertion here. So the same
 * fixture is run a second time with `type: 'planning'` and asserted to be a MEMBER, on the
 * same spine, in the same project, through the same wire. The control is not decoration: it
 * is the half that makes the handoff assertions mean "because it is a handoff".
 *
 * ── THE POPULATION THIS GUARD ENUMERATES, AND WHY IT IS THE WHOLE ONE ────────────────
 * The rule's input is (context_type, position origin). `context_type` is covered by the
 * handoff/planning pair. POSITION ORIGIN is the axis with more than two values, and the
 * rule must be indifferent to ALL of them — that indifference IS the rule. The origins a
 * write can actually be made from are 'declared' (branch_open), 'auto' (R1 auto-open) and
 * 'byproduct' (task_claim / task_update to in_progress); 'trunk' is not a position at all,
 * and reaches the same terminal arm.
 *
 * ROUND 1 OF THIS FILE COVERED ONLY 'declared', AND REVIEWER BUILT A FALSE GREEN WITH IT.
 * This implementation passed all 7 tests:
 *     report.trunk =
 *       (input.contextType === TRUNK_CONTEXT_TYPE && report.position?.origin === 'declared')
 *       || (report.multiName && report.position?.origin !== 'declared');
 * It is broken — it re-introduces the exact "where the author stood decides" coupling P1
 * exists to remove, for every handoff written from an auto-opened or byproduct position —
 * and the round-1 fixture could not see it, because that population was not in it. The
 * SHIPPED code was measured on that population and is correct; the guard was narrow, not
 * the product. Test 7 below closes it, and its non-hollowness is proved against exactly
 * that implementation (mutation probe 3).
 *
 * ── THE TWO MUTATION PROBES THIS FILE IS BUILT TO ANSWER ─────────────────────────────
 * PROBE 1 — revert the by-type disjunct in positionalMint.ts (`input.contextType ===
 *   TRUNK_CONTEXT_TYPE ||`). The zero-ids handoff assertions go RED; the planning control
 *   stays GREEN.
 * PROBE 2 — KEEP that disjunct and remove ONLY the `report.trunk ? 'trunk-record'` arm from
 *   the `blocked` ladder. This is the "looks like a one-liner" implementation: `trunk` is
 *   set correctly and reported correctly, and the record is minted a membership anyway,
 *   because the only `return` that honours the flag lives inside `if (report.multiName)`.
 *   The zero-ids case must still go RED. THAT is why the membership TABLE and the EDGE are
 *   asserted here and not just the reported `trunk` boolean — under probe 2 the boolean is
 *   true and the row exists, and a test reading only the boolean would report a green over a
 *   fully-present defect.
 * PROBE 3 — the ORIGIN-COUPLED implementation quoted above (Reviewer's false green, round
 *   1). Tests 1-6 all pass under it; test 7 must go RED, and the planning control GREEN.
 *
 * Behavioral through routeExecutor against the CI Postgres — the same wire a real
 * context_store crosses, with a REAL branch_open establishing the position. Nothing is
 * hand-inserted: a hand-written membership row would prove a query works, not that the
 * system records what the author did.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { TRUNK_CONTEXT_TYPE } from '../services/handoffSupersession.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const CONN = `p1-handoff-conn-${STAMP}`;
/**
 * A SECOND connection, because a position is keyed per project+session: the auto-open case
 * needs a session with NO branch open, and CONN has a declared one for the whole file.
 */
const AUTO_CONN = `p1-handoff-auto-conn-${STAMP}`;
const PROJ_NAME = `p1-handoff-P-${STAMP}`;

let projectId = '';
/** The spine the whole file stands on — a task, opened with a DECLARED branch_open. */
let spineId = '';
/** Two further tasks, named in prose by the ref-preservation case only. */
let refTaskA = '';
let refTaskB = '';

/** The three writes under test. */
let handoffNoIds = '';
let planningControl = '';
let handoffTwoIds = '';
/** The auto-open case: the task whose CREATE opened the position, and the handoff after it. */
let autoSpineId = '';
let handoffFromAuto = '';

async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN });
}
/** The same wire, on the connection whose position is AUTO-opened rather than declared. */
async function viaAutoTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: AUTO_CONN });
}

/** The human-readable response body — the channel an agent actually reads. */
function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** Membership rows on file for one record, as `spine_id` strings. */
async function membershipSpines(recordId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT spine_id::text AS spine FROM branch_memberships WHERE record_id = $1`,
    [recordId],
  );
  return r.rows.map((x: any) => x.spine);
}

/** Every edge this record minted, as `mint_via|edge_type|to_id` strings. */
async function outboundEdges(recordId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT mint_via, edge_type, to_id::text AS to_id FROM links WHERE from_id = $1`,
    [recordId],
  );
  return r.rows.map((x: any) => `${x.mint_via}|${x.edge_type}|${x.to_id}`).sort();
}

describe('P1 — a handoff is trunk material by TYPE, on the real wire', () => {
  let handoffReport: any;
  let handoffText = '';
  let controlReport: any;
  let twoIdReport: any;
  let autoReport: any;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'p1 handoff trunk by type') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    spineId = (await viaTool('task_create', { title: `p1 spine ${STAMP}`, type: 'general' }))
      .structuredContent.task.id;
    refTaskA = (await viaTool('task_create', { title: `p1 ref A ${STAMP}`, type: 'general' }))
      .structuredContent.task.id;
    refTaskB = (await viaTool('task_create', { title: `p1 ref B ${STAMP}`, type: 'general' }))
      .structuredContent.task.id;

    // THE DELIBERATE POSITION. Everything below is written while standing here.
    await viaTool('branch_open', { id: spineId });

    // (1) THE DEFECT'S OWN SHAPE: a handoff naming no ids at all.
    const handoffResp = await viaTool('context_store', {
      content: `P1-HANDOFF-${STAMP}\nMODE: build\nPATH: roots -> trunk\nA resume point that names nothing.`,
      type: TRUNK_CONTEXT_TYPE,
    });
    handoffNoIds = handoffResp.structuredContent.context.id;
    handoffReport = handoffResp.structuredContent.context.positional;
    handoffText = responseText(handoffResp);

    // (2) THE CONTROL: byte-for-byte the same situation, a different type.
    const controlResp = await viaTool('context_store', {
      content: `P1-CONTROL-${STAMP}\nMODE: build\nPATH: roots -> trunk\nA resume point that names nothing.`,
      type: 'planning',
    });
    planningControl = controlResp.structuredContent.context.id;
    controlReport = controlResp.structuredContent.context.positional;

    // (3) REF PRESERVATION: a positioned handoff that DOES name two tasks. Its weak
    //     `trunk-ref` attachments must survive — they are what a trunk record is supposed to
    //     have, and they are the only reason the accidental 31 were findable at all.
    const twoIdResp = await viaTool('context_store', {
      content:
        `P1-TWOID-${STAMP}\nANCHORS: ${refTaskA.slice(0, 8)} and ${refTaskB.slice(0, 8)}\n` +
        `A handoff that names two tasks.`,
      type: TRUNK_CONTEXT_TYPE,
    });
    handoffTwoIds = twoIdResp.structuredContent.context.id;
    twoIdReport = twoIdResp.structuredContent.context.positional;

    // (4) THE ORIGIN THE ROUND-1 FIXTURE MISSED. A separate connection with no branch open:
    //     its first task_create AUTO-OPENS a position (R1, origin='auto'), and the handoff
    //     is written from there. Nothing here calls branch_open — the position is a
    //     byproduct of ordinary work, which is the common case, not the careful one.
    await routeExecutor('project_switch', { project: projectId }, { connectionId: AUTO_CONN });
    autoSpineId = (
      await viaAutoTool('task_create', { title: `p1 auto spine ${STAMP}`, type: 'general' })
    ).structuredContent.task.id;
    const autoResp = await viaAutoTool('context_store', {
      content: `P1-AUTO-${STAMP}\nMODE: build\nPATH: roots -> trunk\nA handoff from an auto position.`,
      type: TRUNK_CONTEXT_TYPE,
    });
    handoffFromAuto = autoResp.structuredContent.context.id;
    autoReport = autoResp.structuredContent.context.positional;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM branch_memberships WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* teardown is best-effort; the disposable DB is dropped anyway */
    }
  });

  test('FIXTURE PRECONDITION: the position really is DECLARED, and the handoff named zero ids', () => {
    // Asserted rather than assumed. If branch_open had failed, or if the handoff body had
    // accidentally contained a resolvable 8-hex token, every assertion below would pass
    // vacuously — against the one origin the broken rule already handled, or through the
    // multiName block that hides the defect. This is the guard on the guard's INPUT, which
    // is the only thing worth guarding twice.
    expect(handoffReport.position?.spineId, 'the handoff was written from the spine').toBe(spineId);
    expect(handoffReport.position?.origin, 'origin must be declared — the protected case').toBe(
      'declared',
    );
    expect(handoffReport.namedTaskIds, 'the handoff names ZERO task ids').toEqual([]);
    expect(handoffReport.multiName, 'so the multiName block cannot mask the result').toBe(false);
    expect(controlReport.position?.origin, 'the control stood in the SAME place').toBe('declared');
    expect(controlReport.namedTaskIds, 'and named zero ids too').toEqual([]);
  });

  test('1. the handoff REPORTS itself as trunk, with the trunk-record reason', () => {
    expect(handoffReport.trunk).toBe(true);
    expect(handoffReport.membership).toEqual({ minted: false, reason: 'trunk-record' });
  });

  test('2. NO membership row is on file for the handoff (the fact)', async () => {
    expect(await membershipSpines(handoffNoIds)).toEqual([]);
  });

  test('3. NO mint_via=position edge was minted from the handoff (the same fact in the graph)', async () => {
    const positional = (await outboundEdges(handoffNoIds)).filter((e) =>
      e.startsWith(`${EDGE_MINT_VIA.position}|`),
    );
    expect(positional).toEqual([]);
  });

  test('4. CONTROL — the identical write with type:planning IS a member of the same spine', async () => {
    // Without this, a rule that trunked every context would pass tests 1-3.
    expect(controlReport.trunk).toBe(false);
    expect(controlReport.membership).toEqual({ minted: true, reason: 'minted' });
    expect(await membershipSpines(planningControl)).toEqual([spineId]);
    const positional = (await outboundEdges(planningControl)).filter((e) =>
      e.startsWith(`${EDGE_MINT_VIA.position}|`),
    );
    expect(positional).toEqual([`${EDGE_MINT_VIA.position}|informs|${spineId}`]);
  });

  test('5. a positioned handoff naming two tasks keeps BOTH trunk-refs and gains no membership', async () => {
    expect(twoIdReport.trunk).toBe(true);
    expect(twoIdReport.multiName).toBe(true);
    expect(twoIdReport.membership).toEqual({ minted: false, reason: 'trunk-record' });
    expect(await membershipSpines(handoffTwoIds)).toEqual([]);

    const edges = await outboundEdges(handoffTwoIds);
    expect(edges.filter((e) => e.startsWith(`${EDGE_MINT_VIA.trunkRef}|`)).sort()).toEqual(
      [
        `${EDGE_MINT_VIA.trunkRef}|related_to|${refTaskA}`,
        `${EDGE_MINT_VIA.trunkRef}|related_to|${refTaskB}`,
      ].sort(),
    );
    expect(edges.filter((e) => e.startsWith(`${EDGE_MINT_VIA.position}|`))).toEqual([]);
  });

  test('7. ORIGIN-INDIFFERENT — a handoff from an AUTO-OPENED position is trunk too', async () => {
    // THE POPULATION ROUND 1 MISSED. An implementation that gates the by-type rule on
    // `origin === 'declared'` passes every other test in this file and fails this one; that
    // is the whole reason this case exists (probe 3, named in the header).
    //
    // Asserted rather than assumed: the position really is AUTO. If R1 had not fired, this
    // would be an unpositioned write, which reaches the trunk for a reason that has nothing
    // to do with the rule under test — a vacuous green in the shape of a real one.
    expect(autoReport.position?.origin, 'the position must be auto-opened, not declared').toBe(
      'auto',
    );
    expect(autoReport.position?.spineId, 'auto-opened onto the task that created it').toBe(
      autoSpineId,
    );
    expect(autoReport.namedTaskIds, 'and it names zero task ids').toEqual([]);

    expect(autoReport.trunk).toBe(true);
    expect(autoReport.membership).toEqual({ minted: false, reason: 'trunk-record' });
    expect(await membershipSpines(handoffFromAuto)).toEqual([]);
    const positional = (await outboundEdges(handoffFromAuto)).filter((e) =>
      e.startsWith(`${EDGE_MINT_VIA.position}|`),
    );
    expect(positional).toEqual([]);
  });

  test('6. the zero-ids handoff SAYS why it minted nothing, in the PROSE channel (no silent no-op)', () => {
    // SK1 item c: a positioned write that mints nothing must surface a reason. multiNameLine()
    // returns null when the record names < 2 tasks, so before the membershipReasonLine arm
    // this record minted nothing AND said nothing — indistinguishable from a failure to the
    // agent reading the response. Asserted on the RESPONSE TEXT rather than on the reason
    // enum, because the enum is already asserted in test 1 and re-asserting it here would be
    // a second copy of one check wearing the label of a different one.
    expect(handoffText).toContain('TRUNK record');
    expect(handoffText.toLowerCase()).toContain('member of no branch');
  });
});
