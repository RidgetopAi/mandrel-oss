/**
 * BELIEF ADJUDICATOR ORCHESTRATOR (Phase 4, Increment 1 — supersession detection).
 *
 * Ties the pieces together for ONE candidate pair and for a whole record's neighbourhood:
 *   Stage-1 findCandidates (cosine gate) → Stage-2 provider.adjudicate → deriveBeliefOutcome
 *   → mint a `supersedes` edge (links.mintEdge) ONLY for a high-confidence supersession
 *   → record EVERY verdict in belief_adjudications (audit + idempotency).
 *
 * Design an earlier change §3/§4. Runs ASYNC, off any write critical path, SERIAL (concurrency from
 * beliefConfig, locked at 1 — the embedder shares the box, capacity recon). This
 * module is the exercised-end-to-end surface the belief-eval drives; the live post-store
 * BullMQ hook + gated backfill scan are the Inc-2 activation seam (not wired into the live
 * write path here, to keep embedder priority + zero prod blast radius this increment).
 *
 * SCOPE FENCE (Increment 1): the ONLY edge minted is `supersedes` (already honoured by
 * trust.ts). No `contests` edge, no band flip, no expiry — those are Inc-2 / Inc-3.
 */

import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import type { EdgeNodeType } from '../../config/edgeTypes.js';
import { BELIEF_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefConfig } from '../../config/beliefConfig.js';
import { logger } from '../../utils/logger.js';
import { deriveBeliefOutcome } from './beliefDerivation.js';
import type { BeliefOutcome } from './beliefDerivation.js';
import { recordAdjudication, pairKey } from './adjudicationStore.js';
import { failureAttempt, recordAttemptSafe } from './attemptLedger.js';
import type { BeliefFailureStage } from './providerError.js';
import { recordProviderCallCostsSafe } from './costLedger.js';
import type { BeliefCostConfig } from '../../config/beliefCostConfig.js';
import { assertWithinSpendCap, BeliefSpendCapError } from './spendCap.js';
import { reconcileBeliefEdge } from './edgeReconciliation.js';
import { findCandidates, readRecordCreatedAt, BeliefPairingError } from './candidatePairing.js';
import type { PairingSource, Candidate, PairingFailure } from './candidatePairing.js';
import { getAdjudicationProvider } from './provider.js';
import type {
  AdjudicationProvider,
  AdjudicationRecord,
  AdjudicatorVerdict,
} from './types.js';

/** The full result of adjudicating one pair — the verdict, the derived outcome, and any edge. */
export interface PairAdjudicationResult {
  a: { id: string; type: EdgeNodeType };
  b: { id: string; type: EdgeNodeType };
  cosine: number | null;
  verdict: AdjudicatorVerdict;
  outcome: BeliefOutcome;
  /** The belief edge id (`possibly_supersedes`), if one was minted (and whether it was newly created). */
  mintedEdgeId: string | null;
  edgeCreated: boolean;
  /** The belief_adjudications row id. */
  adjudicationId: string;
}

/**
 * Adjudicate ONE candidate pair end-to-end: verdict → derive → mint (if warranted) → record.
 * Idempotent via the store's ON CONFLICT + mintEdge's ON CONFLICT. `projectId` scopes both
 * the adjudication row and the minted edge.
 */
