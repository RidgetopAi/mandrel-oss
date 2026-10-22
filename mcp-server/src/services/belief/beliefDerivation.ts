/**
 * BELIEF DERIVATION — the PURE decision core (Phase 4, Increment 1).
 *
 * Given a Stage-2 adjudicator verdict for a candidate pair (a, b), derive the DELIBERATE
 * OUTCOME. There is exactly ONE outcome that carries a supersession:
 *   - `soft_possibly_superseded` — a real supersedes candidate (same-subject, explicit
 *     direction), minted as a `possibly_supersedes` edge by edgeReconciliation;
 *   - `none` — everything else, with a recorded reason.
 * This is the deterministic seam the belief-eval + the CI gate vitest lock down — NO LLM, NO DB,
 * no I/O — so it CANNOT lie-green: revert the direction handling and a test goes red.
 *
 * ── WHY THERE IS NO HARD TIER ANY MORE (P0) ───────────────────────────
 * This module used to promote a verdict to a HARD `supersedes` edge when confidence and
 * cosine both cleared tight dials (conf >= 0.9, cos >= 0.75). That was a defect, not a
 * tuning choice, because of what the two channels MEAN downstream:
 *
 *   `possibly_supersedes` ANNOTATES — the record still renders; trust demotes it.
 *   `supersedes`          EXCLUDES  — it is a NOT EXISTS predicate in projectBriefing.ts,
 *                                     so a false positive does not degrade the answer, it
 *                                     DELETES the answer.
 *
 * A confidence-scored LLM heuristic cannot be allowed to reach an exclusion predicate at
 * ANY threshold: 0.9 confidence is still a guess, and the resulting edge was
 * indistinguishable from a declared act. The governing rule, now enforced in three layers:
 *
 *   **AN INFERRED EDGE MUST NEVER BE ABLE TO MAKE A RECORD INVISIBLE.**
 *
 *   TYPE    — `BeliefOutcome` has no `mint_supersedes` member, so no code in this repo can
 *             construct one; edgeReconciliation's only reachable edge type is
 *             `possibly_supersedes`.
 *   DB      — `links_supersedes_declared_only` (migration 087) rejects any `supersedes`
 *             row whose GENERATED provenance_class is not 'declared'. This is the layer
 *             that holds against raw SQL and against a service nobody has written.
 *   MEASURED— on prod, honouring only declared supersedes changed the served handoff for
 *             0 of 84 projects; the 942 guessed hard edges bought nothing on that path
 *             while putting 421 live contexts in the dead-ends section on a guess alone.
 *
 * Design ca9a33c0 §3 + §4 (contests is NOT an outcome edge — guarded like related_to in
 * trust.ts) + §8 (Inc-1 = supersession only).
 *
 * THE INVARIANTS this module guarantees:
 *   1. The ONLY edge ever derived is `possibly_supersedes` (never `supersedes`, never
 *      `contests`, never any other type).
 *   2. Direction is honoured exactly: a_supersedes_b ⇒ from=a→to=b; b_supersedes_a ⇒
 *      from=b→to=a. A `supersedes` verdict with direction `none` yields NOTHING (we do not
 *      guess which way the arrow points).
 *   3. AN INFERRED SUPERSESSION MAY NEVER POINT BACKWARDS THROUGH TIME.
 *      A supersession is a claim about WHICH RECORD IS CURRENT. If the direction the
 *      adjudicator returned makes an OLDER record supersede a NEWER one, the claim
 *      contradicts the only fact here we did not have to guess, and the pair yields NOTHING.
 *
 * ── WHY INVARIANT 3 EXISTS, AND WHY IT REFUSES RATHER THAN FLIPS ─────────────────────
 * Measured on prod 2026-08-26: 55 of 1906 belief-minted `possibly_supersedes` edges (2.9%)
 * had from.created_at < to.created_at — an older record marked as superseding a newer one,
 * gaps up to 3d10h. One of them discredited the live handoff of an eval project: the
 * briefing rendered the CURRENT handoff as `superseded_by:<a stale record>`, which is the
 * worst possible failure for a recall product — it serves the stale record as the truth.
 *
 * The rule "normally the newer record supersedes" already existed — as PROMPT PROSE in the
 * adjudicators. Prose is the place a model can ignore a rule. Here it is arithmetic on two
 * timestamps we already carry, on the deterministic seam, where it cannot be ignored.
 *
 * REFUSE, DO NOT AUTO-FLIP. A returned direction that disagrees with chronology is evidence
 * the model MISREAD THE PAIR, not evidence that the arrow is merely reversed — flipping it
 * would convert a misread into a confident edge pointing the other way. Refusing fails
 * closed, mints nothing, and records WHY on the adjudication row (`no_edge_reason`), so the
 * disagreement stays visible instead of being papered over.
 *
 * SCOPE: this module only ever mints GUESSED edges (mint_via `belief-adjudication`), so the
 * guard applies to exactly the guessed tier and cannot reach a declared/human edge — a
 * declared backfill ("this old decision supersedes that newer note") stays legal. Measured
 * on prod: 1 of 98 declared supersedes edges violates the invariant, via
 * `decision-superseded-by`; that path is deliberately NOT touched here.
 */

