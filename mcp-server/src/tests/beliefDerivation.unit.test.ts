/**
 * beliefDerivation + adjudicator-normalisation — PURE unit tests (Phase 4).
 *
 * Locks the DELIBERATE decision core of the belief layer with NO LLM and NO DB, so it runs
 * in the CI gate (where embeddings are mocked) and CANNOT lie-green: every assertion here goes
 * RED if the corresponding logic is reverted (see the belief-eval proof for the mutation
 * demonstration).
 *
 * Guards the design invariants (ca9a33c0 §3/§4/§8 + an earlier task):
 *   - NO HARD TIER: `soft_possibly_superseded` is the ONLY supersession outcome, at EVERY
 *     confidence. This is the executable form of "an inferred edge must never be able to
 *     make a record invisible" — a `supersedes` edge is an exclusion predicate in
 *     projectBriefing.ts, and belief adjudication is a guess;
 *   - the SOFT outcome carries from/to/direction/mode;
 *   - DIRECTION is honoured exactly (a_supersedes_b ⇒ from=a→to=b, and the reverse); a
 *     `none` direction yields NOTHING (no_direction — never guessed);
 *   - MODE (replaced | fallback_retained) is preserved (case 2);
 *   - the SCOPE-FENCE INVARIANT: contests/restates/unrelated/different-subject NEVER
 *     produce a supersession outcome;
 *   - the adjudicator JSON normaliser coerces incoherent direction/mode to `none`.
 *
 * WHAT THE PRE-57f35350 VERSION OF THIS FILE COVERED THAT THIS ONE NO LONGER DOES: the
 * two-tier threshold arithmetic — that conf just below the dial, cosine just below the gate,
 * a null cosine, or both-below fell to SOFT while at-or-above both HARD-minted. Those dials
 * no longer exist, so that arithmetic is not under-tested, it is absent. What replaces it is
 * stronger and is asserted below: the hard outcome is unreachable at any input.
 */

import { describe, test, expect } from 'vitest';

import { deriveBeliefOutcome } from '../services/belief/beliefDerivation.js';
import { BELIEF_VERDICTS } from '../services/belief/types.js';
import type { AdjudicatorVerdict, BeliefVerdict } from '../services/belief/types.js';
import { normalizeVerdict, extractJson } from '../services/belief/ollamaAdjudicator.js';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── ENDPOINTS CARRY A CLOCK ─────────────────────────────────────────
// deriveBeliefOutcome takes the two RECORDS, not two ids, because it gates the direction on
// chronology: the superseder must be strictly NEWER. So every fixture below has to state
// which record is newer, and the pair is ORIENTED to match the direction under test — a
// fixture whose chronology contradicts its direction is testing the guard, not the mapping.
const T0 = Date.parse('2026-08-01T00:00:00.000Z');
/** `A`, one minute NEWER than B. */
const A_NEW = { id: A, createdAt: new Date(T0 + 60_000) };
/** `B`, the OLDER record. */
const B_OLD = { id: B, createdAt: new Date(T0) };
/** `A` as the OLDER record (for the b_supersedes_a orientation). */
const A_OLD = { id: A, createdAt: new Date(T0) };
/** `B` as the NEWER record (for the b_supersedes_a orientation). */
const B_NEW = { id: B, createdAt: new Date(T0 + 60_000) };

function verdict(partial: Partial<AdjudicatorVerdict>): AdjudicatorVerdict {
  return {
    sameSubject: true,
    subject: 's',
    verdict: 'supersedes',
    direction: 'a_supersedes_b',
    mode: 'replaced',
    confidence: 0.95,
    rationale: 'r',
    ...partial,
  };
}

