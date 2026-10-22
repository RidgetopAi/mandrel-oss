/**
 * FABRICATED HEAD RESOLUTION for the briefing renderer's pure-function tests (P5.2).
 *
 * `BriefingData.handoffHead` is REQUIRED — that is the point of it, for the same reason
 * `census` is required (an earlier decision RULING 4): the renderer must not be able to fall
 * back to a silent default, and adding the field must stop the GREEN path compiling rather
 * than quietly changing what a fabricated corpus means.
 *
 * DERIVED FROM THE FIXTURE'S OWN HANDOFF, never hand-typed: a corpus whose resolution named
 * a different id than its `handoff` would render a header about a record it is not showing,
 * and every existing assertion would still pass. One helper, six test files, no second
 * spelling. Fixtures that want a REFUSAL build one explicitly — that is the interesting
 * state and it should never be reachable by accident.
 */
import type { HandoffHeadResolution } from '../../services/handoffHead.js';

/**
 * The resolution of a corpus that has a handoff and resolved it cleanly: both seeds sat on
 * it, zero hops. This is what every pre-P5.2 fixture was implicitly assuming.
 */
export function resolvedHead(handoff: { id: string } | null): HandoffHeadResolution {
  if (handoff === null) {
    return {
      status: 'absent',
      headId: null,
      concurringSeeds: [],
      walks: [
        { seed: 'recency', seedId: null, hops: null, terminalId: null, refusal: null },
        { seed: 'tag', seedId: null, hops: null, terminalId: null, refusal: null },
      ],
      refusal: null,
      candidates: [],
      lineage: { ancestorsScanned: 0, scanComplete: true },
      maxHops: 256,
    };
  }
  return {
    status: 'resolved',
    headId: handoff.id,
    concurringSeeds: ['recency', 'tag'],
    walks: [
      { seed: 'recency', seedId: handoff.id, hops: 0, terminalId: handoff.id, refusal: null },
      { seed: 'tag', seedId: handoff.id, hops: 0, terminalId: handoff.id, refusal: null },
    ],
    refusal: null,
    candidates: [],
    lineage: { ancestorsScanned: 1, scanComplete: true },
    maxHops: 256,
  };
}