export async function adjudicatePair(
  a: AdjudicationRecord,
  b: AdjudicationRecord,
  opts: {
    cosine?: number | null;
    projectId: string | null;
    provider: AdjudicationProvider;
    /** Cost config for the spend-cap guard (default: the live BELIEF_COST_CONFIG). */
    costCfg?: BeliefCostConfig;
  },
  pool: Pool = db
): Promise<PairAdjudicationResult> {
  const cosine = opts.cosine ?? null;
  // ATTEMPT LEDGER. Every pair attempt is COUNTED, whichever way it ends — the
  // verdict table can only ever hold successes, so before this a skipped pair was persisted
  // nowhere and the pipeline could not report its own miss rate. `stage` advances as we go so a
  // failure that is NOT a typed provider error is still attributed to where it actually died.
  const startedAt = Date.now();
  let stage: BeliefFailureStage = 'provider';
  try {
    // HARD DAILY SPEND CAP: refuse BEFORE any provider call. Throws a typed
    // BeliefSpendCapError, which the catch below books as a failed pair attempt (distinct
    // errorClass) and rethrows — the neighbourhood loop skips the pair, the write is unaffected.
    await assertWithinSpendCap(opts.provider, pool, opts.costCfg);
    const verdict = await opts.provider.adjudicate({ a, b, cosine });
    // BL-10 COST LEDGER: append one row per REAL LLM call this adjudicate() made (the tiered
    // provider reports tier-1 always + tier-2 on escalation; single providers report one). Read
    // serial-safely right after the awaited call (concurrency=1). FAIL-SAFE + non-blocking — a
    // ledger error is swallowed inside recordProviderCallCostsSafe, so the verdict is never at risk.
    await recordProviderCallCostsSafe(
      opts.provider,
      { projectId: opts.projectId, pairKey: pairKey(a.id, b.id) },
      pool
    );
    // Derivation: a same-subject supersedes with an explicit direction yields
    // the SOFT outcome, always. There is no hard tier — an inferred edge must never be able to
    // make a record invisible (see beliefDerivation.ts's header).
    // The WHOLE records go in, not just their ids: the derivation gates the
    // direction on the two `createdAt` clocks, so an older→newer supersession is REFUSED here
    // rather than minted. Both live hooks (context_store / decision_record) and the pairing
    // stage populate createdAt; an endpoint that somehow arrives without one is refused as
    // `chronology_unknown` rather than passed through.
    stage = 'derivation';
    const outcome = deriveBeliefOutcome(verdict, a, b);

    // RECONCILE the pair's belief edge against the CURRENT verdict: mint the
    // `possibly_supersedes` edge the verdict supports (idempotent) AND retract any
    // belief-minted edge it no longer supports — a re-adjudication that flips direction or
    // drops the pair (→ none/unrelated/restates) WITHDRAWS the stale edge instead of leaving
    // it to survive (the auditor #7: re-adjudication must be reversible). The retraction sweep still
    // covers `supersedes` as well as `possibly_supersedes`, so a hard edge minted by the
    // earlier code is WITHDRAWN when its pair is re-adjudicated. Metadata is only
    // meaningful when an edge is minted.
    let edgeMetadata: Record<string, unknown> = {};
    if (outcome.action === 'soft_possibly_superseded') {
      // The `reason[]` key (below_confidence / below_cosine) was DELETED with the two-tier bar
      // in an earlier change — it recorded WHICH threshold a candidate missed, and there are no
      // thresholds. `rationale` is the adjudicator's own WHY and is what trust.ts's
      // readEdgeReason prefers; it still reads reason[] off the historical rows that carry it.
      edgeMetadata = {
        confidence: outcome.confidence,
        mode: outcome.mode,
        rationale: outcome.rationale,
        subject: verdict.subject,
        // (SK4) `provenance: BELIEF_EDGE_CREATED_BY` was DELETED here: it was a verbatim copy
        // of the row's own created_by, read by nothing, and a third name for a fact that now
        // has one home (links.mint_via = 'belief-adjudication').
        provider: opts.provider.name,
        model: opts.provider.model,
        cosine,
      };
    }
    stage = 'persist';
    const reconciled = await reconcileBeliefEdge(
      {
        a: { id: a.id, type: a.type },
        b: { id: b.id, type: b.type },
        outcome,
        projectId: opts.projectId,
        edgeMetadata,
      },
      pool
    );
    const mintedEdgeId: string | null = reconciled.mintedEdgeId;
    const edgeCreated = reconciled.edgeCreated;

    const stored = await recordAdjudication(
      {
        projectId: opts.projectId,
        a: { id: a.id, type: a.type },
        b: { id: b.id, type: b.type },
        cosine,
        provider: opts.provider.name,
        model: opts.provider.model,
        verdict,
        outcome,
        mintedEdgeId,
      },
      pool
    );

    // COMPLETED — the other half of the rate. attempted = completed + failed, one table, one query.
    await recordAttemptSafe(
      {
        scope: 'pair',
        outcome: 'completed',
        projectId: opts.projectId,
        pairKey: pairKey(a.id, b.id),
        aId: a.id,
        bId: b.id,
        // The AUTHORITATIVE tier's identity, read synchronously after the awaited call — the same
        // serial contract recordAdjudication above already relies on.
        provider: opts.provider.name,
        model: opts.provider.model,
        durationMs: Date.now() - startedAt,
      },
      pool
    );

    return {
      a: { id: a.id, type: a.type },
      b: { id: b.id, type: b.type },
      cosine,
      verdict,
      outcome,
      mintedEdgeId,
      edgeCreated,
      adjudicationId: stored.id,
    };
  } catch (e) {
    await recordAttemptSafe(
      failureAttempt(e, {
        scope: 'pair',
        projectId: opts.projectId,
        pairKey: pairKey(a.id, b.id),
        aId: a.id,
        bId: b.id,
        provider: null,
        model: null,
        durationMs: Date.now() - startedAt,
        fallbackStage: stage,
      }),
      pool
    );
    // RETHROW UNCHANGED. The degradation behaviour is deliberately untouched: the caller still
    // skips this pair and its neighbours still proceed. The only change is that the skip is now
    // countable instead of invisible.
    throw e;
  }
}