describe('deriveBeliefOutcome — the ONLY supersession outcome is SOFT', () => {
  test('a_supersedes_b ⇒ SOFT possibly_superseded from a → to b, mode replaced', () => {
    const out = deriveBeliefOutcome(verdict({}), A_NEW, B_OLD);
    expect(out.action).toBe('soft_possibly_superseded');
    if (out.action !== 'soft_possibly_superseded') throw new Error('unreachable');
    expect(out.fromId).toBe(A);
    expect(out.toId).toBe(B);
    expect(out.direction).toBe('a_supersedes_b');
    expect(out.mode).toBe('replaced');
    expect(out.confidence).toBe(0.95);
  });

  test('b_supersedes_a flips direction ⇒ from b → to a (arrow honoured, not guessed)', () => {
    // Oriented so B is the NEWER record — otherwise this maps a backwards arrow and the
    // chronology gate (correctly) refuses it, which is a different property.
    const out = deriveBeliefOutcome(verdict({ direction: 'b_supersedes_a' }), A_OLD, B_NEW);
    if (out.action !== 'soft_possibly_superseded') throw new Error('expected soft');
    expect(out.fromId).toBe(B);
    expect(out.toId).toBe(A);
    expect(out.direction).toBe('b_supersedes_a');
  });

  test('case 2: fallback_retained mode is preserved onto the outcome', () => {
    const out = deriveBeliefOutcome(verdict({ mode: 'fallback_retained' }), A_NEW, B_OLD);
    if (out.action !== 'soft_possibly_superseded') throw new Error('expected soft');
    expect(out.mode).toBe('fallback_retained');
  });

  test('mode "none" on a supersedes verdict defaults to replaced (never yields mode none)', () => {
    const out = deriveBeliefOutcome(verdict({ mode: 'none' }), A_NEW, B_OLD);
    if (out.action !== 'soft_possibly_superseded') throw new Error('expected soft');
    expect(out.mode).toBe('replaced');
  });
});

describe('deriveBeliefOutcome — NO HARD TIER AT ANY CONFIDENCE (the 57f35350 invariant)', () => {
  // THE POINT OF THIS BLOCK. The bug was not "the dial was set too low" — it was that a dial
  // existed at all, so that SOME confidence promoted a guess into an exclusion predicate.
  // These assertions therefore sweep confidence to its ceiling INCLUSIVE, and past it, so a
  // reintroduced bar cannot hide above the sampled range.
  const CONFIDENCES = [0, 0.5, 0.74, 0.75, 0.79, 0.8, 0.89, 0.9, 0.95, 0.99, 1, 1.5];

  test.each(CONFIDENCES)('confidence %s still yields SOFT, never a hard mint', (confidence) => {
    const out = deriveBeliefOutcome(verdict({ confidence }), A_NEW, B_OLD);
    expect(out.action).toBe('soft_possibly_superseded');
    // The old hard action string must not appear for ANY input. Written as a string compare
    // (not a type narrow) on purpose: this assertion has to keep meaning if someone re-adds
    // the union member, which is exactly the regression it exists to catch.
    expect(out.action as string).not.toBe('mint_supersedes');
  });

  test('the outcome carries NO edgeType field — only edgeReconciliation names the edge', () => {
    const out = deriveBeliefOutcome(verdict({ confidence: 1 }), A_NEW, B_OLD);
    expect(out).not.toHaveProperty('edgeType');
  });
});

describe('deriveBeliefOutcome — no-false-edge guards (axis ②: cases 3, 6)', () => {
  test('case 6: restates ⇒ no edge', () => {
    const out = deriveBeliefOutcome(verdict({ verdict: 'restates' }), A_NEW, B_OLD);
    expect(out).toEqual({ action: 'none', reason: 'restates' });
  });

  test('case 3: different subject/scope ⇒ no edge (even if verdict says supersedes)', () => {
    const out = deriveBeliefOutcome(verdict({ sameSubject: false, verdict: 'unrelated' }), A_NEW, B_OLD);
    expect(out).toEqual({ action: 'none', reason: 'not_same_subject' });
  });

  test('unrelated ⇒ no edge', () => {
    const out = deriveBeliefOutcome(verdict({ verdict: 'unrelated' }), A_NEW, B_OLD);
    expect(out).toEqual({ action: 'none', reason: 'unrelated' });
  });

  test('supersedes with direction none ⇒ no edge, no_direction (never guess the arrow)', () => {
    const out = deriveBeliefOutcome(verdict({ direction: 'none' }), A_NEW, B_OLD);
    expect(out).toEqual({ action: 'none', reason: 'no_direction' });
  });

  test('direction none takes precedence: even confidence 1.0 is STILL no_direction', () => {
    const out = deriveBeliefOutcome(verdict({ direction: 'none', confidence: 1 }), A_NEW, B_OLD);
    expect(out).toEqual({ action: 'none', reason: 'no_direction' });
  });
});

