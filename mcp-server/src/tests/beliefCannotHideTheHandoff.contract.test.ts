/**
 * THE DIVERGENCE TEST — the belief adjudicator cannot delete the answer.
 *
 * ── WHY A TEST WITH *UNRELATED* CONTENT WOULD NOT HAVE CAUGHT THIS BUG ───────────────
 * The pre-57f35350 defect was NOT "the adjudicator fires on unrelated records". The
 * adjudicator was CORRECT about the overlap and wrong about the RELATIONSHIP: given a live
 * handoff and a newer note covering the same subject at high cosine, it returned a
 * high-confidence `supersedes` verdict — a reasonable read of two overlapping records — and
 * beliefDerivation.ts promoted that guess into the HARD channel. projectBriefing.ts uses
 * `supersedes` as a `NOT EXISTS` exclusion predicate, so the effect was not a slightly worse
 * briefing; it was a briefing that served NO handoff, or an older one.
 *
 * So the scenario here is deliberately the ADVERSARIAL one: a non-handoff context whose
 * content GENUINELY overlaps the live handoff, adjudicated by a provider returning the most
 * confident possible supersedes verdict (confidence 1.0, explicit direction, same subject).
 * That is the exact input that used to hide the handoff. A fixture with unrelated content
 * would produce an `unrelated` verdict and prove nothing.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────────────
 *   1. the adjudicator DID fire and DID reach a supersession outcome (non-vacuity — without
 *      this, a provider misconfiguration would make every assertion below pass trivially);
 *   2. the edge it minted is `possibly_supersedes`, and NO `supersedes` edge exists;
 *   3. the briefing STILL serves the current handoff — the property that was broken;
 *   4. the handoff is NOT pushed into the dead-ends section on the strength of the guess.
 *
 * The provider is a deterministic fake, not an LLM: the question under test is what the
 * PIPELINE does with a maximally-confident verdict, not whether a model produces one. Prod
 * produced 942 of them.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

// ── THE EMBEDDING FIXTURE, AND WHY IT IS NOT "make them identical" ──────────────────
// The pair must land INSIDE the nomination window AND above the pre-fix hard-mint gate, or
// this test cannot reach the code path that carried the bug. Both bounds are real:
//   * candidatePairing nominates only cosine ∈ [pairMinCosine 0.60, pairMaxCosine 0.95] —
//     identical vectors give cosine 1.0 and are EXCLUDED as near-duplicates. (Measured: the
//     first draft of this test used one shared vector and nominated ZERO pairs; the
//     non-vacuity assertion below is what caught it rather than letting it pass hollow.)
//   * the DELETED hard-mint gate required cosine >= mintMinCosine 0.75.
// So the note's vector is the handoff's with a small fraction of dimensions NEGATED. The
// pattern's energy is near-uniform across dimensions, so flipping fraction f gives cosine
// ≈ 1 - 2f; f = 0.075 targets ≈ 0.85 — comfortably inside (0.75, 0.95). The achieved cosine
// is ASSERTED in the test rather than trusted, because a fixture that silently drifted out
// of that band would make this whole file prove nothing.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    // NB the real signature is ({ text, role }), NOT a bare string. A mock taking a string
    // THROWS here, and context_store CATCHES embed failures and persists a NULL embedding —
    // so the wrong signature degrades silently into "no candidate pairs" rather than an
    // error. That cost a debugging round; it is why the assertions below are non-vacuity
    // checks and not just "the briefing still contains the handoff".
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => {
      const base = patternEmbedding();
      const embedding = text.includes('NOTE-MARK-')
        ? base.map((v, i) => (i < Math.round(base.length * 0.075) ? -v : v))
        : base;
      return { embedding, dimensions: embedDim(), model: 'stub' };
    }),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { adjudicateNeighbourhood } from '../services/belief/beliefAdjudicator.js';
import { expectPairingStageClean } from './helpers/beliefPairingWitness.js';
import { buildProjectBriefing } from '../services/projectBriefing.js';
import { TRUNK_CONTEXT_TYPE } from '../services/handoffSupersession.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import type { AdjudicationProvider, AdjudicatorVerdict } from '../services/belief/types.js';

const STAMP = Date.now();
const CONN = `belief-hide-conn-${STAMP}`;
const PROJ_NAME = `belief-hide-P-${STAMP}`;

const HANDOFF_MARK = `HANDOFF-MARK-${STAMP}`;
const NOTE_MARK = `NOTE-MARK-${STAMP}`;

let projectId: string;
let handoffId: string;
let noteId: string;

/**
 * The adversary: maximally confident that the newer note supersedes the older handoff. This
 * is the verdict the real adjudicator produced on prod — the one the old code trusted enough
 * to write into the exclusion channel.
 */
