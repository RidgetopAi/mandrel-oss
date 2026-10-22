/**
 * FABRICATED CENSUS for the briefing renderer's pure-function tests (SK5).
 *
 * `BriefingData.census` is REQUIRED — that is the point of it: the renderer may not state a
 * population it was not given (an earlier decision RULING 6). So every fabricated corpus has
 * to supply one, and the honest default for a fabricated corpus is "the query returned
 * exactly the rows in this array, hit no bound, excluded nothing".
 *
 * DERIVED FROM THE ARRAY, never hand-typed: a fixture whose census disagrees with its own
 * records would make the section headings assert a number no test author checked, and the
 * assertions would still pass. One helper, two test files, no second spelling.
 */
import type { BriefingCensus, SectionCensus } from '../../services/projectBriefing.js';

/** The census of a section that returned exactly `rows` rows, unbounded and unfiltered. */
export function censusOf(rows: readonly unknown[]): SectionCensus {
  return { fetched: rows.length, fetchBoundReached: false, excluded: 0, excludedReason: null };
}

/** The whole-document census for a fabricated corpus, derived from its own arrays. */
export function censusFor(parts: {
  tasks: readonly unknown[];
  decisions: readonly unknown[];
  conventions: readonly unknown[];
  deadEnds: readonly unknown[];
  branchMembers?: readonly unknown[];
}): BriefingCensus {
  return {
    tasks: censusOf(parts.tasks),
    decisions: censusOf(parts.decisions),
    conventions: censusOf(parts.conventions),
    deadEnds: censusOf(parts.deadEnds),
    branchMembers: censusOf(parts.branchMembers ?? []),
  };
}
