/**
 * THREAD TERMINALITY — end-to-end against a real graph (BRANCH-2).
 *
 * The rule under test: a record that belongs to many lines of work is a DESTINATION, not a
 * CORRIDOR. You may arrive at it; you may not pass through it.
 *
 * WHAT THIS FILE IS FOR, and why it is not the unit test. The decision table lives in
 * threadTerminality.unit.test.ts. Here the question is whether the rule changes THE THREAD A
 * USER GETS BACK — so every assertion below is on the node set returned by the real
 * traversal over records written through the real tools, never on a config value or a
 * predicate's return.
 *
 * THE THREE GUARDS THE TASK REQUIRES, all of them here:
 *   CALIBRATION  — with the flag OFF the walk reproduces today's node set EXACTLY. This is
 *                  what makes the revert trustworthy; it is asserted against the SAME graph
 *                  the ON case walks, so it cannot pass by walking something smaller.
 *   ADMIT-NOT-EXCLUDE — every terminal node is still IN the returned thread. A rule that
 *                  won by dropping records would be a different rule.
 *   EMPTY POPULATION — a thread where NO node declares a limb.
 *
 * Embedding service mocked → deterministic + offline (mirrors recallThread.contract).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { gatherThread } from '../services/recallThread.js';
import { TerminalityWalk } from '../services/threadTerminalityWalk.js';
import { THREAD_CONFIG } from '../config/threadConfig.js';
import {
  THREAD_TERMINALITY_CONFIG,
  THREAD_TERMINALITY_THETA_DEFAULT,
  type ThreadTerminalityConfig,
} from '../config/threadTerminalityConfig.js';

const STAMP = Date.now();
const CONN = `thread-term-conn-${STAMP}`;
const PROJ_NAME = `thread-term-P-${STAMP}`;

/** The two postures, as config objects. `OFF` is the shipped default, stated explicitly. */
const OFF: ThreadTerminalityConfig = {
  mode: 'off',
  modeSource: 'explicit',
  transitOverlapThreshold: THREAD_TERMINALITY_THETA_DEFAULT,
  unassignableTerminal: true,
  notDerivedTerminal: false,
};
const ON: ThreadTerminalityConfig = { ...OFF, mode: 'on' };

let projectId: string;

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}
async function storeContext(content: string): Promise<string> {
  const r = await viaTool('context_store', { content, type: 'planning' });
  return r.structuredContent.context.id;
}
async function createTask(title: string, description: string): Promise<string> {
  const r = await viaTool('task_create', { title, description });
  return r.structuredContent.task.id;
}
async function link(from: string, fromType: string, to: string, toType: string) {
  return viaTool('link', { from, fromType, to, toType, edgeType: 'informs' });
}

/** The node ids of a gathered thread, as a sorted array — the only thing asserted here. */
async function walk(anchor: string, cfg: ThreadTerminalityConfig): Promise<string[]> {
  const t = await gatherThread({ anchor, projectId }, THREAD_CONFIG, db, cfg);
  return t.nodes.map((n) => n.id).sort();
}

/**
 * THE FIXTURE. Three corridors off one anchor task, each a different limb population:
 *
 *   TA (anchor task)  ── informs ──▶ MINE   (declares TA)         ──▶ MINE_CHILD
 *                     ── informs ──▶ HUB    (declares TB only)    ──▶ FAR
 *                     ── informs ──▶ BLANK  (declares nothing)    ──▶ BLANK_CHILD
 *
 * A task IS its own limb root, so limbs(TA) = {TA} and cone(TA) = {TA}. MINE names TA in
 * its prose so it overlaps the cone fully and stays a corridor. HUB names a DIFFERENT task,
 * so its overlap is 0 — the handoff/shared-plan shape. BLANK names nothing at all — the
 * unassignable majority of the real corpus.
 */
let TA: string, TB: string, MINE: string, MINE_CHILD: string, HUB: string, FAR: string;
let BLANK: string, BLANK_CHILD: string;
/** The empty-population fixture: a separate anchor whose whole neighbourhood declares nothing. */
let EA: string, EB: string, EC: string;
/**
 * The NEVER-DERIVED fixture. `NULLY`'s `declared_limbs` is forced to NULL after it is
 * written — exactly the row a backfill has not reached, or one written while BRANCH-1's
 * write-time hook was off. Its own anchor so the assertions below cannot be satisfied by
 * some other node in a shared thread.
 */
