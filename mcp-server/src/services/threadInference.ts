/**
 * WRITE-TIME NO-ORPHAN INFERENCE — Component B of reliable-auto-threading
 * (branch:mandrel-reliability, task ST-4 b5dbcb94, spec
 * docs/specs/reliable-auto-threading.md §B2/B4).
 *
 * THE PROBLEM (measured): 49% of contexts are born orphans because auto-threading only
 * fires when a `thread_set` anchor was remembered. This helper is the fallback that makes
 * a write never a SILENT orphan: when a store has no explicit links and no valid anchor,
 * find the nearest existing NON-ORPHAN context in the same project by embedding cosine
 * similarity and, if it's close enough (≥ INFERENCE_THRESHOLD), mint ONE weak `related_to`
 * edge to it. `related_to` is deliberately NON-EVIDENCE (off the trust walk, ST-1) — a
 * low-confidence association that restores reachability without polluting outcome trust.
 *
 * SCOPE (ST-4): this is the inference HELPER ONLY. Wiring it into the context_store route
 * (the B1 trigger + the A4 gate) is ST-5; the one-time orphan backfill is ST-6. This
 * module exports the pure helper the route + backfill both call — one inference path
 *, no second copy.
 *
 * ST-6 EXTENSION (backfill): the helper takes an optional {@link InferenceOptions} — a
 * per-call `threshold` override (the backfill's `--threshold` flag) and a `dryRun` flag
 * (run the FULL nearest-neighbor evaluation but SKIP the write, so the backfill can PROJECT
 * the rescue without mutating). Both default to the config/live behavior, so the ST-5 route
 * and every existing caller are unchanged. There is still ONE inference query + one mint
 * path — the backfill does not re-implement the neighbor search.
 *
 * REUSE, DON'T REINVENT:
 *   - Similarity is the SAME pgvector cosine expression context_search uses
 *     (handlers/context.ts): `1 - (embedding <=> $vec::vector)`. We do NOT re-embed —
 *     the new row's embedding is already stored, so we fetch and reuse it.
 *   - Minting goes through `mintEdge` (services/links.ts) — the single, idempotent,
 *     self-link-guarded mint path. No new insert code here.
 *
 * ROBUSTNESS CONTRACT (mirrors mintEdge / autoThreadFromActiveAnchor): this NEVER throws.
 * An inference failure must not block or roll back the user's write — on any error we log
 * and return a structured reason. Every tunable comes from reliableThreadingConfig
 * (INFERENCE_THRESHOLD, INFERENCE_CANDIDATE_LIMIT) — no literals here.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { degenerateEmbeddingSql } from './embedding/degenerate.js';
import { logger } from '../utils/logger.js';
import { mintEdge } from './links.js';
import {
  INFERENCE_THRESHOLD,
  INFERENCE_CANDIDATE_LIMIT,
} from '../config/reliableThreadingConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

/**
 * THE edge type inference mints — deliberately the weak, NON-EVIDENCE `related_to` (off
 * the trust walk, ST-1). Named here (the ONE mint site) so the store route's unified edge
 * report labels the inferred edge from the same source it was minted with.
 */
export const INFERENCE_EDGE_TYPE = 'related_to' as const;