class MaxConfidenceSupersedes implements AdjudicationProvider {
  readonly name = 'fake';
  readonly model = 'max-confidence-supersedes';
  calls = 0;
  async adjudicate(): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    return {
      sameSubject: true,
      subject: 'the project handoff',
      verdict: 'supersedes',
      direction: 'a_supersedes_b',
      mode: 'replaced',
      confidence: 1, // the ceiling — above ANY threshold that could be reintroduced
      rationale: 'the newer note covers the same ground as the handoff',
    };
  }
}

async function store(content: string, type: string): Promise<string> {
  const resp: any = await routeExecutor(
    'context_store',
    { content, type, projectId },
    { connectionId: CONN }
  );
  return resp.structuredContent.context.id;
}

describe('belief adjudication CANNOT hide the current handoff', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'belief cannot hide the handoff') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    // The live handoff the briefing must keep serving.
    handoffId = await store(
      `${HANDOFF_MARK}\nMODE: build\nPATH: roots -> trunk -> branch:belief\nResuming the belief layer work; the supersession channel split is the open question.`,
      TRUNK_CONTEXT_TYPE
    );
    // A NEWER, NON-handoff context that genuinely OVERLAPS it — same subject, same
    // vocabulary. This is the record that used to bury the handoff.
    noteId = await store(
      `${NOTE_MARK}\nNotes on the belief layer supersession channel split — resuming the same build, same open question as the handoff above.`,
      'discussion'
    );
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM belief_adjudications WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  test('a maximally-confident supersedes verdict over the handoff mints SOFT, and the briefing still serves the handoff', async () => {
    // ── BEFORE: the briefing serves the handoff ──────────────────────────────────────
    const before = await buildProjectBriefing(projectId, PROJ_NAME, db);
    expect(before.markdown).toContain(HANDOFF_MARK);

    // ── RUN THE ADJUDICATOR, note → handoff, at the confidence ceiling ───────────────
    const provider = new MaxConfidenceSupersedes();
    const results = await adjudicateNeighbourhood(
      {
        id: noteId,
        type: 'context',
        projectId,
        content: `${NOTE_MARK} notes on the belief layer supersession channel split`,
      },
      { provider },
      db
    );

    // 0. THE FIXTURE LANDED WHERE THE BUG LIVED. Asserted, not assumed, and read straight
    //    from the vectors rather than from belief_adjudications — a row there only exists if
    //    the pipeline SUCCEEDED, so sourcing it from there would turn "the mint blew up" into
    //    a confusing fixture failure instead of a property failure. (It did exactly that on
    //    the first mutation run.) If this pair's cosine drifted out of
    //    (mintMinCosine 0.75, pairMaxCosine 0.95] the test would either nominate nothing or
    //    exercise a pair the OLD code would never have hard-minted.
    const cos = Number(
      (
        await db.query(
          `SELECT 1 - (a.${activeEmbeddingColumn()} <=> b.${activeEmbeddingColumn()}) AS cos
             FROM contexts a, contexts b WHERE a.id = $1 AND b.id = $2`,
          [noteId, handoffId]
        )
      ).rows[0].cos
    );
    expect(cos, 'the pair must sit above the DELETED hard-mint cosine gate (0.75)').toBeGreaterThan(0.75);
    expect(cos, 'and inside the nomination window (pairMaxCosine 0.95)').toBeLessThanOrEqual(0.95);

    // 1. NON-VACUITY. Without these, a pipeline that silently did nothing — a candidate
    //    stage that nominated no pair, a provider never consulted — would satisfy every
    //    assertion below. Deliberately phrased to hold in the PRE-FIX world too (any
    //    non-`none` outcome counts), so that a regression fails on the PROPERTY at step 2/3
    //    rather than short-circuiting here on a vacuity check.
    // CAUSE BEFORE SYMPTOM: a failed Stage-1 pairing query reaches zero pairs,
    // so this count assertion was the first thing to break and said only "expected 0 to be
    // greater than 0". Read the pairing stage's own verdict FIRST so a RED names its cause.
    await expectPairingStageClean(db, noteId, 'the newer note');
    expect(provider.calls, 'the adjudicator must actually have been consulted').toBeGreaterThan(0);
    const supersessions = results.filter((r) => r.outcome.action !== 'none');
    expect(
      supersessions.length,
      'the adversarial verdict must have produced a supersession outcome'
    ).toBeGreaterThan(0);
    // …and the outcome reached is the SOFT one, at confidence 1.0, which no bar exceeds.
    for (const r of results) {
      expect(r.outcome.action as string).not.toBe('mint_supersedes');
    }

    // 2. THE EDGE. A `possibly_supersedes` edge pointing AT the handoff exists; a
    //    `supersedes` edge pointing at it does not.
    const edges = (
      await db.query(
        `SELECT edge_type, provenance_class FROM links WHERE to_id = $1 ORDER BY edge_type`,
        [handoffId]
      )
    ).rows;
    expect(
      edges.some((e) => e.edge_type === 'possibly_supersedes'),
      'the inferred supersession must land in the annotating channel'
    ).toBe(true);
    expect(
      edges.some((e) => e.edge_type === 'supersedes'),
      'NO inferred supersedes edge may point at the handoff'
    ).toBe(false);

    // 3. THE PROPERTY THAT WAS BROKEN. Asserted on `data.handoff` — the STRUCTURED field the
    //    briefing serves — not on "the markdown contains the marker". That distinction is
    //    load-bearing and was measured, not assumed: under the pre-fix code the marker IS
    //    still present in the markdown, because the handoff gets rendered in the DEAD ENDS
    //    section as `- superseded: HANDOFF-MARK…`. A `toContain` on the markdown therefore
    //    PASSES against the bug. This is the assertion that goes RED.
    const after = await buildProjectBriefing(projectId, PROJ_NAME, db);
    expect(after.data.handoff, 'the briefing must STILL serve a handoff').toBeTruthy();
    expect(
      after.data.handoff!.id,
      'the served handoff must be the live one, not excluded by a guessed supersedes'
    ).toBe(handoffId);

    // 4. …and it is NOT shunted into the dead-ends section on the strength of the guess.
    //    (This is what 421 live contexts on prod had happen to them.)
    const deadEndSection = after.markdown.split('## Dead ends')[1] ?? '';
    expect(deadEndSection).not.toContain(HANDOFF_MARK);
  });

  test('the DECLARED channel still works: a real handoff-timeline supersession DOES retire the old handoff', async () => {
    // THE CONTROL, and the reason this suite is not just "supersedes never does anything".
    // Storing a SECOND handoff makes handoffSupersession mint a DECLARED `supersedes` edge
    // from the new one to the old — and that one MUST take effect, or the fix has broken the
    // feature instead of the defect.
    const SECOND = `HANDOFF-TWO-${STAMP}`;
    await store(`${SECOND}\nMODE: build\nPATH: roots -> trunk\nThe successor handoff.`, TRUNK_CONTEXT_TYPE);

    const declared = (
      await db.query(
        `SELECT count(*)::int AS n FROM links
          WHERE to_id = $1 AND edge_type = 'supersedes' AND provenance_class = 'declared'`,
        [handoffId]
      )
    ).rows[0].n;
    expect(declared, 'the handoff-timeline minter must still write the hard channel').toBe(1);

    const after = await buildProjectBriefing(projectId, PROJ_NAME, db);
    expect(after.markdown).toContain(SECOND);
    // The retired handoff is no longer the served one — the exclusion predicate still works,
    // for a DECLARED act.
    const handoffSection = after.markdown.split('##')[1] ?? after.markdown;
    expect(handoffSection).not.toContain(HANDOFF_MARK);
  });
});
