/**
 * BACKWARD-SOFT SUPERSESSION GUARD — the contract (P5.3 half B).
 *
 * THE RULE: a guessed (`tier:soft`) supersession may not contradict a DECLARED chain running
 * the other way. A declaration outranks an opinion.
 *
 * WHY THIS IS A CONTRACT TEST AND NOT A UNIT TEST. The pure decision procedure already has
 * one (declaredReachability.unit.test.ts). What that file CANNOT reach is the recursive CTE
 * in services/trust.ts that builds the adjacency — which is where "declared only", "cycle
 * safe" and "hop bounded" are actually enforced against Postgres. A guard whose SQL is never
 * executed is a guard tested one layer above the thing that can be wrong. So this file drives
 * `trustForRecord` against a real migrated database, over the REAL measured prod cycle.
 *
 * THE FIXTURE IS THE MEASURED DEFECT, not an invented one. Captured read-only from prod on
 * 2026-08-23 (project `riverbend`) into
 * runtime/lib/__fixtures__/boot-recall-collapse/walk-cycle-eb98686d.json:
 *
 *     superseded_by 2b3c4d5e   tier:declared
 *     superseded_by 3c4d5e6f   tier:declared
 *     superseded_by 4d5e6f7a   tier:soft  conf:0.85    ← the contradiction
 *
 * `3c4d5e6f` was the LIVE handoff head. The soft edge halved its trust score and put the live
 * head under the fold. The declared edges are reproduced here with the same shape the product
 * mints them with (`handoffSupersession.ts` → created_by NOT the belief label), and the soft
 * edge with the shape the belief reconciler mints (`possibly_supersedes` + confidence
 * metadata) — migration 087 forbids an inferred edge from occupying the `supersedes` channel
 * at all, so `possibly_supersedes` IS the auto shape.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { BELIEF_EDGE_CREATED_BY } from '../config/beliefConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { trustForRecord } from '../services/trust.js';
import type { SupersessionGuardConfig } from '../config/supersessionGuardConfig.js';

const STAMP = Date.now();
const PROJ = `bsg-P-${STAMP}`;

let projectId: string;
/** head → mid → tail → tailer : a 3-deep DECLARED chain, newest first. */
let head: string, mid: string, tail: string, tailer: string;
/** An unrelated record used as the NEGATIVE CONTROL's soft claimant. */
let outsider: string;
/** Records minted inside a test, torn down with the rest. */
const isolated: string[] = [];

const GUARD_ON: SupersessionGuardConfig = { enabled: true, maxHops: 25, undecidedPolicy: 'honor' };
const GUARD_OFF: SupersessionGuardConfig = { enabled: false, maxHops: 25, undecidedPolicy: 'honor' };

async function mkContext(title: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO contexts (project_id, context_type, content, created_at)
     VALUES ($1, 'handoff', $2, NOW()) RETURNING id`,
    [projectId, title]
  );
  return r.rows[0].id;
}

/**
 * A DECLARED supersession: `newer` supersedes `older`.
 *
 * `mint_via` is `handoff-timeline` — EXACTLY what `handoffSupersession.ts:110` stamps, which
 * is the mint path that produced the measured prod chain. It is not a decoration: migration
 * 085 GENERATES `provenance_class` from this column and migration 087 CHECKs that a
 * `supersedes` row is `provenance_class='declared'`, so a fixture that forged the wrong via
 * would either be rejected by the database or would not be declared at all. The via is read
 * from EDGE_MINT_VIA rather than spelled here, so this fixture cannot drift from the product.
 */
async function declaredSupersedes(newer: string, older: string): Promise<void> {
  await db.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, created_by, mint_via)
     VALUES ($1,'context',$2,'context','supersedes','auto:handoff-supersession',$3)`,
    [newer, older, EDGE_MINT_VIA.handoffTimeline]
  );
}

/** A SOFT (guessed) supersession: `claimant` possibly_supersedes `target`, with confidence.
 *  The belief reconciler's shape — `belief-adjudication` classifies as `guessed`. */