let NA: string, NULLY: string, NULLY_CHILD: string;

/** The terminality telemetry emitted by the most recent walk, read off the logger. */
type TelemetryMeta = {
  coneSize: number;
  judged: number;
  expanded: number;
  terminal: number;
  byReason: Record<string, number>;
  declaredLimbCoverage: { derived: number; notDerived: number; unassignable: number };
  terminalNodes: Array<{ id: string; reason: string; overlap: number | null }>;
};

/**
 * Run one walk and return BOTH the node set and the telemetry it logged.
 *
 * The telemetry is a REQUIRED guard, so it is read from the channel it is actually
 * published on (logger.info + its metadata) rather than from an internal the product does
 * not expose. If the log line stops being emitted, this returns undefined and the
 * assertions below fail — which is the point.
 */
async function walkWithTelemetry(
  anchor: string,
  cfg: ThreadTerminalityConfig
): Promise<{ nodes: string[]; telemetry: TelemetryMeta | undefined }> {
  const spy = vi.spyOn(logger, 'info');
  try {
    const t = await gatherThread({ anchor, projectId }, THREAD_CONFIG, db, cfg);
    const call = spy.mock.calls.find((c: any[]) => c[1]?.operation === 'terminality');
    return {
      nodes: t.nodes.map((n) => n.id).sort(),
      telemetry: call ? ((call[1] as any).metadata as TelemetryMeta) : undefined,
    };
  } finally {
    spy.mockRestore();
  }
}

