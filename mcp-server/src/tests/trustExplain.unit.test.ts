/**
 * TRUST EXPLAINABILITY — pure unit tests.
 *
 * THE BUG THIS ARMORS (presentation, NOT math — the math in trustModel.ts is correct and
 * untouched): at cold start `score = freshness` exactly and `band='unproven'` fires iff
 * there is no counted outcome, so a record honestly reads "freshness 1.00, ZERO outcome
 * evidence" — but rendered as the single line `🌱 unproven (1.00)` it looks like a
 * self-contradiction (an outside evaluator flagged exactly that). The same hint was ALSO
 * hand-written at FOUR render sites and two had already drifted (search.routes truncated
 * the cold-start clause; recall_thread's node headline had lost the clause AND the score).
 *
 * WHAT THIS LOCKS:
 *   - EVERY branch of computeTrust names itself in `trust.reason` (the taxonomy is traced
 *     from the math's own control flow — no invented categories),
 *   - `promotionRequirement` is DERIVED FROM TRUST_CONFIG (an injected/tuned config must
 *     change the printed numbers — no hardcoded thresholds),
 *   - a completed-but-unaccepted record stays `unproven` AND prints WHY,
 *   - band + score can never be rendered without an ADJACENT reason,
 *   - a superseded record still explains itself via the BL-5 receipt (no regression).
 *
 * DB-free + deterministic: trustModel.ts imports no pg pool, so this is offline.
 */

import { describe, test, expect } from 'vitest';
import {
  computeTrust,
  explainTrust,
  TRUST_REASONS,
  type OutcomeSample,
  type SupersessionReceipt,
  type TrustSignals,
} from '../services/trustModel.js';
import type { TrustConfig } from '../config/trustConfig.js';

/** The §8.1 the operator-approved defaults, pinned here so the assertions are explicit. */
const CFG: TrustConfig = {
  weightOutcome: 0.6,
  weightFreshness: 0.4,
  freshnessHalflifeDays: 30,
  trustedAt: 0.66,
  staleBelow: 0.4,
  abstainBelow: 0.4,
  minOutcomeSamples: 1,
  softSupersedeDemotion: 0.5,
};

const sig = (over: Partial<TrustSignals> = {}): TrustSignals => ({
  outcomes: [],
  ageDays: 0,
  supersededDeclared: false,
  supersededSoft: false,
  contradicted: false,
  ...over,
});

const out = (value: number | null): OutcomeSample => ({ value, source: 'decision' });

const declaredReceipt: SupersessionReceipt = {
  supersededBy: 'aaaaaaaa-1111-2222-3333-444444444444',
  tier: 'declared',
  confidence: null,
  reason: null,
};
const softReceipt: SupersessionReceipt = {
  supersededBy: 'bbbbbbbb-1111-2222-3333-444444444444',
  tier: 'soft',
  confidence: 0.85,
  reason: 'same claim, newer wording',
};

// ─────────────────────────────────────────────────────────────────────────────
// REASON — every branch of the math names itself
// ─────────────────────────────────────────────────────────────────────────────