describe('deriveBeliefOutcome — SCOPE-FENCE INVARIANT (nothing ever reaches the hard channel)', () => {
  test('contests verdict is RECORDED but produces NO edge (contests edge is Inc-2)', () => {
    const out = deriveBeliefOutcome(verdict({ verdict: 'contests' }), A_NEW, B_OLD);
    expect(out).toEqual({ action: 'none', reason: 'contests_deferred' });
  });

  test('across EVERY verdict × confidence × direction, the ONLY non-none outcome is SOFT', () => {
    // The exhaustive sweep. Its job after 57f35350 is to prove a NEGATIVE — that no
    // combination of inputs reaches a hard mint — so it asserts on the action of EVERY
    // iteration rather than only inside a hard-mint branch (a branch that can no longer be
    // entered would make this loop vacuous, and a vacuous sweep is the classic hollow guard).
    let softSeen = 0;
    let noneSeen = 0;
    for (const v of BELIEF_VERDICTS as readonly BeliefVerdict[]) {
      for (const conf of [0, 0.2, 0.8, 0.9, 1.0]) {
        for (const dir of ['a_supersedes_b', 'b_supersedes_a', 'none'] as const) {
          // Oriented so the named superseder is the NEWER record: this sweep is about the
          // hard channel being unreachable, not about the chronology gate (swept below).
          const [ea, eb] = dir === 'b_supersedes_a' ? [A_OLD, B_NEW] : [A_NEW, B_OLD];
          const out = deriveBeliefOutcome(
            verdict({ verdict: v, confidence: conf, direction: dir }),
            ea,
            eb
          );
          expect(['soft_possibly_superseded', 'none']).toContain(out.action);
          if (out.action === 'soft_possibly_superseded') {
            // Soft only ever arises from a supersedes verdict with a real direction.
            expect(v).toBe('supersedes');
            expect(dir).not.toBe('none');
            softSeen += 1;
          } else {
            noneSeen += 1;
          }
        }
      }
    }
    // NON-VACUITY: the sweep must actually have exercised both arms. Without this, deleting
    // the soft path entirely would leave every assertion above trivially satisfied.
    // 5 confidences × 2 real directions, supersedes verdict only.
    expect(softSeen).toBe(10);
    expect(noneSeen).toBe(BELIEF_VERDICTS.length * 5 * 3 - 10);
  });
});