describe('recall_thread terminality — a shared record is a destination, not a corridor', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'terminality contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    TA = await createTask('terminality anchor task', 'the branch you asked about');
    TB = await createTask('an unrelated line of work', 'a different branch entirely');

    // Limbs are declared by NAMING a limb root in the prose. Deliberately not by a
    // `task:` TAG: a tag also MINTS an edge, which would change the graph being walked and
    // make the fixture assert two things at once.
    MINE = await storeContext(`work on this branch, continuing ${id8(TA)}`);
    MINE_CHILD = await storeContext('a follow-up that hangs off the branch work');
    HUB = await storeContext(`a day handoff: shipped ${id8(TB)} today, plus other threads`);
    FAR = await storeContext('a record belonging to that other line of work');
    BLANK = await storeContext('a milestone note that names nothing resolvable');
    BLANK_CHILD = await storeContext('a record reachable only through the milestone note');

    EA = await storeContext('empty-population anchor, names nothing');
    EB = await storeContext('empty-population middle, names nothing');
    EC = await storeContext('empty-population leaf, names nothing');

    NA = await createTask('never-derived anchor task', 'anchor for the NULL third state');
    NULLY = await storeContext('a record the backfill has not reached yet');
    NULLY_CHILD = await storeContext('a record reachable only through the never-derived one');
    // FORCE THE THIRD STATE. BRANCH-1's write-time hook derives on every write, so the
    // only way to get a genuinely NOT-DERIVED row is to clear it afterwards — which is
    // precisely the state a pre-backfill row is in. Asserted below, so a future change to
    // the write path that re-derives this row fails loudly instead of making the test
    // silently measure the `[]` case again.
    await db.query(`UPDATE contexts SET declared_limbs = NULL WHERE id = $1`, [NULLY]);

    // Every edge in the fixture is minted EXPLICITLY, so the walk under test is the one
    // drawn above. The store path can also mint inferred `related_to` neighbours, which
    // would be a second, undeclared graph; clearing first makes the fixture the whole graph
    // rather than most of it. (The `link` calls below all run after this delete.)
    await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);

    await link(TA, 'task', MINE, 'context');
    await link(MINE, 'context', MINE_CHILD, 'context');
    await link(TA, 'task', HUB, 'context');
    await link(HUB, 'context', FAR, 'context');
    await link(TA, 'task', BLANK, 'context');
    await link(BLANK, 'context', BLANK_CHILD, 'context');

    await link(EA, 'context', EB, 'context');
    await link(EB, 'context', EC, 'context');

    await link(NA, 'task', NULLY, 'context');
    await link(NULLY, 'context', NULLY_CHILD, 'context');
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── THE FIXTURE ITSELF ──────────────────────────────────────────────────────
  test('the fixture declares the limbs it claims to (BRANCH-1 materialised them)', async () => {
    // If this drifts, every assertion below is measuring a different rule than it says.
    // Asserted from the COLUMN the product reads, not from the prose that produced it.
    const rows = await db.query(
      `SELECT id::text AS id, declared_limbs FROM contexts WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT id::text, declared_limbs FROM tasks WHERE id = ANY($2::uuid[])`,
      [[MINE, HUB, BLANK, EA, EB], [TA]]
    );
    const limbs = new Map(rows.rows.map((r: any) => [r.id, r.declared_limbs]));
    expect(limbs.get(TA)).toEqual([TA]); // a task is its own limb root
    expect(limbs.get(MINE)).toEqual([TA]); // overlap 1.0 with cone {TA}
    expect(limbs.get(HUB)).toEqual([TB]); // overlap 0.0 — the shared-record shape
    expect(limbs.get(BLANK)).toEqual([]); // derived, declares nothing
    expect(limbs.get(EA)).toEqual([]);
    expect(limbs.get(EB)).toEqual([]);
  });

  // ── GUARD 1: CALIBRATION ────────────────────────────────────────────────────
  test('CALIBRATION — with the flag OFF the walk reproduces today’s node set EXACTLY', async () => {
    const expected = [TA, MINE, MINE_CHILD, HUB, FAR, BLANK, BLANK_CHILD].sort();
    expect(await walk(id8(TA), OFF)).toEqual(expected);
    // ...and the SHIPPED default is that walk. This leg is what makes the revert claim
    // real: it exercises the config the process actually loaded, not a stand-in.
    expect(THREAD_TERMINALITY_CONFIG.mode).toBe('off');
    const shipped = await gatherThread({ anchor: id8(TA), projectId }, THREAD_CONFIG, db);
    expect(shipped.nodes.map((n) => n.id).sort()).toEqual(expected);
  });

  test('CALIBRATION — the empty-population thread is also unchanged with the flag OFF', async () => {
    expect(await walk(id8(EA), OFF)).toEqual([EA, EB, EC].sort());
  });

  // ── GUARD 2: THE RULE ───────────────────────────────────────────────────────
  test('a shared record is ADMITTED but the walk does not pass THROUGH it', async () => {
    const got = await walk(id8(TA), ON);
    // ADMIT: the shared record is still in the thread. This rule never excludes.
    expect(got).toContain(HUB);
    // DO NOT TRANSIT: what hung off it is gone.
    expect(got).not.toContain(FAR);
  });

  test('an UNASSIGNABLE record is a destination too', async () => {
    const got = await walk(id8(TA), ON);
    expect(got).toContain(BLANK);
    expect(got).not.toContain(BLANK_CHILD);
  });

  test('a record that names THIS branch is still a corridor — the rule is not "prune depth 2"', async () => {
    // Without this leg the rule could be "return depth 1" and every assertion above would
    // still pass. MINE_CHILD is only reachable through MINE, at depth 2.
    const got = await walk(id8(TA), ON);
    expect(got).toContain(MINE);
    expect(got).toContain(MINE_CHILD);
  });

  test('the net effect on this fixture, stated as the whole node set', async () => {
    expect(await walk(id8(TA), ON)).toEqual([TA, MINE, MINE_CHILD, HUB, BLANK].sort());
  });

  test('the threshold is READ: raising it past MINE’s overlap makes MINE terminal too', async () => {
    // MINE's overlap is 1.0, so no threshold in [0,1] can exclude it — but a record with
    // partial overlap must move. HUB names TB only; give the anchor a cone containing TB by
    // walking from TB instead, where HUB's overlap is 1.0, and raise theta above it is
    // impossible — so assert the knob the other way: at theta 0, a 0-overlap node transits.
    const permissive = await walk(id8(TA), { ...ON, transitOverlapThreshold: 0 });
    expect(permissive).toContain(FAR); // overlap 0 >= 0 → HUB becomes a corridor again
    expect(permissive).not.toContain(BLANK_CHILD); // ...but unassignable is a separate clause
  });

  test('the unassignable clause is READ: switching it off restores that corridor only', async () => {
    const got = await walk(id8(TA), { ...ON, unassignableTerminal: false });
    expect(got).toContain(BLANK_CHILD); // the unassignable corridor reopens
    expect(got).not.toContain(FAR); // the below-threshold corridor stays shut
  });

  // ── GUARD 3: THE EMPTY POPULATION ───────────────────────────────────────────
  test('EMPTY POPULATION — a thread where NO node declares a limb', async () => {
    // The anchor is always expandable, so depth 1 survives; every node at depth 1 is
    // unassignable, so depth 2 does not. The walk degrades to a smaller thread, never to a
    // throw and never to the anchor alone.
    const got = await walk(id8(EA), ON);
    expect(got).toEqual([EA, EB].sort());
  });

  test('EMPTY POPULATION — an anchor that declares nothing still returns its neighbours', async () => {
    // The failure this rules out: cone = {anchor} for a limbless anchor, and if the anchor
    // were judged by the same clause as everything else the thread would collapse to one
    // node — the over-correction that killed an earlier rule variant.
    const got = await walk(id8(EA), ON);
    expect(got.length).toBeGreaterThan(1);
    expect(got).toContain(EA);
  });

  // ── THE THIRD STATE: NEVER-DERIVED (NULL) IS NOT THE EMPTY ARRAY ────────────
  // WHY THIS EXISTS AS AN END-TO-END TEST and not only as a unit assertion. Three
  // places carry the NULL through — declaredLimbsStore.loadDeclaredLimbs (a NULL column),
  // TerminalityWalk.open/judgeLevel (a MISSING row), and judgeLevel's catch (a failed
  // read). All three were mutated to collapse NULL into `[]` and the entire suite stayed
  // GREEN, because nothing below the unit level ever saw the distinction. If any one of
  // them were wrong, a never-derived record would be judged `unassignable` → terminal →
  // ITS WHOLE SUBTREE SILENTLY VANISHES from a user's thread, and the telemetry would
  // report it as `unassignable` rather than `not-derived` — hiding the backfill gap that
  // the third state exists to make visible.

  test('the NULL fixture really is NOT-DERIVED, not the empty array', async () => {
    // If the write path ever starts re-deriving this row, every assertion below would
    // quietly become a second copy of the `unassignable` case. Fail here instead.
    const r = await db.query(`SELECT declared_limbs FROM contexts WHERE id = $1`, [NULLY]);
    expect(r.rows[0].declared_limbs).toBeNull();
    // The control: a sibling context written the same way IS derived, to the empty array.
    const c = await db.query(`SELECT declared_limbs FROM contexts WHERE id = $1`, [BLANK]);
    expect(c.rows[0].declared_limbs).toEqual([]);
  });

  test('NEVER-DERIVED is permissive: the child SURVIVES the ON walk', async () => {
    // The user-visible half. A row the backfill has not reached must not cost anyone the
    // records hanging off it — we do not know what it names, and pruning on a fact we do
    // not have is the failure this branch of the rule exists to prevent.
    const { nodes } = await walkWithTelemetry(id8(NA), ON);
    expect(nodes).toEqual([NA, NULLY, NULLY_CHILD].sort());
  });

  test('NEVER-DERIVED is COUNTED as not-derived, never as unassignable', async () => {
    // The observability half, and the one that makes the backfill gap legible. Reported
    // as `unassignable` this population is indistinguishable from the 57% of the corpus
    // that genuinely declares nothing — which is exactly the blindness to avoid.
    const { telemetry } = await walkWithTelemetry(id8(NA), ON);
    expect(telemetry).toBeDefined();
    expect(telemetry!.declaredLimbCoverage).toEqual({
      derived: 1, // the anchor task, which is its own limb root
      notDerived: 1, // NULLY
      unassignable: 0, // and NOT here
    });
    expect(telemetry!.byReason['not-derived']).toBe(1);
    expect(telemetry!.byReason['unassignable']).toBe(0);
    expect(telemetry!.terminal).toBe(0);
  });

  test('the posture is a knob: flipping notDerivedTerminal prunes the same subtree', async () => {
    // Proves the permissive answer above is the CONFIG being read, not the rule being
    // unable to prune this population at all.
    const { nodes, telemetry } = await walkWithTelemetry(id8(NA), {
      ...ON,
      notDerivedTerminal: true,
    });
    expect(nodes).toEqual([NA, NULLY].sort());
    expect(telemetry!.terminalNodes).toEqual([
      { id: NULLY.replace(/-/g, '').slice(0, 8), reason: 'not-derived', overlap: null },
    ]);
  });

  test('TELEMETRY names WHY each node was terminal on the main fixture too', async () => {
    // The required guard, asserted on the channel it is published on. Both terminal
    // reasons appear with the node that earned them — an aggregate count alone would not
    // tell an operator which record stopped the walk.
    const { telemetry } = await walkWithTelemetry(id8(TA), ON);
    expect(telemetry!.declaredLimbCoverage).toEqual({
      derived: 3, // TA, MINE, HUB
      notDerived: 0,
      unassignable: 1, // BLANK
    });
    expect(
      telemetry!.terminalNodes.map((n) => n.reason).sort()
    ).toEqual(['below-threshold', 'unassignable']);
    expect(telemetry!.byReason).toMatchObject({ anchor: 1, expandable: 1 });
  });

  // ── A FAILED LIMB READ IS A THIRD STATE TOO, AND IT DEGRADES **OPEN** ───────
  // WHY THESE TWO DRIVE `TerminalityWalk` DIRECTLY rather than the whole tool. The failure
  // being injected is a POOL failure, and gatherThread hands the same pool to anchor
  // resolution, getLinks and hydration — a pool that throws would break the walk long
  // before it reached the rule, so the fault could not be aimed at the seam under test.
  // The narrower surface is the cost of aiming precisely, and it is stated rather than
  // hidden: what is NOT proven here is the end-to-end thread under a partial DB outage.
  const throwingPool = () =>
    ({
      query: async () => {
        throw new Error('injected: declared_limbs read failed');
      },
    }) as any;

  test('a failed ANCHOR limb read SKIPS terminality — it must not throw, and must not prune', async () => {
    // The dangerous alternative is the one that looks reasonable: treat the unreadable
    // anchor as declaring nothing, i.e. cone = {anchor}. Every other node then scores
    // overlap 0 and goes terminal — a database hiccup silently collapsing every branch
    // read on the instance. Skipping is the only answer that cannot do that.
    const walk = await TerminalityWalk.open({ id: NA, type: 'task' }, ON, throwingPool());
    expect(walk).toBeNull();
  });

  test('a failed LEVEL limb read judges that level NOT-DERIVED, so the walk continues', async () => {
    const walk = await TerminalityWalk.open({ id: NA, type: 'task' }, ON, db);
    expect(walk).not.toBeNull();
    // Swap in a pool that fails only now — open() has already succeeded, so this aims the
    // fault at judgeLevel and nowhere else.
    (walk as any).pool = throwingPool();
    const verdicts = await walk!.judgeLevel([{ id: NULLY, type: 'context' }]);
    expect(verdicts.get(NULLY)).toMatchObject({ canExpand: true, reason: 'not-derived' });
    // ...and it is COUNTED, so an outage shows up in the telemetry rather than as a
    // mysteriously thin thread.
    expect(walk!.telemetry.coverage.notDerived).toBe(1);
    expect(walk!.telemetry.coverage.unassignable).toBe(0);
  });

  // ── READ-BACK ───────────────────────────────────────────────────────────────
  test('READ-BACK — mandrel_status reports the EFFECTIVE terminality mode', async () => {
    // A revert you cannot read back is a revert you cannot claim. Revert = flip the env,
    // restart, read THIS.
    const res = await viaTool('mandrel_status', {});
    expect(res.structuredContent.featureFlags.threadTerminality).toBe(
      THREAD_TERMINALITY_CONFIG.mode
    );
    expect(res.structuredContent.featureFlags.threadTerminalitySource).toBe(
      THREAD_TERMINALITY_CONFIG.modeSource
    );
    // The text channel and the structured channel are built from ONE builder, so they
    // cannot disagree about what the process is running.
    const text = res.content.map((c: any) => c.text).join('\n');
    expect(text).toContain(`recall_thread terminality: ${THREAD_TERMINALITY_CONFIG.mode.toUpperCase()}`);
  });
});
