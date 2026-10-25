/**
 * buildAdjudicationPrompt — PROMPT-CONTRACT unit tests, NO DB, NO LLM.
 *
 * Locks the REFERENCE-vs-SUPERSEDE hardening added 2026-07-07 after the
 * pre-prod dry-run measured the adjudicator over-firing `supersedes` ~30% of the time when a
 * newer handoff/completion merely REFERENCES/implements/builds-on a still-valid decision (the
 * harmful class — a progress note burying a live decision). The prompt is the single shared
 * surface across all providers (ollama/openai-compat/anthropic all call buildAdjudicationPrompt),
 * so pinning its contract here guards every provider at once. These go RED if the de-eager
 * clause, the guardrail, or the worked reference example is reverted.
 */

import { describe, test, expect } from 'vitest';

import { buildAdjudicationPrompt } from '../services/belief/ollamaAdjudicator.js';
import { BELIEF_ADJUDICATOR_CONFIG } from '../config/beliefConfig.js';
import type { AdjudicationRequest } from '../services/belief/types.js';

const req: AdjudicationRequest = {
  a: { id: 'a1', type: 'context', content: 'handoff: P4 architecture decided, moving to build', createdAt: '2026-07-01' },
  b: { id: 'b1', type: 'decision', content: 'DECISION: P4 architecture = layered runtime', createdAt: '2026-06-20' },
  cosine: 0.8,
};

const prompt = buildAdjudicationPrompt(req, BELIEF_ADJUDICATOR_CONFIG);

describe('buildAdjudicationPrompt — reference-vs-supersede hardening', () => {
  test('the over-broad "moves away from the older one" supersedes trigger is REMOVED', () => {
    // The old prompt said supersedes was the answer "whenever ... the newer one moves away
    // from the older one" — the clause that drove the ~30% over-fire. It must be gone.
    expect(prompt.toLowerCase()).not.toContain('moves away from the older one');
  });

  test('supersedes now requires the older value to become FALSE / a DIFFERENT current value', () => {
    expect(prompt).toContain('DIFFERENT CURRENT VALUE');
    expect(prompt.toLowerCase()).toContain('now false');
  });

  test('the GUARDRAIL (reference/mention/summarize/implement/build-on ≠ supersede) is present', () => {
    expect(prompt).toContain('REFERENCE IS NOT REPLACEMENT');
    // The five non-replacing relationships the guardrail must enumerate.
    for (const verb of ['REFERENCES', 'MENTIONS', 'SUMMARIZES', 'IMPLEMENTS', 'BUILDS ON']) {
      expect(prompt).toContain(verb);
    }
    // The concrete "progress note / handoff / status update does NOT replace a decision" rule.
    expect(prompt.toLowerCase()).toContain('does not replace that decision');
  });

  test('the worked REFERENCE-not-replace example (handoff about a decision → NOT supersedes) is present', () => {
    expect(prompt).toContain('REFERENCE, NOT REPLACEMENT');
    // The example resolves the P4-handoff-vs-P4-decision case to restates (no edge), not supersedes.
    expect(prompt).toContain('P4 architecture');
    // It must NOT teach a supersedes verdict for that example.
    const exampleLine = prompt
      .split('\n')
      .find((l) => l.includes('handoff: P4 architecture decided'));
    expect(exampleLine).toBeDefined();
  });

  test('both record contents are embedded in the prompt (base behaviour still holds)', () => {
    expect(prompt).toContain('handoff: P4 architecture decided, moving to build');
    expect(prompt).toContain('DECISION: P4 architecture = layered runtime');
  });
});

describe('buildAdjudicationPrompt — status-flip ≠ restatement hardening (BL-7)', () => {
  test('the STATUS-FLIP guardrail block is present (dominant MISS class)', () => {
    expect(prompt).toContain('STATUS-FLIP IS NOT A RESTATEMENT');
    // The enumerated status flips the recall probe found the adjudicator was burying under restates.
    for (const flip of [
      'not-done→done',
      'planned→shipped/live',
      'proposed→locked',
      'blocked→unblocked',
      'built→deployed',
      'rejected→approved',
    ]) {
      expect(prompt).toContain(flip);
    }
  });

  test('the guardrail keeps BOTH conditions (same subject AND older status now false) — no weakening', () => {
    // supersedes must still require the old claim to become FALSE — a status flip is one such case,
    // not a loophole around the reference-vs-replacement guardrail.
    expect(prompt).toContain('BOTH must hold for supersedes: SAME subject AND the');
    expect(prompt.toLowerCase()).toContain('older status is now false');
  });

  test('restates is explicitly scoped to SAME status reworded (a differing status is NOT restates)', () => {
    expect(prompt).toContain('restates requires the SAME truth-status');
  });

  test('worked STATUS-FLIP example is labeled supersedes WITH a direction', () => {
    const flipLine = prompt.split('\n').find((l) => l.includes('STATUS-FLIP — same subject'));
    expect(flipLine).toBeDefined();
    // The example resolves not-started→done to supersedes with an explicit winner direction.
    expect(prompt).toContain('the gemma embedder migration is DONE');
    expect(prompt).toContain('"verdict":"supersedes"');
    expect(prompt).toContain('"direction":"a_supersedes_b"');
  });

  test('a contrasting TRUE restatement example (same status, reworded) is labeled restates', () => {
    expect(prompt).toContain('TRUE RESTATEMENT — same status');
    expect(prompt).toContain('the gemma embedder migration is complete');
  });
});

