/**
 * ALTITUDE PROJECTION — the ONE place a record is shrunk for the wire (SEARCH P3).
 *
 * DB-FREE ON PURPOSE (no `pg`, no db import), exactly like recallThreadCore.ts, whose
 * shapeNode() this module is the generalisation of. shapeNode was already a pure function
 * over {id,type,title,content} + trust + altitude with zero-database unit tests; the task
 * called for LIFTING it here rather than writing a second projection, because a second
 * projection is how two dials end up meaning two things.
 *
 * ★ THE RULE THAT DECIDES WHETHER THIS WORKED: the dial must move BOTH CHANNELS —
 * `result.content[].text` AND `result.structuredContent`. Measured on prod 2026-08-22,
 * smart_search at limit 10 spent 1,119 prose tokens against 14,379 structured; a dial that
 * leaves structuredContent at full size changes nothing that matters. So a route calls
 * projectBody() ONCE per row and renders BOTH channels from that single result. Never clip
 * the prose here and the structure somewhere else — that is two rules, and two rules drift.
 *
 * TWO FRICTIONS THIS MODULE ABSORBS, named because they are why a naive lift fails:
 *   - recall_thread calls the body `content`; smart_search calls it `summary`. So the
 *     projection returns a VALUE plus a presence flag, and the caller names the key.
 *   - ThreadNode.trust is required while a smart_search row's is optional (only
 *     context|decision|task are trustable). So projectTrust() is total over `undefined`.
 */

import {
  ALTITUDES,
  isAltitude,
  TRUST_WIRE_SCORE_PRECISION,
  type Altitude,
} from '../config/altitudeConfig.js';
import type { Trust } from './trustModel.js';

/**
 * THE SNIPPET BUDGET for one tool at `summary` — how many characters of body survive, and
 * the affordance appended when the clip actually bit.
 *
 * Both fields come from named config at every call site (threadConfig for recall_thread,
 * recallConfig for context_*, altitudeConfig for smart_search). This interface exists so a
 * route cannot pass a literal: there is nowhere in the shape to put one that is not already
 * a named constant somewhere.
 */
export interface SnippetBudget {
  /** Max characters of body returned at `summary`. */
  maxlen: number;
  /**
   * The suffix appended to a body that WAS clipped. `{omitted}` is substituted with the
   * number of characters dropped. It must name a PARAMETER, never a `tool arg:value` form:
   * the string `context_search id:<id>` previously taught agents to call
   * `query:'id:<uuid>'`, which silently returned an unrelated record (recallConfig.ts).
   */
  affordance: string;
}

/** Substitute the omitted-char count into a clip affordance template. ONE definition. */
export function formatOmitted(template: string, omittedChars: number): string {
  return template.replace('{omitted}', String(omittedChars));
}

/** The result of clipping a body to a budget: the text, and how much it dropped. */
export interface ClippedBody {
  text: string;
  omittedChars: number;
}

/**
 * Clip a body to `budget.maxlen`, appending the actionable affordance when it bit.
 *
 * A CLIP THAT DOES NOT SHRINK IS NOT A CLIP. The affordance costs bytes, so for a body that
 * only just overruns the budget the "clipped" form can be LONGER than the whole body — which
 * would both waste payload and claim an omission that saved nothing. In that case the body
 * is returned WHOLE with `omittedChars: 0`, so the caller's tally stays literally true.
 */
export function clipBody(body: string, budget: SnippetBudget): ClippedBody {
  if (body.length <= budget.maxlen) return { text: body, omittedChars: 0 };
  const omittedChars = body.length - budget.maxlen;
  const clipped = body.slice(0, budget.maxlen) + formatOmitted(budget.affordance, omittedChars);
  if (clipped.length >= body.length) return { text: body, omittedChars: 0 };
  return { text: clipped, omittedChars };
}

/** What one altitude does to one body. `present:false` means EMIT NO KEY AT ALL. */
export interface ProjectedBody {
  /** Emit the body key? False at `headline`, and for a record whose body is empty. */
  present: boolean;
  /** The value to emit when `present`. */
  text: string;
  /** Characters dropped by the `summary` clip; 0 otherwise. A measurement, not a guess. */
  omittedChars: number;
  /** True when the `summary` clip actually bit (the wire's `truncated` flag). */
  clipped: boolean;
}

/**
 * PROJECT ONE BODY to an altitude. The single definition of what headline/summary/full mean
 * for a record's body, shared by all four read tools.
 *
 *   headline → present:false — NO body key at all. Absent, not empty: a caller must be able
 *              to tell "this altitude does not carry bodies" from "this record has none".
 *   summary  → clipped to the budget, with the omitted-N-more affordance.
 *   full     → the whole, untruncated body.
 *
 * FAIL-CLOSED ON AN OFF-AXIS ALTITUDE. This is not defensive decoration: the
 * ancestor of this function was a two-branch if/else in which `headline` returned early,
 * `full` returned the body, and EVERY OTHER VALUE silently fell through to the summary clip.
 * The moment a second altitude AXIS existed (recall_thread's projection altitude `current`),
 * passing one here would have rendered a summary while claiming to be something else.
 */