/**
 * The async job body: for one freshly-stored (or backfilled) record, find its candidate
 * neighbours and adjudicate each SERIALLY (concurrency from cfg, locked at 1 — never
 * overlap the embedder). Returns every pair result. NEVER throws for a single-pair failure
 * — a bad adjudication degrades to a skipped pair, the rest proceed.
 *
 * `loadSource` must supply the record's own content (the pairing query returns the
 * neighbour content, not the source's).
 */
export async function adjudicateNeighbourhood(
  source: PairingSource & { content: string; createdAt?: Date | string | null },
  opts?: { cfg?: BeliefConfig; provider?: AdjudicationProvider; costCfg?: BeliefCostConfig },
  pool: Pool = db
): Promise<PairAdjudicationResult[]> {
  const cfg = opts?.cfg ?? BELIEF_CONFIG;
  // NEIGHBOURHOOD-SCOPE ATTEMPT. Everything up to the pair loop can die BEFORE
  // any pair is reached — provider construction with no API key, or the candidate query — and
  // then EVERY pair for this record is lost while the pair ledger records nothing at all,
  // because no pair was ever attempted. That is not hypothetical: measured on the tenant fleet
  // 2026-08-28, 7 instances logged 23 whole-neighbourhood failures and ZERO successful
  // adjudications (no belief provider configured), and the only trace was an ephemeral log line.
  let provider: AdjudicationProvider;
  // A pairing-stage measurement that COULD NOT BE TAKEN. findCandidates used
  // to return `[]` for this, indistinguishable from a healthy empty neighbourhood, so the
  // ledger below booked the miss as `completed` — the one instrument whose stated purpose is
  // the miss rate recorded the miss as a success. It is now typed, so the failure is BOOKED
  // AS FAILED with fallbackStage 'pairing'. Behaviour is deliberately unchanged otherwise:
  // no throw (the belief job must never sink a caller), and whatever partial the other table
  // yielded is still adjudicated.
  let pairingFailure: PairingFailure | null = null;
  const neighbourhoodStartedAt = Date.now();
  try {
    provider = opts?.provider ?? getAdjudicationProvider();
  } catch (e) {
    await recordAttemptSafe(
      failureAttempt(e, {
        scope: 'neighbourhood',
        projectId: source.projectId,
        sourceId: source.id,
        durationMs: Date.now() - neighbourhoodStartedAt,
        fallbackStage: 'provider_init',
      }),
      pool
    );
    throw e; // degradation unchanged: the hook still skips this record's whole neighbourhood.
  }
  // BOOK a pairing-stage failure — at most ONCE per neighbourhood. The FIRST failure wins: it
  // is closest to the cause, and it mirrors findCandidates' own first-failure-wins rule. A
  // second row would double-count `attempted` and break the exactly-one-neighbourhood-row
  // invariant the completion write at the bottom depends on. Booked EAGERLY, as each stage
  // reports, not at the end: the row must exist even if the pair loop below hangs or the
  // process dies.
  const bookPairingFailure = async (reason: PairingFailure): Promise<void> => {
    await recordAttemptSafe(
      failureAttempt(new BeliefPairingError(reason), {
        scope: 'neighbourhood',
        projectId: source.projectId,
        sourceId: source.id,
        provider: provider.name,
        model: provider.model,
        durationMs: Date.now() - neighbourhoodStartedAt,
        fallbackStage: 'pairing',
      }),
      pool
    );
  };

  // NO try/catch AROUND THE PAIRING STAGE. There used to be one, ending in
  // `throw e` — dead code, and a latent hazard rather than a safety net: everything here is
  // already fail-safe by construction (findCandidates and readRecordCreatedAt each wrap their
  // own queries and return a typed failure; recordAttemptSafe swallows; failureAttempt /
  // describeFailure / BeliefPairingError are pure), so the only thing that catch could ever do
  // is write a SECOND neighbourhood row on top of one bookPairingFailure had already written,
  // inflating `attempted` and breaking exactly-one. If a genuinely-throwing call is ever added
  // below, give it its own typed result — do not re-wrap the block.
  const pairing = await findCandidates(source, cfg, pool);
  const candidates: Candidate[] = pairing.ok ? pairing.candidates : pairing.partial;
  if (!pairing.ok) {
    pairingFailure = pairing.reason;
    await bookPairingFailure(pairing.reason);
  }

  // THE SOURCE'S CLOCK. The chronology gate can only refuse a backwards
  // direction if BOTH endpoints carry a timestamp. The candidate side always gets one from
  // the DB; the source side is whatever the trigger passed — so when it passed none, read it
  // from the SAME column rather than adjudicating a pair we would then have to refuse as
  // `chronology_unknown`. One extra query, only in the case where there would otherwise be no
  // clock at all. A read that BLEW UP is booked: it degrades to the same
  // no-clock value an absent timestamp gives, so without the ledger row "this record has no
  // clock" and "the clock read failed" are one observable and a silently-disabled supersession
  // looks like a healthy refusal.
  let sourceCreatedAt: Date | string | null | undefined = source.createdAt;
  if (sourceCreatedAt === null || sourceCreatedAt === undefined) {
    const clock = await readRecordCreatedAt(source, pool);
    sourceCreatedAt = clock.ok ? clock.createdAt : null;
    // FIRST failure wins — if the candidate query already booked one, this is the same
    // neighbourhood's second symptom, not a second attempt.
    if (!clock.ok && !pairingFailure) {
      pairingFailure = clock.reason;
      await bookPairingFailure(clock.reason);
    }
  }

  const a: AdjudicationRecord = {
    id: source.id,
    type: source.type,
    content: source.content,
    createdAt: sourceCreatedAt,
  };

  const results: PairAdjudicationResult[] = [];
  // SERIAL by construction (concurrency=1). We honour cfg.adjudicatorConcurrency as an
  // explicit contract even though the loop is already serial: >1 would require a bounded
  // pool AND a dedicated box (capacity recon) — deliberately not enabled here.
  const concurrency = Math.max(1, cfg.adjudicatorConcurrency);
  void concurrency;

  for (const cand of candidates) {
    const b: AdjudicationRecord = {
      id: cand.id,
      type: cand.type,
      content: cand.content,
      createdAt: cand.createdAt,
    };
    try {
      const res = await adjudicatePair(
        a,
        b,
        { cosine: cand.cosine, projectId: source.projectId, provider, costCfg: opts?.costCfg },
        pool
      );
      results.push(res);
    } catch (e) {
      const pairLabel = `${source.id.slice(0, 8)}↔${cand.id.slice(0, 8)}`;
      if (e instanceof BeliefSpendCapError) {
        // A cap skip is the guard working, not a malfunction: log it as a SKIP (cap + today's
        // total), never as a failed pair. Its attempt-ledger row is still booked in adjudicatePair.
        logger.info(
          `🧪 belief adjudicator: pair ${pairLabel} skipped — daily spend cap $${e.capUsd.toFixed(2)} ` +
            `reached ($${e.todayUsd.toFixed(4)} spent today, UTC)`
        );
        continue;
      }
      logger.warn(
        `🧪 belief adjudicator: pair ${pairLabel} failed — skipping`,
        { metadata: { error: (e as Error)?.message } }
      );
      // NOTE: the failed-pair ledger row is written INSIDE adjudicatePair, before it rethrows —
      // not here. One writer, so a pair adjudicated by any other caller is counted too.
    }
  }

  // The neighbourhood itself COMPLETED (some pairs inside it may have failed and been skipped —
  // that is the pair-scope rate, which is a different question from "did this record's job run").
  // A neighbourhood whose PAIRING stage failed already wrote its one FAILED row above; writing
  // a second row here would put it in the ledger twice and inflate `attempted`, so exactly one
  // neighbourhood-scope row is written per call, either way.
  if (!pairingFailure) {
    await recordAttemptSafe(
      {
        scope: 'neighbourhood',
        outcome: 'completed',
        projectId: source.projectId,
        sourceId: source.id,
        provider: provider.name,
        model: provider.model,
        durationMs: Date.now() - neighbourhoodStartedAt,
      },
      pool
    );
  }
  return results;
}
