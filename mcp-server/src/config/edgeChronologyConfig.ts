/**
 * EDGE CHRONOLOGY — which edge types encode TIME in their direction, and where each node
 * type's timestamp lives.
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────────────
 * `supersedes` is not a symmetric relation: A supersedes B means A is the LATER record and
 * B is the one being replaced. Two mint sites already knew that and enforced it —
 * services/handoffSupersession.ts selects its predecessor with `(created_at, id) <`, and
 * services/belief/beliefDerivation.ts refuses a verdict with reason
 * `direction_backwards_in_time`. A third, links.ts `autoMintFromDecision`, mirrored a
 * decision's `superseded_by` column into a `supersedes` edge with NO chronology check at
 * all, so it could (and did) mint an edge pointing backwards in time.
 *
 * ── WHY THE CHECK LIVES AT mintEdge AND NOT AT THAT CALL SITE ────────────────────────
 * A per-caller guard covers the caller who wrote it. Measured on prod 2026-08-27 (the
 * query is in the task record): the ONE backwards `supersedes` edge came from the
 * unguarded decision mirror, and 58 backwards `possibly_supersedes` edges came from the
 * belief adjudicator — which HAS a chronology guard, and whose newest backwards edge was
 * minted the day before. Something between that guard and the insert loses the ordering.
 * A guard one layer above the write cannot see that; a guard AT the write can, because
 * every edge in the database goes through mintEdge. That is the choke point (C3).
 *
 * NO HARDCODED VARIABLES: the edge-type set and the per-entity timestamp source are named
 * here, once. `technical_decisions` is the reason the timestamp source needs a table — it
 * has NO `created_at` column; its creation instant is `decision_date`. A check that
 * assumed `created_at` everywhere would silently find no row for a decision endpoint and
 * report "unknown" for every decision edge, which is exactly the fail-open we are closing.
 */

import type { EdgeNodeType, EdgeType } from './edgeTypes.js';

/**
 * THE EDGE TYPES WHOSE DIRECTION IS A CLAIM ABOUT TIME. For these, `from` must be the
 * STRICTLY LATER record. Every other edge type (`informs`, `related_to`, `depends_on`, …)
 * is unordered in time and is not checked — an edge from an older record to a newer one is
 * ordinary and correct for them.
 *
 * `possibly_supersedes` is included deliberately: it is the SOFT form of the same claim
 * (migration 087 exists precisely because a guessed supersession must not hide a record),
 * and softness is about confidence, not about direction. A backwards soft supersession is
 * as wrong as a backwards hard one.
 */
export const CHRONOLOGY_ORDERED_EDGE_TYPES: readonly EdgeType[] = Object.freeze([
  'supersedes',
  'possibly_supersedes',
]);

const CHRONOLOGY_ORDERED_SET: ReadonlySet<string> = new Set<string>(
  CHRONOLOGY_ORDERED_EDGE_TYPES as readonly string[]
);

/** True iff this edge type's direction is a claim about time. */
export function isChronologyOrderedEdgeType(edgeType: string): boolean {
  return CHRONOLOGY_ORDERED_SET.has(edgeType);
}

/**
 * WHERE EACH NODE TYPE'S CREATION INSTANT LIVES. Table + column are IDENTIFIERS, so they
 * are interpolated into SQL — which is safe only because they can never come from a
 * caller: the key is an {@link EdgeNodeType}, validated against the closed node-type
 * domain before this map is consulted, and the values are literals in this file.
 */
export const ENTITY_CREATED_AT: Readonly<Record<EdgeNodeType, { table: string; column: string }>> =
  Object.freeze({
    context: { table: 'contexts', column: 'created_at' },
    task: { table: 'tasks', column: 'created_at' },
    // NOT created_at — technical_decisions has no such column (verified against the prod
    // schema 2026-08-27: information_schema returns only `decision_date` for this table).
    decision: { table: 'technical_decisions', column: 'decision_date' },
  });

/**
 * THE REFUSAL REASON, spelled exactly as services/belief/beliefDerivation.ts already spells
 * it. One vocabulary for one condition — a second spelling would make "how often do we
 * refuse a backwards edge?" a question with two answers.
 */
export const BACKWARDS_IN_TIME_REASON = 'direction_backwards_in_time' as const;

/**
 * The honest outcome of a chronology check. THREE states, not two (C1): `unknown` is what
 * an endpoint with no readable row returns, and it is deliberately NOT folded into `ok` or
 * `backwards`. It does not refuse — absence of a row is not evidence of backwardness — but
 * it is reported, so a caller can never mistake "I could not check" for "I checked".
 */
export type ChronologyVerdict = 'ok' | 'backwards' | 'unknown';
