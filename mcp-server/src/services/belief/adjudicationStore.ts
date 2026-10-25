/**
 * BELIEF ADJUDICATION STORE (the belief-layer design §1: "a new small table belief_adjudications
 * records EVERY pairwise verdict = idempotency + audit trail + the labeled-set feeder").
 *
 * Every verdict — including RESTATES / UNRELATED / below-dial — is persisted. This is the
 * audit trail (why did / didn't we mint an edge), the idempotency key (don't re-adjudicate
 * the same pair with the same model), and the feeder that grows the labeled set over time.
 *
 * Edges are minted ELSEWHERE (links.mintEdge) and only for high-confidence supersessions;
 * this store records the verdict + the derived action + the minted edge id (if any).
 *
 * Idempotency: a pair is canonicalised (least id, greatest id) so the unordered pair is
 * stored once per (provider, model). Re-running the belief job over the same pair with the
 * same model UPDATES the existing row rather than duplicating it.
 */

import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import type { EdgeNodeType } from '../../config/edgeTypes.js';
import type { AdjudicatorVerdict } from './types.js';
import type { BeliefOutcome } from './beliefDerivation.js';

/** Canonical unordered-pair key so (a,b) and (b,a) map to one row. */
export function pairKey(idA: string, idB: string): string {
  return idA <= idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

export interface RecordEndpoint {
  id: string;
  type: EdgeNodeType;
}

export interface RecordAdjudicationInput {
  projectId: string | null;
  a: RecordEndpoint;
  b: RecordEndpoint;
  cosine: number | null;
  provider: string;
  model: string;
  verdict: AdjudicatorVerdict;
  outcome: BeliefOutcome;
  /** The `possibly_supersedes` edge id, when the outcome minted one. */
  mintedEdgeId?: string | null;
}

export interface StoredAdjudication {
  id: string;
  createdAt: Date;
}

/**
 * Persist (or update) one adjudication verdict. Idempotent on (pair_key, provider, model).
 * Returns the row id + created_at. The derived action + reason come from the BeliefOutcome
 * so the row explains WHY an edge was or wasn't minted.
 */
export async function recordAdjudication(
  input: RecordAdjudicationInput,
  pool: Pool = db
): Promise<StoredAdjudication> {
  const key = pairKey(input.a.id, input.b.id);
  const derivedAction = input.outcome.action; // 'soft_possibly_superseded' | 'none'
  // no_edge_reason explains WHY the pair produced NO edge at all — the NoEdgeReason. It is
  // NULL for `soft_possibly_superseded`, which DID produce an edge. Before the no-hard-tier change the soft
  // tier also wrote a below-bar reason here (below_confidence / below_cosine), naming which
  // hard-mint threshold it had missed; the thresholds are gone, so there is nothing left to
  // name and `derived_action` alone carries the outcome. Historical rows keep their value.
  const noEdgeReason = input.outcome.action === 'none' ? input.outcome.reason : null;

  const result = await pool.query(
    `INSERT INTO belief_adjudications (
        project_id, pair_key,
        a_id, a_type, b_id, b_type,
        same_subject, subject, verdict, direction, mode, confidence, rationale,
        cosine, provider, model, derived_action, no_edge_reason, minted_edge_id
     ) VALUES (
        $1, $2,
        $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19
     )
     ON CONFLICT (pair_key, provider, model) DO UPDATE SET
        same_subject = EXCLUDED.same_subject,
        subject      = EXCLUDED.subject,
        verdict      = EXCLUDED.verdict,
        direction    = EXCLUDED.direction,
        mode         = EXCLUDED.mode,
        confidence   = EXCLUDED.confidence,
        rationale    = EXCLUDED.rationale,
        cosine       = EXCLUDED.cosine,
        derived_action = EXCLUDED.derived_action,
        no_edge_reason = EXCLUDED.no_edge_reason,
        -- OVERWRITE (not COALESCE) minted_edge_id with the reconciled value: a re-adjudication
        -- that retracts the pair's edge passes NULL here, and the row must reflect that the
        -- edge is gone (the auditor #7 reversibility) rather than keep pointing at a now-deleted
        -- links row. The adjudicator reconciles the actual edge (edgeReconciliation.ts) BEFORE
        -- this write, so EXCLUDED.minted_edge_id is always the true current state.
        minted_edge_id = EXCLUDED.minted_edge_id,
        adjudicated_at = now()
     RETURNING id::text AS id, created_at`,
    [
      input.projectId,
      key,
      input.a.id,
      input.a.type,
      input.b.id,
      input.b.type,
      input.verdict.sameSubject,
      input.verdict.subject,
      input.verdict.verdict,
      input.verdict.direction,
      input.verdict.mode,
      input.verdict.confidence,
      input.verdict.rationale,
      input.cosine,
      input.provider,
      input.model,
      derivedAction,
      noEdgeReason,
      input.mintedEdgeId ?? null,
    ]
  );

  return { id: result.rows[0].id, createdAt: result.rows[0].created_at };
}

/** Fetch a prior verdict for a pair (idempotency probe / audit read). */
export async function getAdjudication(
  idA: string,
  idB: string,
  provider: string,
  model: string,
  pool: Pool = db
): Promise<Record<string, unknown> | null> {
  const key = pairKey(idA, idB);
  const r = await pool.query(
    `SELECT * FROM belief_adjudications WHERE pair_key = $1 AND provider = $2 AND model = $3`,
    [key, provider, model]
  );
  return r.rows[0] ?? null;
}