import type { AdjudicatorVerdict, BeliefDirection, BeliefMode } from './types.js';

/** The reason a pair produced NO edge (recorded on the adjudication row for audit). */
export type NoEdgeReason =
  /** Adjudicator judged the pair to be about different subjects/scopes (case-3 guard). */
  | 'not_same_subject'
  /** Verdict was `restates` — a restatement, no change (case-6 guard). */
  | 'restates'
  /** Verdict was `unrelated`. */
  | 'unrelated'
  /** Verdict was `contests` — a real conflict, but the contests edge is Increment 2. */
  | 'contests_deferred'
  /** Verdict was `supersedes` but direction was `none` — we do not guess the arrow. */
  | 'no_direction'
  /**
   * The returned direction would make an OLDER record supersede a NEWER one (invariant 3).
   * REFUSED — see the module header.
   */
  | 'direction_backwards_in_time'
  /**
   * The two records carry the SAME timestamp, so chronology establishes no order and the
   * direction rests entirely on the model's guess. Refused, for the same reason a `none`
   * direction is refused: we do not guess the arrow. Ties are reachable in production —
   * two records written inside one transaction both take that transaction's `now()`.
   */
  | 'chronology_tie'
  /**
   * At least one endpoint carried no usable timestamp, so the invariant COULD NOT BE
   * MEASURED. This is deliberately its own reason and its own branch rather than being
   * folded into "the direction is fine" — a check that cannot distinguish "not backwards"
   * from "I could not tell" is not a check. Fails closed: no edge.
   */
  | 'chronology_unknown';

/** The direction on a soft/hard supersession — always explicit (never `none`; that's no_direction). */
export type ExplicitDirection = Extract<BeliefDirection, 'a_supersedes_b' | 'b_supersedes_a'>;

/** The derived outcome for one adjudicated pair. */
export type BeliefOutcome =
  | {
      /**
       * THE ONLY supersession outcome: a real supersedes candidate — same-subject, with an
       * explicit direction — carried as a `possibly_supersedes` edge (BL-3/BL-4 consume it:
       * it annotates and demotes, it never excludes). There is deliberately no hard tier;
       * see the module header.
       */
      action: 'soft_possibly_superseded';
      /** The record that (softly) supersedes. */
      fromId: string;
      /** The record that is (softly) superseded. */
      toId: string;
      mode: Extract<BeliefMode, 'replaced' | 'fallback_retained'>;
      confidence: number;
      /** The explicit direction (never `none` — a `none` direction is `no_direction`, not soft). */
      direction: ExplicitDirection;
      rationale: string;
    }
  | { action: 'none'; reason: NoEdgeReason };

/**
 * One endpoint of the adjudicated pair, as the derivation needs it: its id and the clock
 * that establishes its position in time.
 *
 * WHICH CLOCK. `createdAt` is the record's creation timestamp AS THE PAIRING STAGE READ IT —
 * `contexts.created_at` for a context, `technical_decisions.decision_date` for a decision
 * (candidatePairing.EMBEDDED_TABLES is the single source of that mapping, and the live
 * post-store hooks pass the same two columns). Both are `timestamptz`, so the comparison is
 * instant-vs-instant and never a string comparison of two formats.
 *
 * Taking an ENDPOINT rather than a bare id is deliberate — but READ THE LIMIT: it makes the
 * timestamp impossible to omit only for call sites INSIDE `mcp-server/tsconfig.json`, whose
 * `include` covers the `src` and `tests` trees only. `mcp-server/scripts/` and `evals/` are outside
 * it and are exec'd by tsx (transpile-only), so a site there that passes two id STRINGS
 * compiles, runs, and silently yields `chronology_unknown` for every pair. That is not
 * hypothetical: `evals/belief-eval/xaiAdjRun.ts` had exactly that shape, and reverting a
 * scripts/ call site to the id form leaves `npx tsc --noEmit` at exit 0 with no error. The
 * type documents the contract; it does not gate it everywhere the contract is used.
 */