/**
 * Why inference did / didn't mint an edge — surfaced by the route (spec B3) + asserted in tests.
 *
 * HONEST MISS REASONS. Three distinct situations used to collapse into the
 * single string `no-neighbor-above-threshold`, which asserts "a neighbour was evaluated and
 * none was close enough". That was FALSE in two of them, measured on a real ci_* DB:
 *
 *   - ZERO CANDIDATES (`!best`): nothing was evaluated at all — the project has no
 *     non-orphan, embedded, unarchived context to attach to. Reporting "no neighbour above
 *     threshold" is a claim about a comparison that never happened. This is exactly why the
 *     `9a8c06c5` RED sat unattributed for a week: a broken candidate query and an honest
 *     below-floor result produced the identical string. → `no-candidates`.
 *
 *   - DEGENERATE SOURCE: the row's own vector is present but zero-norm, so pgvector returns
 *     NaN for every comparison. Measured verdict of the OLD code with a real 0.9-similar
 *     neighbour in the pool: `{reason:'no-neighbor-above-threshold', similarity:null,
 *     candidateId:'e320bbaa…'}` — three lies in one object. It named a "best" candidate that
 *     was never ranked (all distances were NaN, so the row order was arbitrary), it reported
 *     `similarity: null` over the wire (NaN JSON-serialises to null, reading as "no score"),
 *     and it blamed the neighbourhood for a defect in the capture's own vector. The truth is
 *     "this vector cannot be compared to anything". → `source-embedding-degenerate`.
 *
 *   - NON-COMPARABLE SIMILARITY: a similarity came back non-finite anyway. Never silently
 *     re-label that as below-threshold — say we could not measure it. → `similarity-not-comparable`.
 *
 * Consumers switch on this EXHAUSTIVELY with a `never` check (routes/context.routes.ts,
 * services/orphanBackfill.ts), so adding a member here is a COMPILE error until every reader
 * has decided what it means — not a silent fall into someone's `else` branch.
 */
export type InferenceReason =
  | 'minted'
  | 'no-neighbor-above-threshold'
  | 'no-candidates'
  | 'source-has-no-embedding'
  | 'source-embedding-degenerate'
  | 'similarity-not-comparable'
  | 'error';

/** The structured outcome of one inference attempt (never throws; always returns this). */
export interface InferenceResult {
  /** True iff a NEW `related_to` edge was minted (false on dedup, below-threshold, dry-run, or error). */
  minted: boolean;
  /** The neighbor the edge points at (present when a candidate ≥ threshold was found). */
  candidateId?: string;
  /** The best-neighbor cosine similarity considered (present when a candidate was evaluated). */
  similarity?: number;
  /**
   * Whether the chosen candidate ALREADY had an edge at evaluation time. Only meaningful when
   * a candidate was evaluated. Under the write path's default (requireReachableCandidate) this
   * is always true by construction; the Phase 3 backfill lifts that filter, so `false` here
   * means the mint created or extended an ISLAND rather than attaching to the reachable graph.
   * Recorded on the edge so that fact is readable later instead of re-derived.
   */
  candidateWasReachable?: boolean;
  /**
   * Why this outcome — for the surfaced "unthreaded" log (spec B3) and tests.
   * `reason === 'minted'` means a candidate CLEARED the threshold (a `related_to` is warranted);
   * whether a NEW row was written is the separate {@link InferenceResult.minted} flag (false on
   * dedup OR dry-run). So "rescuable" = `reason === 'minted'`; "newly written" = `minted === true`.
   */
  reason: InferenceReason;
}

/**
 * ST-6 per-call knobs for the backfill. Both optional; omitting them reproduces the exact
 * ST-4/ST-5 live behavior (config threshold, real mint) so no existing caller changes.
 */
export interface InferenceOptions {
  /**
   * Override the mint floor for THIS call (the backfill's `--threshold` flag). Defaults to
   * INFERENCE_THRESHOLD from config. Caller is responsible for range-validating an operator
   * override (the backfill CLI does, in [0, 1]).
   */
  threshold?: number;
  /**
   * Dry-run: run the FULL nearest-neighbor evaluation (same query, same threshold) but SKIP
   * the mintEdge write. Used by `--dry-run` to PROJECT the rescue without writing. On a
   * cleared-threshold candidate it returns `reason: 'minted'` (i.e. it WOULD mint) with
   * `minted: false` (nothing was written). Default false.
   */
  dryRun?: boolean;
  /**
   * Lift the write path's "candidate must already have an edge" rule for THIS call — the
   * Phase 3 rich-get-richer fix. Default true = current write-path behaviour,
   * unchanged. See {@link CandidateSqlOptions.requireReachableCandidate} for why the backfill
   * needs it and the write path must keep it.
   */
  requireReachableCandidate?: boolean;
  /**
   * Extra keys merged into the minted edge's `metadata` jsonb, UNDER the two keys this
   * function owns (`source`, `similarity`) — a caller cannot overwrite the measured
   * similarity with a claimed one. The Phase 3 backfill uses this to stamp
   * `provenance:'backfill'` + `method` on every edge it mints, which is the task's rule that
   * a similarity-derived edge must carry its provenance ON THE EDGE.
   */
  extraMetadata?: Record<string, unknown>;
}