describe('buildAdjudicationPrompt — direction hardening (the direction retraction)', () => {
  /**
   * 58 supersedes edges were retracted on 2026-08-28 because the adjudicator named the OLDER
   * record as superseder in 57 of them. The prompt invited exactly that: it said "Explicit
   * replacement/negation language OUTWEIGHS everything; dates are only a tie-breaker for
   * direction", which conflates two separate questions — language decides WHETHER a pair
   * supersedes, chronology decides WHICH WAY. In the observed failure the model matched
   * supersession language in a record aimed at a THIRD record and applied it to the pair.
   *
   * These pin the corrected rubric on the SINGLE shared prompt surface, so all four provider
   * paths (ollama, openai-compat, anthropic, and the tiered adjudicator's two tiers) are
   * covered by one assertion set — none of them builds its own text.
   */

  test('the "dates are only a tie-breaker for direction" clause is GONE', () => {
    // The exact clause that produced 57 of 58 backwards verdicts. Lower-cased so a
    // re-wording that keeps the idea in different capitalisation is still caught.
    expect(prompt.toLowerCase()).not.toContain('tie-breaker');
    expect(prompt.toLowerCase()).not.toContain('outweighs everything');
  });

  test('the rubric states that DIRECTION is decided by DATE, not by wording', () => {
    expect(prompt).toContain('DIRECTION IS DECIDED BY DATE');
    expect(prompt.toLowerCase()).toContain('later record supersedes the earlier');
    expect(prompt.toLowerCase()).toContain('an older record cannot supersede a newer one');
  });

  test('WHETHER and WHICH WAY are named as separate questions with different deciders', () => {
    // The whole correction is that these two are not one question. If a future edit collapses
    // them again, the pair of sentences below is what disappears.
    expect(prompt).toContain('WHETHER these two records supersede at all is decided by the LANGUAGE');
    expect(prompt).toContain('WHICH WAY is decided by the DATES');
  });

  test('the supersedes rule itself sets direction from the dates, not from "normally the newer"', () => {
    // The instruction inside the verdict rule, where a model reading top-down meets it first.
    expect(prompt).toContain('Set direction from the DATES, never from the wording');
    expect(prompt).toContain('"a_supersedes_b" if the A record is dated after the B record');
    // The old hedge ("normally the newer") left the model room to pick the other one.
    expect(prompt.toLowerCase()).not.toContain('normally the newer');
  });

  test('the THIRD-RECORD guardrail — the actual mechanism of the misjudgment — is present', () => {
    expect(prompt).toContain('REPLACEMENT LANGUAGE IS OFTEN AIMED AT A THIRD RECORD');
    expect(prompt).toContain("thing being replaced is the OTHER RECORD'S OWN CLAIM");
  });

  test('a worked example resolves OLDER-record replacement language to b_supersedes_a', () => {
    // Every pre-existing supersedes example is a_supersedes_b, so the examples alone taught
    // "A wins". This one is the counterweight: the replacement language sits in A, A is the
    // EARLIER record, and the correct answer is the other direction.
    expect(prompt).toContain('SAME SUBJECT, but the replacement language sits in the OLDER record');
    expect(prompt).toContain('"direction":"b_supersedes_a"');
    // ...and a worked example where third-record language yields no edge at all.
    expect(prompt).toContain('THIRD-RECORD LANGUAGE');
  });

  test('date= carries SECOND resolution, not a bare day — the rule is otherwise hollow', () => {
    // MEASURED over the 58 retracted pairs (reports/artifacts/b6-fde9bdaf-retract/, joined to
    // the endpoints' prod timestamps): at day resolution 56 of 58 are a TIE, at second
    // resolution 1. "Direction is decided by date" is unanswerable for 97% of exactly the
    // population that got it wrong unless the prompt prints a time. This is the assertion
    // that goes RED if someone re-shortens fmtDate.
    // The whole record header, so this pins the RENDERED field and not a substring that a
    // worked example in the rubric could also satisfy.
    expect(prompt).toContain('RECORD A (id=a1, type=context, date=2026-07-01T00:00:00Z)');
    expect(prompt).toContain('RECORD B (id=b1, type=decision, date=2026-06-20T00:00:00Z)');
  });

  test('an equal or unknown date= is told to refuse a direction rather than guess', () => {
    // The population that still slips through: a genuine same-second tie, and a record whose
    // timestamp did not resolve. Both must land on "no supersedes", not on a coin flip.
    expect(prompt).toContain('date= is "unknown" for either record, or the two are exactly EQUAL');
    expect(prompt).toContain('never "supersedes"');
  });

  test('the model is told to ignore dates written INSIDE the record text', () => {
    // The observed failure rationale asserted "A (later date)" about a record that was 2h41m
    // EARLIER — the model narrated a chronology instead of reading the field.
    expect(prompt).toContain('do not');
    expect(prompt).toContain('infer an order from dates mentioned INSIDE the record text');
  });
});