export interface BeliefEndpoint {
  id: string;
  /** Creation instant (Date or ISO string). Missing/unparseable ⇒ `chronology_unknown`. */
  createdAt?: Date | string | null;
}

/**
 * Milliseconds since epoch for an endpoint's clock, or `null` when it CANNOT BE READ —
 * absent, null, or an unparseable string. `null` is the third state ("could not measure")
 * and gets its own branch at the call site; it is never silently treated as 0 or as "fine".
 */
function endpointMillis(ep: BeliefEndpoint): number | null {
  const raw = ep.createdAt;
  if (raw === null || raw === undefined) return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Derive the outcome for a pair (a, b) from its adjudicator verdict.
 *
 * Pure: same inputs → same output, no side effects. `a`/`b` are the records in the SAME
 * order the verdict's `direction` refers to (a=first, b=second).
 */
export function deriveBeliefOutcome(
  verdict: AdjudicatorVerdict,
  a: BeliefEndpoint,
  b: BeliefEndpoint
): BeliefOutcome {
  // Different subject/scope ⇒ never an edge (the thin-subject-anchor guard, case 3).
  if (!verdict.sameSubject) {
    return { action: 'none', reason: 'not_same_subject' };
  }

  switch (verdict.verdict) {
    case 'restates':
      return { action: 'none', reason: 'restates' };
    case 'unrelated':
      return { action: 'none', reason: 'unrelated' };
    case 'contests':
      // Increment 1 mints NO contests edge (that is Inc-2). Record + defer.
      return { action: 'none', reason: 'contests_deferred' };
    case 'supersedes':
      return deriveSupersedes(verdict, a, b);
    default: {
      // Exhaustiveness guard: an unknown verdict is treated as no-edge, never minted.
      const _never: never = verdict.verdict;
      void _never;
      return { action: 'none', reason: 'unrelated' };
    }
  }
}

/**
 * The supersedes branch — direction resolution, and nothing else to decide.
 *
 * A same-subject supersedes verdict WITH an explicit direction always yields the soft
 * `possibly_supersedes` outcome. There is no confidence or cosine bar here by design: a
 * bar's only job would be to promote some guesses into the exclusion channel, and an
 * inferred edge must never be able to make a record invisible (module header). A `none`
 * direction is `no_direction` — we don't guess the arrow.
 */
function deriveSupersedes(
  verdict: AdjudicatorVerdict,
  a: BeliefEndpoint,
  b: BeliefEndpoint
): BeliefOutcome {
  // Direction MUST be explicit — we never guess which way the arrow points.
  let from: BeliefEndpoint;
  let to: BeliefEndpoint;
  let direction: ExplicitDirection;
  if (verdict.direction === 'a_supersedes_b') {
    from = a;
    to = b;
    direction = 'a_supersedes_b';
  } else if (verdict.direction === 'b_supersedes_a') {
    from = b;
    to = a;
    direction = 'b_supersedes_a';
  } else {
    return { action: 'none', reason: 'no_direction' };
  }

  // CHRONOLOGY GATE (invariant 3). The superseder must be STRICTLY NEWER than
  // the record it supersedes. Three refusals, three distinct reasons — a tie and an
  // unreadable clock are NOT "not backwards", they are "no order to honour", and collapsing
  // them into the pass branch is the failure mode this guard exists to prevent.
  const fromMs = endpointMillis(from);
  const toMs = endpointMillis(to);
  if (fromMs === null || toMs === null) {
    return { action: 'none', reason: 'chronology_unknown' };
  }
  if (fromMs === toMs) {
    return { action: 'none', reason: 'chronology_tie' };
  }
  if (fromMs < toMs) {
    return { action: 'none', reason: 'direction_backwards_in_time' };
  }

  // Mode: `none` on a supersedes verdict defaults to `replaced` (the common flavour);
  // `fallback_retained` is preserved (case 2). Never yields mode 'none'.
  const mode: Extract<BeliefMode, 'replaced' | 'fallback_retained'> =
    verdict.mode === 'fallback_retained' ? 'fallback_retained' : 'replaced';

  return {
    action: 'soft_possibly_superseded',
    fromId: from.id,
    toId: to.id,
    mode,
    confidence: verdict.confidence,
    direction,
    rationale: verdict.rationale,
  };
}
