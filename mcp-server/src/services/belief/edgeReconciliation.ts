/**
 * BELIEF EDGE RECONCILIATION (Phase 4 — Inc-1 reversibility fix, generalized in BL-3).
 *
 * WHY (the auditor foundation-review finding #7, ref:foundation-review 4c0a50ad): the belief
 * layer's core promise is "verdicts are DATA and re-adjudication is REVERSIBLE" — the
 * property that justifies shipping on top of an API-model adjudicator (a model swap /
 * re-run must be able to WITHDRAW a claim, not just add one). Before this module, the
 * store upserted each verdict but `COALESCE`-kept the previously-minted `minted_edge_id`,
 * so when a pair was RE-adjudicated to a verdict that no longer supported the old edge the
 * stale edge SURVIVED — a graph edge the current verdict contradicts. This module makes the
 * minted edge always reflect the CURRENT verdict.
 *
 * ONE MINTABLE EDGE TYPE, TWO RETRACTABLE ONES:
 *   - `possibly_supersedes` — the ONLY edge belief adjudication can mint. It annotates: the
 *                             record still renders, and trust demotes it (BL-4).
 *   - `supersedes`          — NEVER minted here. It is an exclusion predicate in
 *                             projectBriefing.ts, and belief adjudication is a confidence-
 *                             scored guess. It stays in the RETRACTION sweep, which is what
 *                             WITHDRAWS a hard edge minted by the pre-57f35350 code when its
 *                             pair is re-adjudicated. Migration 087 converted the rest and
 *                             makes a guessed `supersedes` unwritable.
 * A pair carries AT MOST ONE belief edge at a time. The reconciler mints the single edge the
 * current outcome supports and RETRACTS every other belief-minted edge for the pair.
 *
 * WHAT it does, for one adjudicated pair (a, b), given the derived outcome:
 *   - `soft_possibly_superseded`→ ensure the `possibly_supersedes` edge (from→to); retract
 *                                 any `supersedes` on the pair + the opposite-direction
 *                                 `possibly_supersedes`.
 *   - `none`                    → retract BOTH belief edge types (both directions).
 *
 * PROVENANCE-CLEAN (design §9d): retraction is guarded by `created_by =
 * BELIEF_EDGE_CREATED_BY` (via unlinkEdge's createdBy guard) — the reconciler only ever
 * removes edges IT minted; a human-curated supersedes/possibly_supersedes edge on the same
 * endpoints is never clobbered. Reuses the existing links-service primitives (mintEdge /
 * unlinkEdge) — no parallel edge-write path.
 *
 * RECALL: trust.ts reads `possibly_supersedes` as a SOFT signal (BL-4) — it demotes the
 * record's score and sets softSuperseded, and it never abstains or drops it. That is the
 * whole point: an inferred supersession may lower a record's rank; it may not remove it.
 *
 * Reconciliation works off the ACTUAL pair endpoints + the current outcome (never the
 * stored a_id/b_id order), so it is correct regardless of which member of the pair was the
 * re-adjudication's `source`. Idempotent: an unchanged verdict mints a no-op and retracts
 * nothing (no churn).
 */

import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import { mintEdge as realMintEdge, unlinkEdge as realUnlinkEdge } from '../links.js';
import type { EdgeNodeType, EdgeType } from '../../config/edgeTypes.js';
import { BELIEF_EDGE_CREATED_BY } from '../../config/beliefConfig.js';
import type { BeliefOutcome } from './beliefDerivation.js';
import { EDGE_MINT_VIA } from '../../config/edgeProvenanceConfig.js';

/**
 * The belief-minted edge types the adjudicator manages — the ONLY edge types this module
 * ever mints OR retracts. A single named list (not scattered literals) so the mint side and
 * the retract side can never drift apart, and so a pair's two tiers stay mutually exclusive:
 * on every reconcile, EVERY belief edge on the pair that is not the currently-desired one is
 * retracted (across BOTH types and BOTH directions).
 */
const BELIEF_EDGE_TYPES: readonly EdgeType[] = ['supersedes', 'possibly_supersedes'];

/** One endpoint of the adjudicated pair (as passed to the adjudicator this run). */
export interface ReconcileEndpoint {
  id: string;
  type: EdgeNodeType;
}

export interface ReconcileInput {
  a: ReconcileEndpoint;
  b: ReconcileEndpoint;
  /** The derived outcome for THIS (re-)adjudication — what the current verdict supports. */
  outcome: BeliefOutcome;
  projectId: string | null;
  /**
   * Metadata stamped onto the newly-minted belief edge (confidence/mode/rationale/… for a
   * hard mint; confidence/reason[]/provenance/… for a soft mint). Only meaningful when the
   * outcome mints an edge; ignored for a `none` outcome (nothing is minted).
   */
  edgeMetadata: Record<string, unknown>;
}

/**
 * The DB primitives the reconciler needs, injected so unit tests can supply in-memory
 * fakes and prove the mint/retract behaviour with no database. Defaults are the real
 * links-service functions — production wiring is unchanged.
 */