describe('deriveBeliefOutcome — CHRONOLOGY GATE: an inferred supersession never points backwards', () => {
  // The prod defect: handoff `fe3a81fc` (12:16:41Z) carried an inbound possibly_supersedes
  // from `49858772` (12:10:13Z) — the OLDER record minted as superseding the NEWER one, so
  // the briefing showed the CURRENT handoff as superseded_by a stale record. 55 of 1906
  // belief-minted edges on prod had that shape.

  test('a_supersedes_b where a is OLDER ⇒ REFUSED (no edge), reason direction_backwards_in_time', () => {
    const out = deriveBeliefOutcome(verdict({}), A_OLD, B_NEW);
    expect(out).toEqual({ action: 'none', reason: 'direction_backwards_in_time' });
  });

  test('b_supersedes_a where b is OLDER ⇒ REFUSED too (the guard is on the ARROW, not on the argument slot)', () => {
    const out = deriveBeliefOutcome(verdict({ direction: 'b_supersedes_a' }), A_NEW, B_OLD);
    expect(out).toEqual({ action: 'none', reason: 'direction_backwards_in_time' });
  });

  test('confidence 1.0 does not buy a backwards edge (chronology outranks the model)', () => {
    const out = deriveBeliefOutcome(verdict({ confidence: 1 }), A_OLD, B_NEW);
    expect(out).toEqual({ action: 'none', reason: 'direction_backwards_in_time' });
  });

  test('REFUSE, DO NOT FLIP: a backwards verdict mints NOTHING, not the reversed edge', () => {
    // The tempting "fix" is to swap from/to. That would turn a model that MISREAD the pair
    // into a confident edge in the other direction. This assertion is what forbids it.
    const out = deriveBeliefOutcome(verdict({}), A_OLD, B_NEW);
    expect(out.action).toBe('none');
    expect(out).not.toHaveProperty('fromId');
  });

  test('TIE: identical timestamps establish no order ⇒ REFUSED, reason chronology_tie', () => {
    // Reachable in production: two records written inside ONE transaction share that
    // transaction's now(), so equal created_at is not a synthetic case.
    const same = new Date(T0);
    const out = deriveBeliefOutcome(verdict({}), { id: A, createdAt: same }, { id: B, createdAt: same });
    expect(out).toEqual({ action: 'none', reason: 'chronology_tie' });
  });

  test('TIE is symmetric — the other direction is refused identically', () => {
    const same = new Date(T0);
    const out = deriveBeliefOutcome(
      verdict({ direction: 'b_supersedes_a' }),
      { id: A, createdAt: same },
      { id: B, createdAt: same }
    );
    expect(out).toEqual({ action: 'none', reason: 'chronology_tie' });
  });

  test('a tie expressed in two FORMATS (Date vs ISO string) is still a tie, not an ordering', () => {
    // Guards against comparing formats instead of instants: '2026-08-01T00:00:00.000Z' and
    // '2026-08-01T00:00:00.000+00:00' are the same instant and different strings.
    const out = deriveBeliefOutcome(
      verdict({}),
      { id: A, createdAt: '2026-08-01T00:00:00.000Z' },
      { id: B, createdAt: '2026-08-01T00:00:00.000+00:00' }
    );
    expect(out).toEqual({ action: 'none', reason: 'chronology_tie' });
  });

  test('ISO-string endpoints in different offsets are ordered as INSTANTS, and mint', () => {
    // 03:00+02:00 is 01:00Z — NEWER than 00:30Z, and must be ordered as an INSTANT.
    // This case does NOT discriminate a lexicographic implementation on its own (here the
    // string and instant comparisons happen to agree). The test that DOES pin it is the
    // two-formats tie above: 'Z' vs '+00:00' are string-unequal and the same instant.
    const out = deriveBeliefOutcome(
      verdict({}),
      { id: A, createdAt: '2026-08-01T03:00:00.000+02:00' },
      { id: B, createdAt: '2026-08-01T00:30:00.000Z' }
    );
    expect(out.action).toBe('soft_possibly_superseded');
  });

  // THE THIRD STATE. Missing/unreadable is neither "ordered" nor "backwards" — it is
  // "could not measure", and it gets its own reason and fails closed.
  const UNREADABLE: Array<[string, Date | string | null | undefined]> = [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['unparseable string', 'not-a-date'],
    ['Invalid Date', new Date('nope')],
  ];
  test.each(UNREADABLE)('an endpoint whose clock is %s ⇒ REFUSED, reason chronology_unknown', (_label, bad) => {
    // Once on each side, because a guard that only reads one endpoint passes half the cases.
    expect(deriveBeliefOutcome(verdict({}), { id: A, createdAt: bad }, B_OLD)).toEqual({
      action: 'none',
      reason: 'chronology_unknown',
    });
    expect(deriveBeliefOutcome(verdict({}), A_NEW, { id: B, createdAt: bad })).toEqual({
      action: 'none',
      reason: 'chronology_unknown',
    });
  });

  test('SWEEP: across every confidence × both directions, a BACKWARDS pair never mints', () => {
    let refused = 0;
    for (const conf of [0, 0.5, 0.9, 1]) {
      for (const dir of ['a_supersedes_b', 'b_supersedes_a'] as const) {
        // Orient the pair so the named superseder is always the OLDER record.
        const [ea, eb] = dir === 'a_supersedes_b' ? [A_OLD, B_NEW] : [A_NEW, B_OLD];
        const out = deriveBeliefOutcome(verdict({ confidence: conf, direction: dir }), ea, eb);
        expect(out).toEqual({ action: 'none', reason: 'direction_backwards_in_time' });
        refused += 1;
      }
    }
    // NON-VACUITY: the sweep must have run its whole grid (4 confidences × 2 directions).
    expect(refused).toBe(8);
  });

  test('CONTROL: the SAME grid, oriented forwards, still mints every time', () => {
    // Without this, a guard that refused EVERYTHING would satisfy the sweep above. This is
    // the assertion that says the fix did not ship a regression in place of the bug.
    let minted = 0;
    for (const conf of [0, 0.5, 0.9, 1]) {
      for (const dir of ['a_supersedes_b', 'b_supersedes_a'] as const) {
        const [ea, eb] = dir === 'a_supersedes_b' ? [A_NEW, B_OLD] : [A_OLD, B_NEW];
        const out = deriveBeliefOutcome(verdict({ confidence: conf, direction: dir }), ea, eb);
        expect(out.action).toBe('soft_possibly_superseded');
        if (out.action !== 'soft_possibly_superseded') throw new Error('unreachable');
        // and the arrow that IS minted points from the newer record to the older one.
        expect(out.fromId).toBe(dir === 'a_supersedes_b' ? A : B);
        expect(out.toId).toBe(dir === 'a_supersedes_b' ? B : A);
        minted += 1;
      }
    }
    expect(minted).toBe(8);
  });

  test('ONE MILLISECOND of separation is enough — the gate is strict order, not a window', () => {
    // There is deliberately no slack dial: a tunable "close enough" window would be a second
    // place for this rule to be wrong, and every value of it is arbitrary.
    const out = deriveBeliefOutcome(
      verdict({}),
      { id: A, createdAt: new Date(T0 + 1) },
      { id: B, createdAt: new Date(T0) }
    );
    expect(out.action).toBe('soft_possibly_superseded');
    const back = deriveBeliefOutcome(
      verdict({}),
      { id: A, createdAt: new Date(T0 - 1) },
      { id: B, createdAt: new Date(T0) }
    );
    expect(back).toEqual({ action: 'none', reason: 'direction_backwards_in_time' });
  });

  test('the chronology gate runs AFTER the subject/verdict guards (reason stays the specific one)', () => {
    // A backwards pair that is also `unrelated` must report `unrelated`, not the chronology
    // reason — otherwise the audit column stops telling you which stage refused the pair.
    expect(deriveBeliefOutcome(verdict({ verdict: 'unrelated' }), A_OLD, B_NEW)).toEqual({
      action: 'none',
      reason: 'unrelated',
    });
    expect(deriveBeliefOutcome(verdict({ sameSubject: false }), A_OLD, B_NEW)).toEqual({
      action: 'none',
      reason: 'not_same_subject',
    });
    expect(deriveBeliefOutcome(verdict({ direction: 'none' }), A_OLD, B_NEW)).toEqual({
      action: 'none',
      reason: 'no_direction',
    });
  });
});

describe('ollamaAdjudicator — pure JSON normalisation (no LLM)', () => {
  test('extractJson parses a clean object and a prose-wrapped object', () => {
    expect(extractJson('{"verdict":"restates"}')).toEqual({ verdict: 'restates' });
    expect(extractJson('here you go: {"verdict":"restates"} thanks')).toEqual({ verdict: 'restates' });
  });

  test('normalizeVerdict forces direction/mode to none for a non-supersedes verdict', () => {
    const v = normalizeVerdict({
      same_subject: true,
      subject: 'x',
      verdict: 'restates',
      direction: 'a_supersedes_b',
      mode: 'replaced',
      confidence: 0.9,
      rationale: 'r',
    });
    expect(v.direction).toBe('none');
    expect(v.mode).toBe('none');
  });

  test('normalizeVerdict clamps an out-of-range confidence into [0,1]', () => {
    expect(normalizeVerdict({ same_subject: true, subject: '', verdict: 'unrelated', direction: 'none', mode: 'none', confidence: 1.7, rationale: '' }).confidence).toBe(1);
    expect(normalizeVerdict({ same_subject: true, subject: '', verdict: 'unrelated', direction: 'none', mode: 'none', confidence: -3, rationale: '' }).confidence).toBe(0);
  });
});