export function projectBody(
  body: string | null | undefined,
  altitude: Altitude,
  budget: SnippetBudget
): ProjectedBody {
  if (!isAltitude(altitude)) {
    throw new Error(
      `projectBody: '${altitude}' is not an altitude (expected one of ${ALTITUDES.join(' | ')}). ` +
        `An off-axis value is never defaulted — route a different read model to its own ` +
        `builder instead of quietly shaping a body with it.`
    );
  }
  if (altitude === 'headline') return { present: false, text: '', omittedChars: 0, clipped: false };
  const text = body ?? '';
  if (!text) return { present: false, text: '', omittedChars: 0, clipped: false };
  if (altitude === 'full') return { present: true, text, omittedChars: 0, clipped: false };
  const c = clipBody(text, budget);
  return { present: true, text: c.text, omittedChars: c.omittedChars, clipped: c.omittedChars > 0 };
}

/**
 * TRUST ON THE WIRE — band + score, and nothing else (an earlier decision Part 2).
 *
 * Operator: "we just show the trust... the confidence score. Our trust score." Everything else
 * today's blob carries is DROPPED here: outcome{}, freshness, superseded, softSuperseded,
 * abstain, supersession, reason, promotionRequirement.
 *
 * MEASURED COST OF THE OLD SHAPE, which is why this exists: at recall_thread `headline`
 * altitude over 43 nodes on prod, trust was 14,391 chars against 4,156 chars of actual
 * titles — 3.5x the information it decorates. `reason:"trusted"` merely restates the band;
 * the nulls carry nothing; `score:0.9948746744592272` is sixteen digits of false precision
 * on a blended heuristic.
 *
 * WHY DROPPING IS SAFE FOR A CONSUMER THAT WANTED MORE: search and recall are surfaces for
 * DECIDING WHAT TO OPEN. A consumer that needs supersession or abstain fetches the record by
 * id, which returns full detail on every record type. This is the same altitude logic applied
 * to metadata rather than to bodies.
 *
 * Total over `undefined` (a smart_search row of a non-trustable kind has no trust at all).
 */
export interface WireTrust {
  band: string; // trust-render-exempt: a WIRE FIELD carried verbatim from the computed verdict; renders no badge, formats nothing
  /** The blended score at TRUST_WIRE_SCORE_PRECISION dp, or null at cold-start. */
  score: number | null;
}

/**
 * TRUST ON A DIRECT-LOOKUP — the COMPLETE verdict, with only the headline score rounded.
 *
 * ★ WHY A SECOND SHAPE EXISTS, AND WHY IT IS NOT A HEDGE (SEARCH P3 round 2).
 * an earlier Decision reduced trust to {band, score} and justified it in its own rationale:
 * "the counter-argument — that consumers may depend on supersession or abstain — is answered
 * by those consumers FETCHING THE RECORD BY ID, WHICH RETURNS FULL DETAIL". Reviewer
 * verified that sentence FALSE: round 1 applied projectTrust() to the by-id path too, so
 * supersession and abstain became machine-readable NOWHERE. A justification that is not true
 * is not a justification — either the rationale changes or the code does, and the coordinator called
 * the code.
 *
 * SO THE SPLIT IS THE DECISION'S OWN LOGIC, APPLIED HONESTLY: lean where you are DECIDING
 * WHAT TO OPEN (search, recall — many records, and band+score is sufficient for that choice),
 * complete where you have ALREADY CHOSEN (a direct lookup — exactly one record). It is the
 * same altitude reasoning the bodies follow, which is why the by-id path also returns the
 * whole body regardless of the list default.
 *
 * IT COSTS ESSENTIALLY NOTHING, and that is the point: the measured cost of the old blob was
 * an N-MULTIPLICATION — 14,391 chars over 43 nodes, ~330 chars per row times ten rows. A
 * direct lookup has N = 1. The saving this decision is about is untouched.
 *
 * WHY CONTEXTS SPECIFICALLY MAKE THIS LOAD-BEARING: a decision carries `superseded_by` /
 * `superseded_reason` / `status` as first-class COLUMNS that decision_get already returns, so
 * for decisions the escape hatch never depended on `trust`. A CONTEXT has no such column
 * (checked: information_schema shows zero `%supersed%` columns on `contexts`) — its
 * supersession is DERIVED from edges and exists only inside the computed verdict. Drop it
 * here and it is unreachable by any machine caller, on any surface.
 *
 * Only the top-level `score` is rounded, matching what the prose renderer prints. The
 * sub-signals (`freshness`, `outcome.score`) are left at full precision deliberately: they
 * are inputs a consumer does its own arithmetic on, where rounding is a lossy edit, not a
 * courtesy.
 */
export function projectTrustDirect(trust: Trust | undefined | null): Trust | undefined {
  if (!trust) return undefined;
  return { ...trust, score: roundScore(trust.score) };
}

export function projectTrust(trust: Trust | undefined | null): WireTrust | undefined {
  if (!trust) return undefined;
  return {
    band: trust.band, // trust-render-exempt: COPIES the verdict onto the wire unchanged; no token, no hint table, no formatting
    score: roundScore(trust.score),
  };
}

/**
 * Round a blended score to the configured wire precision, preserving null.
 *
 * NULL IS NOT ZERO. A cold-start record has no score, and rounding `null` to `0.00` would
 * turn "no evidence yet" into "measured, and it is the worst possible" — the same class of
 * lie as a could-not-measure reported as a failure (C1's third state).
 */
export function roundScore(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const f = 10 ** TRUST_WIRE_SCORE_PRECISION;
  return Math.round(score * f) / f;
}