export interface ReconcileDeps {
  mintEdge: typeof realMintEdge;
  unlinkEdge: typeof realUnlinkEdge;
}

const DEFAULT_DEPS: ReconcileDeps = { mintEdge: realMintEdge, unlinkEdge: realUnlinkEdge };

/** A single directed belief edge on the pair (a specific type + direction). */
export interface RetractedEdge {
  fromId: string;
  toId: string;
  edgeType: EdgeType;
}

export interface ReconcileResult {
  /** The `links` id of the belief edge the current verdict supports (null if none). */
  mintedEdgeId: string | null;
  /** The type of the edge minted this run (null when the outcome minted nothing). */
  mintedEdgeType: EdgeType | null;
  /** True only when a BRAND-NEW edge row was inserted this run (false = idempotent no-op). */
  edgeCreated: boolean;
  /** The belief edges retracted this run (empty when nothing was stale). */
  retracted: RetractedEdge[];
}

/**
 * Resolve the single directed belief edge the CURRENT outcome supports, or null (a `none`
 * outcome mints nothing).
 */
function desiredEdge(
  input: ReconcileInput
): { edgeType: EdgeType; fromId: string; fromType: EdgeNodeType; toId: string; toType: EdgeNodeType } | null {
  const { a, b, outcome } = input;
  if (outcome.action !== 'soft_possibly_superseded') {
    return null; // 'none' → no belief edge
  }
  // The ONLY edge type this reconciler can mint. `supersedes` is NOT reachable here — it is
  // an exclusion predicate downstream, and belief adjudication is a guess.
  // It remains in the RETRACTION sweep below, which is what withdraws the pre-57f35350 hard
  // edges on re-adjudication.
  const edgeType: EdgeType = 'possibly_supersedes';
  const fromType = outcome.fromId === a.id ? a.type : b.type;
  const toType = outcome.toId === a.id ? a.type : b.type;
  return { edgeType, fromId: outcome.fromId, fromType, toId: outcome.toId, toType };
}

/**
 * Reconcile the belief-minted edge for one (re-)adjudicated pair so the graph reflects the
 * CURRENT verdict: mint the single edge the outcome supports (hard `supersedes` or soft
 * `possibly_supersedes`) and retract every OTHER belief edge on the pair (the two types ×
 * two directions, minus the desired one). Idempotent + provenance-guarded. See the module
 * header for the full contract.
 */
export async function reconcileBeliefEdge(
  input: ReconcileInput,
  pool: Pool = db,
  deps: ReconcileDeps = DEFAULT_DEPS
): Promise<ReconcileResult> {
  const { a, b, projectId } = input;

  const desired = desiredEdge(input);

  let mintedEdgeId: string | null = null;
  let mintedEdgeType: EdgeType | null = null;
  let edgeCreated = false;

  // 1. Ensure the desired edge exists (mintEdge is idempotent on (from,to,type) → no churn
  //    when the verdict is unchanged; returns the existing id in that case).
  if (desired) {
    const minted = await deps.mintEdge(
      {
        fromId: desired.fromId,
        fromType: desired.fromType,
        toId: desired.toId,
        toType: desired.toType,
        edgeType: desired.edgeType,
        projectId,
        createdBy: BELIEF_EDGE_CREATED_BY,
        via: EDGE_MINT_VIA.beliefAdjudication,
        metadata: input.edgeMetadata,
      },
      pool
    );
    mintedEdgeId = minted.edgeId ?? null;
    mintedEdgeType = desired.edgeType;
    edgeCreated = minted.created;
  }

  // 2. Retract every belief-minted edge for this pair the current verdict no longer
  //    supports: the full cross-product of {supersedes, possibly_supersedes} × {a→b, b→a}
  //    MINUS the single desired edge. This makes the two tiers MUTUALLY EXCLUSIVE (a soft
  //    mint withdraws a stale hard edge and vice-versa) and covers direction flips + the
  //    drop-to-none case in one sweep. The createdBy guard means we only ever remove OUR
  //    edges — a human-curated edge on the same endpoints is untouched.
  const directions: Array<{ fromId: string; toId: string }> = [
    { fromId: a.id, toId: b.id },
    { fromId: b.id, toId: a.id },
  ];
  const retracted: RetractedEdge[] = [];
  for (const edgeType of BELIEF_EDGE_TYPES) {
    for (const dir of directions) {
      if (
        desired &&
        desired.edgeType === edgeType &&
        dir.fromId === desired.fromId &&
        dir.toId === desired.toId
      ) {
        continue; // keep the single edge the current verdict supports
      }
      const result = await deps.unlinkEdge(
        {
          fromId: dir.fromId,
          toId: dir.toId,
          edgeType,
          createdBy: BELIEF_EDGE_CREATED_BY,
        },
        pool
      );
      if (result.removed) {
        retracted.push({ fromId: dir.fromId, toId: dir.toId, edgeType });
      }
    }
  }

  return { mintedEdgeId, mintedEdgeType, edgeCreated, retracted };
}