describe('trust reason — names the ACTUAL branch computeTrust took', () => {
  test('cold-start: no counted outcome → band unproven AND reason cold-start (score IS the freshness)', () => {
    const t = computeTrust(sig({ ageDays: 0 }), CFG);
    expect(t.band).toBe('unproven');
    expect(t.score).toBe(1); // score = freshness exactly — the line that read as a contradiction
    expect(t.outcome.score).toBeNull();
    expect(t.outcome.samples).toBe(0);
    expect(t.reason).toBe('cold-start');
  });

  test('a COMPLETED-but-UNACCEPTED record stays unproven and says why (too_early is NOT evidence)', () => {
    // The downstream work exists and finished, but nothing has been independently accepted:
    // its outcome maps to null → NOT counted. The honest verdict is "no evidence yet".
    const t = computeTrust(sig({ outcomes: [out(null), out(null)], ageDays: 0 }), CFG);
    expect(t.band).toBe('unproven');
    expect(t.outcome.samples).toBe(0);
    expect(t.reason).toBe('cold-start');

    const e = explainTrust(t, CFG);
    expect(e.reasonText).toBe('no counted downstream outcome yet — score is freshness alone');
    expect(e.evidenceText).toBe('0 counted downstream outcomes');
    // ...and it says what would change the verdict.
    expect(e.promotionRequirement).toBe(
      '>= 1 counted downstream outcome, then score >= 0.66'
    );
  });

  test('trusted: outcome evidence + score >= trusted_at → reason trusted, nothing left to promote', () => {
    const t = computeTrust(sig({ outcomes: [out(1)], ageDays: 0 }), CFG);
    expect(t.band).toBe('trusted');
    expect(t.reason).toBe('trusted');
    expect(t.promotionRequirement).toBeNull(); // already the top band
  });

  test('ok: has evidence but below trusted_at → reason ok, promotion is the trusted_at threshold', () => {
    // outcome 0.5 (mixed) + fresh → 0.6*0.5 + 0.4*1 = 0.7 ... too high; age it a little.
    const t = computeTrust(sig({ outcomes: [out(0.5)], ageDays: 30 }), CFG); // freshness 0.5
    expect(t.band).toBe('ok');
    expect(t.reason).toBe('ok');
    expect(t.promotionRequirement).toBe('score >= 0.66');
  });

  test('stale: freshness below stale_below → reason stale (and the sentence names WHICH input tripped)', () => {
    const t = computeTrust(sig({ ageDays: 365 }), CFG); // freshness ≈ 0.0002
    expect(t.band).toBe('stale');
    expect(t.reason).toBe('stale');
    // At cold-start score IS freshness, so BOTH inputs are below the floor and the sentence
    // says so (rather than blaming one and lying about the other).
    expect(explainTrust(t, CFG).reasonText).toMatch(
      /freshness 0\.00 and score 0\.00 are below stale_below 0\.4/
    );
  });

  test('stale via a FAILED downstream while still fresh → the sentence blames the SCORE, not freshness', () => {
    // freshness 1.0 (fresh), outcome 0 → score 0.4 ... exactly at the floor; use a slight age.
    const t = computeTrust(sig({ outcomes: [out(0)], ageDays: 10 }), CFG);
    expect(t.band).toBe('stale');
    const text = explainTrust(t, CFG).reasonText;
    expect(text).toMatch(/score 0\.\d\d is below stale_below 0\.4/);
    expect(text).not.toMatch(/freshness .* is below/); // freshness is fine — don't lie about it
  });

  test('declared supersession → reason declared-superseded (the CAP wins over every other branch)', () => {
    const t = computeTrust(
      sig({ outcomes: [out(1)], supersededDeclared: true, supersessionReceipt: declaredReceipt }),
      CFG
    );
    expect(t.band).toBe('superseded');
    expect(t.reason).toBe('declared-superseded');
    expect(t.promotionRequirement).toBeNull(); // a cap, not a score — no promotion path
  });

  test('contradicted → reason contradicted', () => {
    const t = computeTrust(sig({ outcomes: [out(1)], contradicted: true }), CFG);
    expect(t.band).toBe('contradicted');
    expect(t.reason).toBe('contradicted');
    expect(t.promotionRequirement).toBeNull();
  });

  test('soft supersession → reason soft-demoted (it is what moved the score), promotion says so', () => {
    const t = computeTrust(
      sig({ ageDays: 0, supersededSoft: true, supersessionReceipt: softReceipt }),
      CFG
    );
    expect(t.softSuperseded).toBe(true);
    expect(t.reason).toBe('soft-demoted');
    expect(t.promotionRequirement).toContain('resolve the soft supersession');
    expect(t.promotionRequirement).toContain('x0.5'); // the config demotion multiplier
  });

  test('declared WINS over soft in the reason, exactly as it does in the math', () => {
    const t = computeTrust(
      sig({ supersededDeclared: true, supersededSoft: true, supersessionReceipt: declaredReceipt }),
      CFG
    );
    expect(t.reason).toBe('declared-superseded');
  });

  test('every emitted reason is a member of the published taxonomy', () => {
    const cases: TrustSignals[] = [
      sig(),
      sig({ outcomes: [out(1)] }),
      sig({ outcomes: [out(0.5)], ageDays: 30 }),
      sig({ ageDays: 365 }),
      sig({ supersededSoft: true }),
      sig({ supersededDeclared: true }),
      sig({ contradicted: true }),
      sig({ degraded: true }),
    ];
    const seen = new Set(cases.map((s) => computeTrust(s, CFG).reason));
    for (const r of seen) expect(TRUST_REASONS).toContain(r);
    // EVERY published branch is actually reachable — the taxonomy has no dead members.
    expect(seen.size).toBe(TRUST_REASONS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEGRADED — a failed signal gather must never render as an evidence claim (nit N3)
// ─────────────────────────────────────────────────────────────────────────────

describe('degraded fallback — says "not measured", never "no evidence"', () => {
  test('degraded outranks every other branch and claims nothing about outcomes', () => {
    // The shape trustForRecords' catch produces: empty signals + degraded.
    const t = computeTrust(sig({ ageDays: 0, degraded: true }), CFG);
    expect(t.reason).toBe('degraded');
    expect(t.promotionRequirement).toBeNull(); // nothing was measured → no promotion path

    const e = explainTrust(t, CFG);
    expect(e.reasonText).toContain('trust signals could not be read');
    expect(e.reasonText).toContain('NOT an evidence claim');
    // The lie we refuse to print: this record's outcomes were never QUERIED, so it must not
    // assert the cold-start sentence, nor "0 counted downstream outcomes".
    expect(e.reasonText).not.toContain('no counted downstream outcome yet');
    expect(e.line).not.toContain('no counted downstream outcome yet');
    expect(e.evidenceText).toBe('not read — the signal gather failed');
    expect(e.line).not.toMatch(/evidence: \d+ counted/);
  });

  test('degraded wins even when the other flags would have fired (nothing was measured)', () => {
    const t = computeTrust(
      sig({ degraded: true, supersededDeclared: true, contradicted: true, ageDays: 365 }),
      CFG
    );
    expect(t.reason).toBe('degraded');
  });

  test('the flag is presentation-only — it moves NO number', () => {
    const plain = computeTrust(sig({ ageDays: 12 }), CFG);
    const degraded = computeTrust(sig({ ageDays: 12, degraded: true }), CFG);
    expect(degraded.score).toBe(plain.score);
    expect(degraded.band).toBe(plain.band);
    expect(degraded.freshness).toBe(plain.freshness);
    expect(degraded.abstain).toBe(plain.abstain);
    expect(degraded.outcome).toEqual(plain.outcome);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROMOTION REQUIREMENT — derived from config, never hardcoded
// ─────────────────────────────────────────────────────────────────────────────

describe('promotion requirement — derived from TRUST_CONFIG (no hardcoded numbers)', () => {
  test('a TUNED config changes the printed thresholds (min_outcome_samples + trusted_at)', () => {
    const tuned: TrustConfig = { ...CFG, minOutcomeSamples: 3, trustedAt: 0.8 };
    const t = computeTrust(sig({ ageDays: 0 }), tuned);
    expect(t.reason).toBe('cold-start');
    expect(t.promotionRequirement).toBe(
      '>= 3 counted downstream outcomes, then score >= 0.8'
    );
    // and the DEFAULT config prints the default numbers — proving these are read, not baked.
    expect(computeTrust(sig({ ageDays: 0 }), CFG).promotionRequirement).toBe(
      '>= 1 counted downstream outcome, then score >= 0.66'
    );
  });

  test('a tuned stale_below is what the stale promotion quotes', () => {
    const tuned: TrustConfig = { ...CFG, staleBelow: 0.25 };
    const t = computeTrust(sig({ ageDays: 365 }), tuned);
    expect(t.reason).toBe('stale');
    expect(t.promotionRequirement).toContain('freshness/score >= 0.25');
  });

  test('a tuned soft demotion multiplier is what the soft-demoted promotion quotes', () => {
    const tuned: TrustConfig = { ...CFG, softSupersedeDemotion: 0.25 };
    const t = computeTrust(sig({ supersededSoft: true }), tuned);
    expect(t.promotionRequirement).toContain('x0.25');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING — a band/score is never shown without an adjacent reason
// ─────────────────────────────────────────────────────────────────────────────

describe('explainTrust — the ONE renderer', () => {
  /** Every branch of the math, so the rendering rules are asserted across the whole space. */
  const everyBranch: Array<{ what: string; signals: TrustSignals }> = [
    { what: 'cold-start', signals: sig({ ageDays: 0 }) },
    { what: 'trusted', signals: sig({ outcomes: [out(1)] }) },
    { what: 'ok', signals: sig({ outcomes: [out(0.5)], ageDays: 30 }) },
    { what: 'stale', signals: sig({ ageDays: 365 }) },
    {
      what: 'soft-demoted',
      signals: sig({ supersededSoft: true, supersessionReceipt: softReceipt }),
    },
    {
      what: 'declared-superseded',
      signals: sig({ supersededDeclared: true, supersessionReceipt: declaredReceipt }),
    },
    { what: 'contradicted', signals: sig({ contradicted: true }) },
    { what: 'degraded', signals: sig({ degraded: true }) },
  ];

  test('the score and the band NEVER appear without an adjacent reason (every branch)', () => {
    for (const { what, signals } of everyBranch) {
      const t = computeTrust(signals, CFG);
      const e = explainTrust(t, CFG);
      const reasonText = e.reasonText;
      expect(reasonText.length, `${what}: reason sentence must exist`).toBeGreaterThan(0);

      for (const rendered of [e.line, e.compact]) {
        // the band token is there...
        expect(rendered, `${what}: band token in "${rendered}"`).toContain(e.bandHint);
        // ...the score is there (score is never null in practice)...
        expect(rendered, `${what}: score in "${rendered}"`).toContain(e.scoreText);
        // ...and so is the reason, ON THE SAME LINE. This is the regression that let
        // "🌱 unproven (1.00)" ship as a bare self-contradiction.
        expect(rendered, `${what}: adjacent reason in "${rendered}"`).toContain(reasonText);
        expect(rendered.split('\n'), `${what}: stays a ONE-liner`).toHaveLength(1);
      }
      // the evidence count is always shown — "0 counted downstream outcomes" is the answer
      // to "unproven on what basis?"
      expect(e.line).toContain(e.evidenceText);
      expect(e.compact).toContain(e.evidenceText);
      expect(e.evidenceSamples).toBe(t.outcome.samples);
    }
  });

  /**
   * NO TRUST SURFACE MAY CLAIM AN ORDERING.
   *
   * `explainTrust` renders "a soft (auto) supersession demoted the score x0.5 — still shown,
   * RANKED LOWER" until this was measured: nothing in any read path sorts by trust score.
   * search.routes applies trust AFTER the relevance sort and says so in a comment,
   * recallThreadCore's orderThread sorts anchor → causal rank → time → id, and
   * currentStateCore sorts byRecencyThenId. The demotion is real; the ranking was invented,
   * and a reader who believed the sentence believed a demotion had protected them.
   *
   * THE POPULATION IS EVERY BRANCH OF THE MATH crossed with every string this renderer emits
   * — not the one sentence that was wrong. The previous guard covered
   * supersessionReceiptHint's three receipt shapes only, which is why the same claim survived
   * one function away, in the branch the task actually named.
   *
   * It bans the CLAIM, not the mechanism: if a read path ever really does sort by trust, this
   * test should be deleted in the commit that makes it true, and the ordering asserted where
   * the sort lives.
   */
  test('no rendered trust string claims a position in any ordering (every branch)', () => {
    const ORDERING_CLAIM = /rank|sort|ordered|shown (?:lower|below)|(?:lower|below) (?:in|than) the/i;
    for (const { what, signals } of everyBranch) {
      const t = computeTrust(signals, CFG);
      const e = explainTrust(t, CFG);
      for (const [field, rendered] of Object.entries({
        line: e.line,
        compact: e.compact,
        signal: e.signal,
        reasonText: e.reasonText,
        evidenceText: e.evidenceText,
        receipt: e.receipt,
        promotionRequirement: e.promotionRequirement ?? '',
      })) {
        expect(rendered, `${what}.${field} claims an ordering: "${rendered}"`).not.toMatch(
          ORDERING_CLAIM
        );
      }
    }
  });

  test('the full line carries the promotion requirement; the COMPACT one (dense node lists) does not', () => {
    const t = computeTrust(sig({ ageDays: 0 }), CFG);
    const e = explainTrust(t, CFG);
    expect(e.line).toContain(`to promote: ${t.promotionRequirement}`);
    expect(e.compact).not.toContain('to promote:');
    // compact must actually be COMPACT — recall_thread renders many nodes.
    expect(e.compact.length).toBeLessThan(e.line.length);
  });

  test('the explanation carries the evaluator target CONTENT (band/score/reason/evidence/promotion)', () => {
    // The evaluator asked for five facts. They are asserted as FIELDS, not as a pre-formatted
    // block: a formatted block no surface consumes is dead product code that rots into the
    // next drift (nit N1). The text channel gets them via .line; a structured consumer gets
    // them from trust.reason + trust.promotionRequirement + trust.outcome.samples.
    const t = computeTrust(sig({ ageDays: 0 }), CFG);
    const e = explainTrust(t, CFG);
    expect(e.band).toBe('unproven');
    expect(e.scoreText).toBe('1.00');
    expect(e.reasonText).toBe('no counted downstream outcome yet — score is freshness alone');
    expect(e.evidenceText).toBe('0 counted downstream outcomes');
    expect(e.promotionRequirement).toBe('>= 1 counted downstream outcome, then score >= 0.66');
    // ...and all five are readable off the ONE line an agent actually sees.
    for (const fact of [e.bandHint, e.scoreText, e.reasonText, e.evidenceText, e.promotionRequirement!]) {
      expect(e.line).toContain(fact);
    }
  });

  test('BL-5 NOT REGRESSED: a superseded record still explains via the receipt (who + why)', () => {
    const hard = explainTrust(
      computeTrust(
        sig({ supersededDeclared: true, supersessionReceipt: declaredReceipt }),
        CFG
      ),
      CFG
    );
    expect(hard.receipt).toBe(' by aaaaaaaa');
    expect(hard.line).toContain('⛔ superseded by aaaaaaaa'); // the receipt rides the band token
    expect(hard.compact).toContain('⛔ superseded by aaaaaaaa');
    expect(hard.line).toContain(hard.abstainMark);

    const soft = explainTrust(
      computeTrust(sig({ supersededSoft: true, supersessionReceipt: softReceipt }), CFG),
      CFG
    );
    expect(soft.line).toContain('possibly superseded by bbbbbbbb (conf 0.85)');
    expect(soft.compact).toContain('possibly superseded by bbbbbbbb (conf 0.85)');
  });

  test('ONE abstain marker: the SAME string on the dense line and the per-record line (nit N2)', () => {
    const abstaining = computeTrust(sig({ ageDays: 365 }), CFG); // stale → weak score → abstain
    expect(abstaining.abstain).toBe(true);
    const e = explainTrust(abstaining, CFG);
    expect(e.abstainMark).not.toBe('');
    // Both renderings carry it, and carry the IDENTICAL spelling — recall_thread used to
    // print ' ⛔ABSTAIN' while the other three printed ' · abstain'.
    expect(e.line).toContain(e.abstainMark);
    expect(e.compact).toContain(e.abstainMark);
    expect(e.line.endsWith(e.abstainMark)).toBe(true);
    expect(e.compact.endsWith(e.abstainMark)).toBe(true);
    // The retired second spelling must not come back anywhere in the rendering.
    expect(e.line).not.toContain('ABSTAIN');
    expect(e.compact).not.toContain('ABSTAIN');

    const fine = explainTrust(computeTrust(sig({ outcomes: [out(1)] }), CFG), CFG);
    expect(fine.abstainMark).toBe('');
    expect(fine.line.toLowerCase()).not.toContain('abstain');
    expect(fine.compact.toLowerCase()).not.toContain('abstain');
  });
});