async function softSupersedes(claimant: string, target: string, confidence: number): Promise<void> {
  await db.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, created_by, mint_via, metadata)
     VALUES ($1,'context',$2,'context','possibly_supersedes',$3,$4,$5::jsonb)`,
    [
      claimant,
      target,
      BELIEF_EDGE_CREATED_BY,
      EDGE_MINT_VIA.beliefAdjudication,
      JSON.stringify({ confidence, reason: ['test'] }),
    ]
  );
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1,'backward-soft guard contract') RETURNING id`,
    [PROJ]
  );
  projectId = p.rows[0].id;

  head = await mkContext('HANDOFF head (the live one)');
  mid = await mkContext('HANDOFF mid');
  tail = await mkContext('HANDOFF tail');
  tailer = await mkContext('HANDOFF tail-most');
  outsider = await mkContext('an unrelated record');

  // The declared chain, exactly as prod has it: head → mid → tail → tailer.
  await declaredSupersedes(head, mid);
  await declaredSupersedes(mid, tail);
  await declaredSupersedes(tail, tailer);
}, 60_000);

afterAll(async () => {
  await db.query(
    `DELETE FROM links WHERE from_id = ANY($1) OR to_id = ANY($1)`,
    [[head, mid, tail, tailer, outsider, ...isolated]]
  );
  await db.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('the measured prod cycle', () => {
  test('CONTROL — with the guard OFF the defect reproduces exactly as prod had it', async () => {
    // ⚠️ THIS IS THE KNOWN-GOOD-INPUT PROBE, and it runs FIRST on purpose. A guard test that
    // only ever asserts the fixed behaviour cannot tell "the guard worked" from "the fixture
    // never had the defect". This asserts the BROKEN state is reachable in this database, so
    // every assertion below is measured against a defect that is really present.
    await softSupersedes(tail, head, 0.85); // the backward soft edge
    const t = await trustForRecord({ id: head, type: 'context' }, undefined, db, GUARD_OFF);
    expect(t.softSuperseded).toBe(true);
    expect(t.supersession).toMatchObject({ supersededBy: tail, tier: 'soft', confidence: 0.85 });
    expect(t.reason).toBe('soft-demoted');
    expect(t.supersessionGuard).toMatchObject({ enabled: false, checked: 1 });
    expect(t.supersessionGuard.suppressed).toEqual([]);
  });

  test('with the guard ON the backward soft edge is SUPPRESSED and the head recovers', async () => {
    const t = await trustForRecord({ id: head, type: 'context' }, undefined, db, GUARD_ON);
    expect(t.softSuperseded).toBe(false);
    expect(t.supersession).toBeNull();
    expect(t.reason).not.toBe('soft-demoted');
  });

  test('the suppression is VISIBLE in structured output — never silent', async () => {
    const t = await trustForRecord({ id: head, type: 'context' }, undefined, db, GUARD_ON);
    expect(t.supersessionGuard.enabled).toBe(true);
    expect(t.supersessionGuard.checked).toBe(1);
    expect(t.supersessionGuard.undecided).toEqual([]);
    expect(t.supersessionGuard.suppressed).toHaveLength(1);
    expect(t.supersessionGuard.suppressed[0]).toMatchObject({
      candidate: tail,
      confidence: 0.85,
      verdict: 'reached',
      hops: 2, // head → mid → tail, over DECLARED edges only
      undecidedCause: null,
      action: 'suppressed',
    });
  });

  test('the suppression RESTORES the score the soft demotion had taken', async () => {
    const off = await trustForRecord({ id: head, type: 'context' }, undefined, db, GUARD_OFF);
    const on = await trustForRecord({ id: head, type: 'context' }, undefined, db, GUARD_ON);
    // Not a hardcoded number: the demotion multiplier is config, and the assertion is the
    // RELATION the multiplier creates — the demoted score is strictly lower.
    expect(off.score).not.toBeNull();
    expect(on.score).not.toBeNull();
    expect(on.score!).toBeGreaterThan(off.score!);
  });
});

describe('NEGATIVE CONTROL — the guard did not just disable soft edges wholesale', () => {
  test('TWO soft edges on ONE record: the backward one dies, the ordinary one lives', async () => {
    // THE ASSERTION THAT SEPARATES THE FIX FROM THE OBVIOUS WRONG FIX. Criterion 1 (the prod
    // cycle) would pass perfectly for a guard that simply dropped every soft edge. So this
    // puts BOTH kinds on the SAME record, adjudicated by the SAME walk, and requires the guard
    // to tell them apart: `ncMid` points backward along a declared chain (suppressed);
    // `ncOut` has no declared relationship to `ncHead` in either direction, which is the edge
    // the belief adjudicator exists to produce (honored).
    //
    // Isolated records on purpose: `mid` and `tail` are already declared-superseded, and a
    // DECLARED cap would make `softSuperseded` false for reasons that have nothing to do with
    // this guard — a green that proves nothing.
    const ncHead = await mkContext('NC head');
    const ncMid = await mkContext('NC mid');
    const ncOut = await mkContext('NC unrelated claimant');
    isolated.push(ncHead, ncMid, ncOut);
    await declaredSupersedes(ncHead, ncMid);
    await softSupersedes(ncMid, ncHead, 0.9); // backward — contradicts the declaration
    await softSupersedes(ncOut, ncHead, 0.7); // ordinary — nothing contradicts it

    const t = await trustForRecord({ id: ncHead, type: 'context' }, undefined, db, GUARD_ON);
    expect(t.supersessionGuard.checked).toBe(2);
    expect(t.supersessionGuard.suppressed).toHaveLength(1);
    expect(t.supersessionGuard.suppressed[0]).toMatchObject({ candidate: ncMid, hops: 1 });
    expect(t.supersessionGuard.undecided).toEqual([]);
    // The survivor really survived: the demotion is applied and the receipt names it — and it
    // is NOT the higher-confidence (0.9) suppressed candidate, which is the tell that a
    // suppressed edge cannot still win the receipt selection.
    expect(t.softSuperseded).toBe(true);
    expect(t.supersession).toMatchObject({ supersededBy: ncOut, tier: 'soft', confidence: 0.7 });
    expect(t.reason).toBe('soft-demoted');
  });

  test('a soft edge pointing FORWARD along the chain (with the flow) is honored too', async () => {
    // tailer is the OLDEST record; `mid` declared-supersedes it transitively. A soft edge from
    // `head` onto `tailer` agrees with the declared direction, so nothing contradicts it.
    await softSupersedes(head, tailer, 0.6);
    const t = await trustForRecord({ id: tailer, type: 'context' }, undefined, db, GUARD_ON);
    expect(t.supersessionGuard.checked).toBeGreaterThanOrEqual(1);
    expect(t.supersessionGuard.suppressed).toEqual([]);
    // `tailer` is also DECLARED-superseded by `tail`, and declared wins — so the receipt is
    // declared. What matters here is that the guard suppressed nothing.
    expect(t.superseded).toBe(true);
  });
});

describe('UNDECIDED is counted, not coerced', () => {
  test('the hop bound produces an UNDECIDED finding, and the edge is HONORED by default', async () => {
    // maxHops:1 cannot reach `tail` from `head` (it is 2 declared hops away), so the walk is
    // STOPPED rather than finished. That is not evidence of absence, so the default policy
    // leaves the opinion standing — and says so, in its own counter.
    const cfg: SupersessionGuardConfig = { enabled: true, maxHops: 1, undecidedPolicy: 'honor' };
    const t = await trustForRecord({ id: head, type: 'context' }, undefined, db, cfg);
    expect(t.supersessionGuard.suppressed).toEqual([]);
    expect(t.supersessionGuard.undecided).toHaveLength(1);
    expect(t.supersessionGuard.undecided[0]).toMatchObject({
      candidate: tail,
      verdict: 'undecided',
      undecidedCause: 'hop-bound',
      hops: null,
      action: 'honored',
    });
    // HONORED means honored: the demotion is really still applied, not merely reported.
    expect(t.softSuperseded).toBe(true);
  });

  test('undecidedPolicy:suppress is a DIFFERENT action on the SAME verdict', async () => {
    // The tri-state survives the policy: the finding still says `undecided`, and it is still
    // counted under `undecided` rather than being promoted into `suppressed`. Only `action`
    // moves. That is what "not collapsed" means.
    const cfg: SupersessionGuardConfig = { enabled: true, maxHops: 1, undecidedPolicy: 'suppress' };
    const t = await trustForRecord({ id: head, type: 'context' }, undefined, db, cfg);
    expect(t.supersessionGuard.suppressed).toEqual([]);
    expect(t.supersessionGuard.undecided).toHaveLength(1);
    expect(t.supersessionGuard.undecided[0]).toMatchObject({
      verdict: 'undecided',
      undecidedCause: 'hop-bound',
      action: 'suppressed',
    });
    expect(t.softSuperseded).toBe(false);
  });
});

describe('the audit is never absent', () => {
  test('a record with NO soft candidates still carries a zeroed audit', async () => {
    // `checked: 0` is an answer. A missing object is not. This is the empty population.
    const t = await trustForRecord({ id: outsider, type: 'context' }, undefined, db, GUARD_ON);
    expect(t.supersessionGuard).toEqual({ enabled: true, checked: 0, suppressed: [], undecided: [] });
  });

  test('a DECLARED-superseded record is unaffected — declared still hard-caps', async () => {
    // The guard suppresses OPINIONS. It must never touch a declaration: `mid` is
    // declared-superseded by `head` and must stay capped.
    const t = await trustForRecord({ id: tail, type: 'context' }, undefined, db, GUARD_ON);
    expect(t.superseded).toBe(true);
    expect(t.abstain).toBe(true);
    expect(t.supersession).toMatchObject({ supersededBy: mid, tier: 'declared' });
  });
});

describe('the SQL itself: declared-only, and cycle-safe', () => {
  test('a DECLARED cycle does not hang the adjacency read', async () => {
    // Close the chain into a real declared loop (tailer supersedes head) and ask the question
    // again. Without the path guard in the recursive CTE this query never returns; the test
    // timing out IS the failure signal, and the assertion below is that it does not.
    await declaredSupersedes(tailer, head);
    const t = await trustForRecord({ id: head, type: 'context' }, undefined, db, GUARD_ON);
    // head still reaches tail in 2 declared hops — a constructive witness survives a cycle.
    expect(t.supersessionGuard.suppressed).toHaveLength(1);
    expect(t.supersessionGuard.suppressed[0]).toMatchObject({ candidate: tail, verdict: 'reached' });
    await db.query(`DELETE FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='supersedes'`, [
      tailer,
      head,
    ]);
  }, 30_000);

  test('a SOFT edge is never walked as evidence to suppress another soft edge', async () => {
    // THE MIXED-CHAIN PROBE. Three records:
    //     sA --declared supersedes--> sB          (the only DECLARED edge)
    //     sB --possibly_supersedes--> sC          (soft; the hop a leak would let us take)
    //     sC --possibly_supersedes--> sA          (soft; the claim under adjudication)
    //
    // Adjudicating sA, the soft claimant is sC. Over the DECLARED subgraph the walk goes
    // sA → sB and STOPS — sC is not reachable, the verdict is an exhaustive `ended`, and sC's
    // claim is HONORED. If soft edges leaked into the adjacency the walk would continue
    // sB → sC, come back `reached`, and suppress. So this assertion is RED exactly when a
    // guess is allowed to justify suppressing another guess, and green otherwise.
    const sA = await mkContext('mixed-chain A');
    const sB = await mkContext('mixed-chain B');
    const sC = await mkContext('mixed-chain C');
    isolated.push(sA, sB, sC);
    await declaredSupersedes(sA, sB);
    await softSupersedes(sB, sC, 0.8);
    await softSupersedes(sC, sA, 0.8);

    const t = await trustForRecord({ id: sA, type: 'context' }, undefined, db, GUARD_ON);
    expect(t.supersessionGuard.checked).toBe(1);
    expect(t.supersessionGuard.suppressed).toEqual([]);
    expect(t.supersessionGuard.undecided).toEqual([]);
    expect(t.supersession).toMatchObject({ supersededBy: sC, tier: 'soft' });
  });
});