/**
 * Candidate-pool shape knobs. See {@link inferenceCandidateSql}.
 */
export interface CandidateSqlOptions {
  /**
   * Require a candidate to ALREADY have an edge (the live write path's rule, default true).
   *
   * THE RICH-GET-RICHER HOLE (Phase 3). On the WRITE path this clause is
   * correct and deliberate: a fresh capture should attach to something already reachable so
   * inference restores reachability instead of pairing two orphans into an island.
   *
   * On a BACKFILL pass it is fatal. The pool is exactly "contexts that already have an edge",
   * so a project whose contexts are ALL orphans has an empty pool for every one of them and
   * can never self-heal — the state stays stable at 100% orphaned no matter how many times
   * the backfill runs. Measured on the 2026-08-13 prod snapshot: `the-forge` has 1,425
   * contexts and 1,425 orphans, i.e. ZERO reachable candidates, so every orphan there returns
   * `no-candidates` under the write-path rule. That single project is 20% of the whole orphan
   * population.
   *
   * So the backfill passes `false`, and the write path is left EXACTLY as it was — this is a
   * new option with a default that reproduces current behaviour byte-for-byte, not a change
   * to what a live store does.
   */
  requireReachableCandidate?: boolean;
}

/**
 * THE candidate-pool statement, as ONE exported string.
 *
 * Exported so the regression guard EXPLAINs the statement the product actually runs rather
 * than a hand-copied lookalike — a second copy of this SQL in a test could be fenced while
 * the shipped one silently is not, which is the exact shape of defect this guards.
 * Params: $1 source vector, $2 source id, $3 project id, $4 candidate limit.
 *
 * See the long note at the call site for WHY the ORDER BY is fenced from the ivfflat index.
 * BOTH shapes this function can emit are fenced the same way, and the regression guard
 * EXPLAINs both — dropping the reachability filter must not make the statement eligible for
 * the approximate index either.
 *
 * `reachable` is computed in the OUTER select, over the already-limited `best` rows, so it
 * costs one index probe per returned candidate rather than one per row scanned. It is
 * recorded on backfill-minted edges: attaching to an unreachable neighbour is a legitimate
 * outcome of the pass but it builds an island, and that is a fact the edge should carry
 * rather than one a reader has to re-derive.
 */
export function inferenceCandidateSql(
  column: string = activeEmbeddingColumn(),
  opts: CandidateSqlOptions = {}
): string {
  const requireReachable = opts.requireReachableCandidate ?? true;
  const reachabilityFilter = requireReachable
    ? `AND EXISTS (
                     SELECT 1 FROM links l
                      WHERE l.from_id = contexts.id OR l.to_id = contexts.id
                   )`
    : '';
  return `WITH candidates AS MATERIALIZED (
            SELECT id, (${column} <=> $1::vector) AS distance
              FROM contexts
             WHERE id <> $2
               AND project_id = $3
               AND ${column} IS NOT NULL
               AND archived_at IS NULL
               ${reachabilityFilter}
          ),
          best AS (
            SELECT id, distance
              FROM candidates
             -- 'id ASC' makes this LIMIT a TOTAL order: two candidates at the
             -- SAME distance (identical embeddings are not exotic here — a re-stored record,
             -- a duplicated capture) otherwise make WHICH neighbour gets the inferred edge
             -- depend on physical row order, so the same write threads differently on a
             -- replay. It does not touch the fence: the CTE below is MATERIALIZED and carries
             -- no ORDER BY, so the ivfflat index stays structurally out of the path either
             -- way; and it does not touch the NaN-sorts-LAST argument, which is a property of
             -- the FIRST key.
             ORDER BY distance ASC, id ASC
             LIMIT $4
          )
          SELECT b.id,
                 1 - b.distance AS similarity,
                 EXISTS (
                   SELECT 1 FROM links l
                    WHERE l.from_id = b.id OR l.to_id = b.id
                 ) AS reachable
            FROM best b
           ORDER BY b.distance ASC, b.id ASC`;
}

/**
 * Infer and mint ONE `related_to` edge for a freshly-stored context, so the write is not a
 * silent orphan (spec B2). Reuses the row's ALREADY-STORED embedding — never re-embeds.
 *
 * The candidate pool (the ONE pgvector similarity query) is, in the SAME project:
 *   - not the source row itself (id != fromId — never a self-edge),
 *   - has a non-null embedding and is not archived (archived_at IS NULL),
 *   - is a NON-ORPHAN: EXISTS an edge in `links` where it is either endpoint. We only
 *     attach to a context that is already reachable, so inference restores reachability
 *     rather than pairing two orphans into an island.
 * ordered by cosine distance ascending (nearest first), limited to INFERENCE_CANDIDATE_LIMIT.
 * If the best candidate's similarity ≥ INFERENCE_THRESHOLD, mint the edge via mintEdge
 * (idempotent — a re-run dedups to created:false and returns minted:false).
 *
 * @returns a structured {@link InferenceResult}. NEVER throws.
 */
export async function inferAndMintRelatedTo(
  args: { fromId: string; projectId: string | null | undefined; createdBy: string },
  pool: Pool = db,
  opts: InferenceOptions = {}
): Promise<InferenceResult> {
  // Per-call floor (ST-6 --threshold), defaulting to the configured live threshold.
  const threshold = opts.threshold ?? INFERENCE_THRESHOLD;
  try {
    // 1. Reuse the new row's ALREADY-STORED embedding (do NOT re-embed). Fetch it as text
    //    (pgvector's `[...]` literal) so we can bind it back as a $::vector param below.
    const srcRes = await pool.query(
      `SELECT ${activeEmbeddingColumn()}::text AS embedding,
              ${degenerateEmbeddingSql(activeEmbeddingColumn())} AS degenerate
         FROM contexts WHERE id = $1`,
      [args.fromId]
    );
    const srcEmbedding: string | null = srcRes.rows[0]?.embedding ?? null;
    if (!srcEmbedding) {
      // No embedding to compare with (embedding disabled / not yet generated) → cannot
      // infer. Not an error: surface the reason so the route logs an honest "unthreaded".
      return { minted: false, reason: 'source-has-no-embedding' };
    }

    // DEGENERATE SOURCE — present but zero-norm, so every cosine against it is NaN. Detected
    // BEFORE the candidate query, because running it would produce an arbitrary "best" row at
    // NaN similarity and the old code reported that as an honest below-threshold miss.
    // FAIL LOUD: this is a broken row that silently drops out of semantic recall and used to
    // be un-re-embeddable ("looks embedded forever" — WHERE col IS NULL never saw it). The
    // needs-reembed gate now selects it (services/reembedBackfill.needsReembedSql), so this
    // is a self-healing condition — but a swallowed failure of the no-orphan guarantee must
    // be announced at error level, not left as a buried warn.
    if (srcRes.rows[0]?.degenerate === true) {
      logger.error(
        `🧵 inference: context ${args.fromId} has a DEGENERATE (zero-norm) ${activeEmbeddingColumn()} — ` +
          'it cannot be compared to ANY vector and is invisible to semantic recall. No inference ' +
          'is possible; the capture stays unthreaded until the re-embed self-heal worker replaces ' +
          'the vector. This is NOT a below-threshold miss.',
        undefined,
        { metadata: { contextId: args.fromId, column: activeEmbeddingColumn(), projectId: args.projectId ?? null } }
      );
      return { minted: false, reason: 'source-embedding-degenerate' };
    }

    // 2. ONE pgvector query — nearest NON-ORPHAN context in the same project. Similarity is
    //    the SAME cosine expression context_search uses. All values bound as parameters.
    //
    // THE ORDER BY IS DELIBERATELY FENCED FROM THE ivfflat INDEX. Written as
    // the plain `ORDER BY <col> <=> $1 ASC LIMIT n`, this statement is eligible for the
    // APPROXIMATE index `contexts_embedding_1536_idx` — and pgvector's ivfflat scan returns
    // ONLY the rows in the `ivfflat.probes` lists it visits. Measured on a migrated ci_* DB
    // with 602 embedded rows (the index is built at migrate time on an EMPTY table, so its
    // centroids carry no signal and rows scatter across all 100 lists):
    //
    //     probes=1   -> 1 of 602 rows returned
    //     probes=10  -> 116 of 602
    //     probes=100 -> 602 of 602
    //
    // and the shipped query, with a single genuinely-qualifying candidate present, returned
    // ZERO rows under both probes=1 and probes=10 while an exact scan returned it. Whether
    // the planner picks that index depends on table statistics — i.e. on whether autoanalyze
    // happened to have run — so the SAME code on the SAME data answered "no candidates" on
    // some runs and found the neighbour on others, with no concurrency involved.
    //
    // That is not a recall trade-off, it is a FABRICATED VERDICT. This query does not ask
    // "give me a good top-K", it asks "does ANY attachable neighbour exist" — and `!best`
    // below is read as a definitive NO that ends the no-orphan guarantee for that capture.
    // An approximate index cannot answer an existence question; "the probed lists were empty"
    // and "the project has nothing to attach to" are different facts and must not share a
    // return value (C1: an instrument has three states).
    //
    // THE FENCE: `AS MATERIALIZED` is a documented optimization barrier (PG12+). The CTE
    // carries no ORDER BY, so the vector index cannot be chosen inside it; the outer ORDER BY
    // is over a computed column of a materialized result, so it cannot be pushed down. The
    // filtered set is then scanned EXACTLY. Verified by plan: the CTE resolves through
    // idx_contexts_live (project_id) + idx_links_from/to, then a Sort — the ivfflat index is
    // structurally out of the path, not merely unchosen.
    //
    // ORDERING SEMANTICS ARE UNCHANGED — deliberately still ASC on the DISTANCE, not DESC on
    // the similarity. Postgres sorts NaN LAST in an ASC float order, which is exactly what the
    // `similarity-not-comparable` branch below relies on when it argues that a non-finite top
    // row means EVERY candidate scored non-finite. `ORDER BY similarity DESC` would sort NaN
    // FIRST and silently invert that argument.
    //
    // COST: this evaluates the distance for every attachable context in ONE project instead of
    // for the probed lists. That is the correct trade for an existence check, and the pool is
    // already narrowed by project + must-have-an-edge before any distance is computed.
    const candRes = await pool.query(
      inferenceCandidateSql(activeEmbeddingColumn(), {
        requireReachableCandidate: opts.requireReachableCandidate ?? true,
      }),
      [srcEmbedding, args.fromId, args.projectId ?? null, INFERENCE_CANDIDATE_LIMIT]
    );

    const best = candRes.rows[0];
    if (!best) {
      // ZERO CANDIDATES — the query returned no rows, so NOTHING was compared. This is its
      // OWN reason: reporting it as 'no-neighbor-above-threshold' asserted a
      // comparison that never happened and made a broken candidate query indistinguishable
      // from an honest below-floor result, which is precisely why the 9a8c06c5 RED went
      // unattributed for a week.
      return { minted: false, reason: 'no-candidates' };
    }

    const similarity = Number(best.similarity);
    if (!Number.isFinite(similarity)) {
      // The comparison produced no usable number (pgvector yields NaN whenever either side is
      // zero-norm). The degenerate-SOURCE case is caught above, so reaching here means a
      // CANDIDATE row is degenerate — or the expression changed under us. Either way we do not
      // know how similar these are, and `!(NaN >= threshold)` would quietly file that under
      // "no neighbour was close enough". Report what is true — we could not measure it — and
      // say so at error level, never a buried log line.
      //
      // NEITHER `similarity` NOR `candidateId` IS RETURNED. `similarity` because NaN serialises
      // to null over the wire and would read as an ordinary absent score. `candidateId` because
      // Postgres sorts NaN LAST in an ASC order, so reaching this branch means the TOP row
      // scored non-finite — i.e. EVERY candidate did, and `best.id` is an arbitrary pick among
      // rows that were never ranked. Returning it would be the exact shape of the lie this task
      // set out to kill: naming a "best" candidate that no comparison ever chose. The id is
      // still LOGGED (an operator debugging a broken row wants a handle on one of them) — it is
      // just not presented to the caller as a result.
      logger.error(
        `🧵 inference: NON-FINITE similarity (${String(best.similarity)}) comparing context ` +
          `${args.fromId} to candidate ${best.id}. The comparison could NOT be made — this is ` +
          'NOT a below-threshold miss, and because NaN sorts last this means EVERY candidate ' +
          'scored non-finite, so this candidate id is an arbitrary sample, not a ranking. A ' +
          'candidate vector is degenerate (zero-norm); the re-embed self-heal gate selects such rows.',
        undefined,
        { metadata: { contextId: args.fromId, sampledCandidateId: best.id, column: activeEmbeddingColumn() } }
      );
      return { minted: false, reason: 'similarity-not-comparable' };
    }
    // Whether the chosen neighbour already had an edge. Under the write-path default this is
    // always true (the pool filtered on it); the backfill lifts that filter, so this is the
    // honest record of whether the mint joined the reachable graph or built an island.
    const candidateWasReachable: boolean = best.reachable === true;

    if (!(similarity >= threshold)) {
      // Below the (config or overridden) floor — do NOT mint (spec B2). Surface the best score seen.
      return {
        minted: false,
        candidateId: best.id,
        similarity,
        candidateWasReachable,
        reason: 'no-neighbor-above-threshold',
      };
    }

    if (opts.dryRun) {
      // PROJECTION only (backfill --dry-run): the candidate clears the floor so a related_to
      // WOULD be minted — report reason:'minted' (rescuable) but write NOTHING (minted:false).
      return { minted: false, candidateId: best.id, similarity, candidateWasReachable, reason: 'minted' };
    }

    // 3. Mint ONE weak related_to edge via the single mint path (idempotent, self-link-guarded).
    //
    // METADATA PRECEDENCE IS DELIBERATE: the caller's extraMetadata is spread FIRST, so the
    // things this function MEASURED (`similarity` and the reachability fact) always win. A
    // caller stamping `provenance:'backfill'` can add to the record but cannot overwrite the
    // measured score with a claimed one — a provenance label that could be contradicted by
    // its own edge would defeat the point of recording it.
    //
    // The mint-path label is no longer in this object at all (SK4): `source`
    // was one of four competing metadata keys for that one fact, and it is now the `via`
    // argument below → the NOT NULL links.mint_via column. It is therefore not spreadable and
    // a caller cannot override it, which is a stronger version of the same precedence rule.
    const mint = await mintEdge(
      {
        fromId: args.fromId,
        fromType: 'context',
        toId: best.id,
        toType: 'context',
        edgeType: INFERENCE_EDGE_TYPE,
        projectId: args.projectId ?? null,
        createdBy: args.createdBy,
        via: EDGE_MINT_VIA.inference,
        metadata: {
          ...(opts.extraMetadata ?? {}),
          similarity,
          candidateWasReachable,
        },
      },
      pool
    );

    return { minted: mint.created, candidateId: best.id, similarity, candidateWasReachable, reason: 'minted' };
  } catch (e) {
    // ROBUSTNESS: an inference failure must NEVER block the store. Log + return a reason.
    logger.warn(
      `🧵 inference: failed to infer/mint related_to for context ${args.fromId} — write unaffected`,
      { metadata: { error: (e as Error)?.message } }
    );
    return { minted: false, reason: 'error' };
  }
}
