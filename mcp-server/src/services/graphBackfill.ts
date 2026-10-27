/**
 * SCHEDULED GRAPH BACKFILL — the ONE idempotent job (PHASE 3).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * The graph audit found four separate backfill scripts, none of which was
 * wired to a cron, a timer, or any entrypoint. They were commands nobody ran, so the pre-June
 * orphan backlog never shrank. Measured on the 2026-08-13 prod snapshot: 7,025 of 10,042
 * active contexts (70.0%) have no edge on either endpoint.
 *
 * THE FAILURE TO AVOID IS NOT "the backfill is wrong" — it is "we shipped a fifth command
 * nobody runs". Hence the systemd timer in infra/systemd/ is part of this deliverable and the
 * acceptance criterion asserts the timer has actually FIRED, from the scheduler's own state.
 *
 * ── THE TWO PROVENANCE CLASSES, WHICH MUST NEVER BLUR ──────────────────────────────────
 * This is the heart of the task. A backfill that let a guess count as graph health would
 * defeat the Phase 0 meter built specifically to detect that.
 *
 *   GUESSED leg (runs on the schedule, unattended)
 *     Similarity-derived edges for true orphans. `related_to` ONLY — never a trust-bearing
 *     type — stamped `created_by='backfill:orphan-threads'`, which migration 079's
 *     `link_provenance` view classifies GUESSED via its `backfill:%` arm. Each edge carries
 *     `metadata.provenance='backfill'`, `metadata.method`, `metadata.similarity` and
 *     `metadata.candidateWasReachable`. NEVER promoted automatically; a later naming write may
 *     promote per an earlier decision's promotion rule, never silently.
 *
 *   DECLARED leg (OPT-IN ONLY — see the CN2 note below)
 *     The already-built, dry-run-validated task-edge backfill (services/taskEdgeBackfill.ts),
 *     which derives edges from EXISTING threading tags and the explicit `dependencies` field.
 *     The target was named by a human at origin; the backfill only materialises it late. That
 *     is genuine declared provenance, and its stamps (`backfill:task_tags` /
 *     `backfill:task_deps`) are named explicitly in 079's DECLARED arm.
 *
 * ── THE CN2 GATE IS ENCODED, NOT DOCUMENTED ────────────────────────────────────────────
 * The declared leg's prod run is CN2-gated: the operator approves before it mutates prod. A rule in
 * prose is the weak version, so the rule is the DEFAULT here — `runGraphBackfill` skips the
 * declared leg unless `includeDeclared: true` is passed, and the shipped systemd unit does not
 * pass it. An unattended timer run therefore CANNOT execute the declared leg, whatever anyone
 * remembers. The declared leg also shifts trust scores on existing tasks (backfilled
 * `decided_by` edges enter the trust walk — see taskEdgeBackfill's header), which is the
 * substantive reason it is gated and the guessed leg is not: `related_to` is trust-inert.
 *
 * ── REPAIR, NOT ONLY FILL ──────────────────────────────────────────────────────────────
 * The job is "make historical guesses honest", not merely "fill in the missing ones". The
 * repair leg measures pre-existing guessed edges against the CURRENT geometry and either
 * re-labels them with their measured score or re-points them at a materially better neighbour.
 * It NEVER rewrites `created_by` — doing so would move an edge between meter buckets, which is
 * precisely the masquerade this whole workstream exists to prevent.
 *
 * ── REUSE, DON'T REINVENT ─────────────────────────────────────────────────
 * There is no second nearest-neighbour query and no second minter in this file. The guessed
 * leg drives `inferAndMintRelatedTo` (the same helper the live context_store path uses) and
 * the declared leg drives `runTaskEdgeBackfill` (which itself drives the write-path minters).
 * This module ENUMERATES and ORCHESTRATES; it does not re-implement.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { degenerateEmbeddingSql } from './embedding/degenerate.js';
import { inferAndMintRelatedTo, inferenceCandidateSql, INFERENCE_EDGE_TYPE } from './threadInference.js';
import { CREATED_BY as GUESSED_CREATED_BY } from './orphanBackfill.js';
import { runTaskEdgeBackfill, type BackfillSummary as DeclaredSummary } from './taskEdgeBackfill.js';
import {
  EDGE_PROVENANCE,
  GUESS_METHOD,
  GUESS_THRESHOLD,
  MAX_ORPHANS_PER_RUN,
  MAX_REPAIRS_PER_RUN,
  REPAIRABLE_CREATED_BY,
  REPAIR_ENABLED,
  REPAIR_IMPROVEMENT_MARGIN,
  REPAIR_MIN_SIMILARITY,
} from '../config/graphBackfillConfig.js';

// ── Result shapes ──────────────────────────────────────────────────────────────────────

/** Per-cause tally of orphans the guessed leg could not connect. Keys are InferenceReason. */
export interface GuessedSkips {
  noNeighborAboveThreshold: number;
  noCandidates: number;
  noEmbedding: number;
  degenerateEmbedding: number;
  notComparable: number;
  errors: number;
}

export interface GuessedLegSummary {
  /** Orphans across ALL projects before this leg ran (the global number). */
  orphansBefore: number;
  /** Orphans this run actually processed (>= cap truncates; see `orphansRemainingUnprocessed`). */
  orphansProcessed: number;
  /** Orphans left unexamined because MAX_ORPHANS_PER_RUN truncated the batch. */
  orphansRemainingUnprocessed: number;
  /** Orphans whose nearest neighbour cleared the floor (would-mint in dry-run). */
  rescuable: number;
  /** NEW edges actually written (always 0 in dry-run). */
  minted: number;
  /**
   * Of `rescuable`, how many attached to a neighbour that had NO edge itself (island-building).
   *
   * THIS NUMBER IS LEGITIMATELY MUCH HIGHER IN A DRY RUN THAN IN THE APPLY THAT FOLLOWS IT,
   * and the difference is not an error in either. A dry run writes nothing, so no orphan ever
   * becomes reachable during the pass and every candidate is still unreachable when the next
   * one is evaluated. An apply heals progressively: once A→B is minted, B is reachable for
   * every orphan considered after it. Measured on the same 2026-08-13 prod snapshot,
   * same 7,025 orphans: dry run reported 6,876, the apply produced 2,706.
   *
   * So read the dry-run figure as the PESSIMISTIC UPPER BOUND on island-building, not as a
   * forecast. Left un-noted, an operator comparing the two reports would reasonably conclude
   * one of them is lying.
   */
  attachedToUnreachable: number;
  /** Orphans not connected, by cause — exhaustive, no catch-all bucket. */
  skips: GuessedSkips;
  /** Orphans across ALL projects after (re-queried in apply mode; projected in dry-run). */
  orphansAfter: number;
}

export interface RepairLegSummary {
  /** Pre-existing guessed edges examined. */
  examined: number;
  /** Edges whose metadata was brought up to the honest shape (score + provenance recorded). */
  relabeled: number;
  /** Edges re-pointed at a materially better neighbour. */
  repointed: number;
  /** Edges whose current similarity could not be measured (missing/degenerate vector on either end). */
  notComparable: number;
  /** Edges left unexamined because MAX_REPAIRS_PER_RUN truncated the batch. */
  remainingUnprocessed: number;
}

export interface GraphBackfillSummary {
  dryRun: boolean;
  /** True only when the caller explicitly opted the CN2-gated declared leg in. */
  includedDeclared: boolean;
  guessThreshold: number;
  guessed: GuessedLegSummary;
  /** null whenever the declared leg did not run (the default, and every timer run). */
  declared: DeclaredSummary | null;
  repair: RepairLegSummary;
  /** Global orphan count before/after the WHOLE job. */
  orphansBefore: number;
  orphansAfter: number;
  durationMs: number;
}

// ── The orphan definition, in ONE place ────────────────────────────────────────────────

/**
 * THE orphan predicate, as a SQL fragment over an aliased `contexts c`. Every count and every
 * enumeration in this file is built from this one string, so the number the report prints and
 * the set the job processes cannot disagree — the "before/after with their query" acceptance
 * criterion is measuring the same population the work ran over, by construction.
 *
 * It is the same predicate orphanBackfill.findOrphanIds uses: an active context with no row in
 * `links` referencing it on EITHER endpoint.
 */
export const ORPHAN_PREDICATE_SQL =
  `c.archived_at IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM links l WHERE l.from_id = c.id OR l.to_id = c.id
         )`;

/**
 * The full, pasteable global orphan-count query — exported so the report and the proof match.
 *
 * SOFT-DELETE-VIA: ORPHAN_PREDICATE_SQL — the archived_at IS NULL filter is the first line of
 * that shared predicate, which exists precisely so the count, the enumeration and the report
 * cannot describe different populations. This query is FILTERED, not exempt.
 */
export const ORPHAN_COUNT_SQL =
  `SELECT count(*)::int AS orphans FROM contexts c WHERE ${ORPHAN_PREDICATE_SQL}`;

/** Global orphan count across every project. */
export async function countOrphans(pool: Pool = db): Promise<number> {
  const r = await pool.query(ORPHAN_COUNT_SQL);
  return r.rows[0].orphans as number;
}

/**
 * Enumerate orphans across ALL projects, oldest first, optionally capped.
 *
 * ACROSS ALL PROJECTS IS THE POINT. The pre-existing orphan backfill is scoped to ONE project
 * via a required `--project` flag, so running it as a scheduled job would mean an operator
 * remembering to pass each of the 103 project names — which is the same "command nobody runs"
 * shape one level down. A scheduled job takes no arguments.
 */
async function findOrphans(
  pool: Pool,
  limit: number
): Promise<Array<{ id: string; projectId: string | null }>> {
  const cap = limit > 0 ? ` LIMIT ${Number(limit)}` : '';
  const r = await pool.query(
    `SELECT c.id::text AS id, c.project_id::text AS project_id
       FROM contexts c
      WHERE ${ORPHAN_PREDICATE_SQL}
      ORDER BY c.created_at ASC, c.id ASC${cap}`
  );
  return r.rows.map((row: { id: string; project_id: string | null }) => ({
    id: row.id,
    projectId: row.project_id,
  }));
}

// ── LEG 1: GUESSED ─────────────────────────────────────────────────────────────────────

/**
 * The similarity-derived leg. For each orphan, drive the SHARED inference helper with the
 * rich-get-richer constraint LIFTED, minting at most one weak `related_to` per orphan.
 *
 * WHY LIFTING THE CONSTRAINT IS REQUIRED AND NOT AN OPTIMISATION: the write path restricts
 * candidates to contexts that already have an edge. A project whose contexts are ALL orphans
 * therefore has an empty candidate pool for every one of them, and no number of runs can
 * change that — the state is a fixed point. `the-forge` on the prod snapshot is exactly this:
 * 1,425 contexts, 1,425 orphans, zero reachable candidates, 20% of the entire backlog.
 *
 * The cost of lifting it is honest and recorded rather than hidden: an orphan may attach to
 * another orphan, forming an ISLAND rather than joining the reachable graph. Each such edge
 * carries `metadata.candidateWasReachable=false` and the run reports the count, because the
 * alternative — silently leaving a fifth of the corpus permanently unreachable — is worse.
 * Note also that islands dissolve as the pass proceeds: once A→B is minted, B is reachable for
 * every orphan considered after it, and the enumeration is oldest-first and deterministic.
 */
export async function runGuessedLeg(
  opts: { dryRun: boolean; threshold: number; maxOrphans: number },
  pool: Pool = db
): Promise<GuessedLegSummary> {
  const orphansBefore = await countOrphans(pool);
  const batch = await findOrphans(pool, opts.maxOrphans);

  let rescuable = 0;
  let minted = 0;
  let attachedToUnreachable = 0;
  const skips: GuessedSkips = {
    noNeighborAboveThreshold: 0,
    noCandidates: 0,
    noEmbedding: 0,
    degenerateEmbedding: 0,
    notComparable: 0,
    errors: 0,
  };

  for (const orphan of batch) {
    const res = await inferAndMintRelatedTo(
      { fromId: orphan.id, projectId: orphan.projectId, createdBy: GUESSED_CREATED_BY },
      pool,
      {
        threshold: opts.threshold,
        dryRun: opts.dryRun,
        // THE RICH-GET-RICHER FIX. See the doc comment above.
        requireReachableCandidate: false,
        // THE PROVENANCE STAMP, ON THE EDGE. `similarity` and `candidateWasReachable` are
        // added by the helper itself from what it MEASURED and cannot be overridden here.
        extraMetadata: { provenance: EDGE_PROVENANCE.backfill, method: GUESS_METHOD },
      }
    );

    if (res.reason === 'minted') {
      rescuable++;
      if (res.minted) minted++;
      if (res.candidateWasReachable === false) attachedToUnreachable++;
      continue;
    }

    // EXHAUSTIVE, NO CATCH-ALL (the discipline orphanBackfill adopted in an earlier task): an
    // unhandled reason must be a COMPILE error, never a wrong number in an operator's report.
    switch (res.reason) {
      case 'no-neighbor-above-threshold': skips.noNeighborAboveThreshold++; break;
      case 'no-candidates': skips.noCandidates++; break;
      case 'source-has-no-embedding': skips.noEmbedding++; break;
      case 'source-embedding-degenerate': skips.degenerateEmbedding++; break;
      case 'similarity-not-comparable': skips.notComparable++; break;
      case 'error': skips.errors++; break;
      default: {
        const unhandled: never = res.reason;
        throw new Error(`graphBackfill: unhandled InferenceReason ${String(unhandled)}`);
      }
    }
  }

  // Dry-run projects (nothing was written); apply RE-QUERIES the truth, which doubles as a
  // built-in cross-check that the mints landed.
  const orphansAfter = opts.dryRun ? orphansBefore - rescuable : await countOrphans(pool);

  return {
    orphansBefore,
    orphansProcessed: batch.length,
    orphansRemainingUnprocessed: Math.max(0, orphansBefore - batch.length),
    rescuable,
    minted,
    attachedToUnreachable,
    skips,
    orphansAfter,
  };
}

// ── LEG 3: REPAIR ──────────────────────────────────────────────────────────────────────

/** One repairable edge plus the measurement of its own target. */
interface RepairRow {
  id: string;
  fromId: string;
  toId: string;
  projectId: string | null;
  metadata: Record<string, unknown> | null;
  /** Current cosine from → to. null when either side has no usable vector. */
  currentSimilarity: number | null;
}

/**
 * THE REPAIR POPULATION, AS ONE SQL FRAGMENT — the fix for the starvation defect
 * (Reviewer REJECT round 1, T1-1).
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────────────────────
 * The population used to be "every guessed-family edge", and the per-run cap took the first
 * N of it by `created_at`. That works for the GUESSED leg because a rescued orphan stops
 * satisfying the orphan predicate — the population itself shrinks. The repair population did
 * not shrink, so the cap was never a batching window; it was a permanent ceiling on the same
 * frozen N rows. Measured on the prod snapshot, three consecutive capped `--apply` runs:
 *
 *     RUN 1  examined 2000, unchanged 2000, remaining 6739
 *     RUN 2  examined 2000, unchanged 2000, remaining 6739
 *     RUN 3  examined 2000, unchanged 2000, remaining 6739
 *
 * 6,739 of 8,739 repairable edges — 77% — could never be examined by any number of scheduled
 * runs, while the report cheerfully printed "left for next run: 6739" about a next run that
 * could not come. That is the SAME lie `countRepairable` was fixed for one layer up; fixing
 * the count left the starvation that produces it.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────────────
 * Make the population "edges that STILL NEED repair", so doing the work removes the row from
 * it exactly as rescuing an orphan does. Successive capped runs then strictly reduce the
 * remaining count to zero, and a converged run examines nothing.
 *
 * ── WHY THIS LIVES IN SQL AND NOT IN TYPESCRIPT ──────────────────────────────────────
 * There used to be an `isHonestlyLabeled()` helper in this file deciding, per row, whether an
 * edge needed re-labelling. Expressing the population in SQL *and* keeping that helper would
 * be two copies of one rule, free to drift — the failure a past incident and C5 name, and the one
 * that makes a filtered-out row and a skipped row disagree. So the helper is DELETED and the
 * rule lives here only; the query returns `needs_relabel` and the loop reads that boolean
 * back, the same way provenanceMeter reads `provenance_class` back from the 079 view rather
 * than re-spelling the classification.
 *
 * ── THE THREE STATES (C1) ────────────────────────────────────────────────────────────
 * `current_similarity` is NULL when either endpoint has no vector or a degenerate (zero-norm)
 * one. An edge we CANNOT MEASURE is not an edge we have judged. Such a row is not silently
 * dropped (it would be re-fetched forever, starving the cap all over again) and not treated
 * as a bad edge either — it is marked `repairUnmeasurable` and leaves the population until
 * the re-embed self-heal worker gives it a usable vector, at which point it re-qualifies.
 */
const REPAIR_POPULATION_SQL = (col: string): string => `
  FROM links l
  JOIN contexts cf ON cf.id = l.from_id
  JOIN contexts ct ON ct.id = l.to_id
 WHERE l.edge_type = $1
   AND l.created_by = ANY($2)
   -- SOFT-DELETE, HONOURED ON BOTH ENDPOINTS — and it must be, because the OTHER leg of
   -- this same job already does. ORPHAN_PREDICATE_SQL carries \`c.archived_at IS NULL\`, so
   -- without this line one leg of one job respected a user's deletion and the other
   -- re-labeled and re-pointed edges into records the user had deleted.
   --
   -- MEASURED at 67e6f00 on the prod snapshot: 19 archived contexts, and ZERO edges in this
   -- population touching one. That zero is the reason to fix it now rather than a reason not
   -- to: the defect is currently unexercised, so nothing would have surfaced it, and the
   -- archived population only grows. A guard written against today's corpus would pass
   -- whether or not this line exists — which is why the contract test CONSTRUCTS an archived
   -- endpoint instead of looking for one.
   AND cf.archived_at IS NULL
   AND ct.archived_at IS NULL
   AND CASE
         -- UNMEASURABLE: in the population only until we have recorded that we looked.
         WHEN cf.${col} IS NULL OR ct.${col} IS NULL
           OR ${degenerateEmbeddingSql(`cf.${col}`)} OR ${degenerateEmbeddingSql(`ct.${col}`)}
           THEN l.metadata->>'repairUnmeasurable' IS NULL
         -- MEASURABLE: in the population until the edge carries an honest label whose
         -- recorded similarity matches what it actually measures now. The epsilon (not
         -- equality) is deliberate: the value round-trips through jsonb as a double, and an
         -- exactness test would re-qualify the same rows on every run forever.
         ELSE NOT (
                l.metadata->>'provenance' IN ('${EDGE_PROVENANCE.guess}', '${EDGE_PROVENANCE.backfill}')
            AND l.metadata->>'method' IS NOT NULL
            AND l.metadata->>'similarity' IS NOT NULL
            AND abs((l.metadata->>'similarity')::numeric
                    - (1 - (cf.${col} <=> ct.${col}))::numeric) < 1e-6
              )
       END`;

/**
 * Fetch the next batch of edges that still need repair, together with the CURRENT cosine
 * between their endpoints. Shares {@link REPAIR_POPULATION_SQL} with {@link countRepairable}
 * so the batch and the number reported about it cannot describe different sets.
 */
async function fetchRepairRows(pool: Pool, limit: number): Promise<RepairRow[]> {
  const col = activeEmbeddingColumn();
  const cap = limit > 0 ? ` LIMIT ${Number(limit)}` : '';
  const r = await pool.query(
    `SELECT l.id::text            AS id,
            l.from_id::text       AS from_id,
            l.to_id::text         AS to_id,
            l.project_id::text    AS project_id,
            l.metadata            AS metadata,
            CASE
              WHEN cf.${col} IS NULL OR ct.${col} IS NULL THEN NULL
              WHEN ${degenerateEmbeddingSql(`cf.${col}`)} OR ${degenerateEmbeddingSql(`ct.${col}`)} THEN NULL
              ELSE 1 - (cf.${col} <=> ct.${col})
            END AS current_similarity
       ${REPAIR_POPULATION_SQL(col)}
      ORDER BY l.created_at ASC, l.id ASC${cap}`,
    [INFERENCE_EDGE_TYPE, REPAIRABLE_CREATED_BY]
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    fromId: row.from_id as string,
    toId: row.to_id as string,
    projectId: (row.project_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    currentSimilarity:
      row.current_similarity === null || row.current_similarity === undefined
        ? null
        : Number(row.current_similarity),
  }));
}

/**
 * How many edges STILL NEED repair — the denominator behind `remainingUnprocessed`, and the
 * number whose strict decrease across runs is the proof that the cap batches rather than
 * starves. Built from the SAME fragment the batch is, so a count that says "come back for
 * these" is now a claim about rows a next run will genuinely take.
 */
// SOFT-DELETE-VIA: REPAIR_POPULATION_SQL — the archived_at IS NULL predicate on BOTH
// endpoints is carried by that shared fragment, which is deliberately the ONE spelling of
// this population so the count and the batch cannot diverge. This query is FILTERED, not
// exempt; the sweep simply cannot see through the interpolation to say so.
async function countRepairable(pool: Pool): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n ${REPAIR_POPULATION_SQL(activeEmbeddingColumn())}`,
    [INFERENCE_EDGE_TYPE, REPAIRABLE_CREATED_BY]
  );
  return r.rows[0].n as number;
}

/**
 * The repair leg: make historical guesses honest.
 *
 * TWO ACTIONS, in priority order per edge:
 *
 *   RE-POINT — the edge's own target scores below REPAIR_MIN_SIMILARITY (by our CURRENT
 *   standard we would not mint it today) AND a different candidate scores at least
 *   REPAIR_IMPROVEMENT_MARGIN better. The edge's `to_id` moves to that candidate and the
 *   metadata records where it came from. This is the "points at the WRONG neighbour" case the
 *   task names.
 *
 *   RE-LABEL — otherwise, if the edge does not already carry an honest label, write its
 *   MEASURED similarity, `provenance:'guess'` and the method onto it. The edge is unchanged
 *   structurally; it stops lying by omission about being an unmeasured guess.
 *
 * `created_by` IS NEVER TOUCHED BY EITHER ACTION. An `auto:inference` edge stays
 * `auto:inference` and stays in the meter's GUESSED bucket exactly where it was. Re-stamping
 * it `backfill:*` would claim this job minted an edge it merely inspected, and — because the
 * meter classifies on `created_by` — would let a repair pass move numbers between buckets.
 *
 * IDEMPOTENCE AND PROGRESS ARE THE SAME PROPERTY HERE, and that is the point of the
 * REPAIR_POPULATION_SQL design: every one of the three outcomes below WRITES something that
 * removes the row from the population. Re-labelling satisfies the honest-label arm;
 * re-pointing writes an honest label at the new target (and moves the edge to the current
 * nearest neighbour, so nothing beats it by the margin next time); an unmeasurable edge is
 * marked so it stops being re-fetched. So a converged run examines ZERO rows rather than
 * re-examining everything and reporting "unchanged", and — the part that was broken — a
 * CAPPED run makes strict progress instead of re-reading the same frozen batch forever.
 */
export async function runRepairLeg(
  opts: {
    dryRun: boolean;
    minSimilarity: number;
    improvementMargin: number;
    maxRepairs: number;
  },
  pool: Pool = db
): Promise<RepairLegSummary> {
  const total = await countRepairable(pool);
  const rows = await fetchRepairRows(pool, opts.maxRepairs);

  let relabeled = 0;
  let repointed = 0;
  let notComparable = 0;

  for (const row of rows) {
    if (row.currentSimilarity === null) {
      // Could-not-measure gets its own branch and its own counter. It is NOT folded into
      // "below the floor", which would let an unmeasurable edge be re-pointed on the strength
      // of a comparison that never happened.
      //
      // IT MUST ALSO BE MARKED, or it stays in the population and every capped run re-fetches
      // the same unmeasurable rows first — reintroducing the exact starvation this leg was
      // just fixed for, in the one population that can never satisfy the honest-label arm.
      // The marker is narrow on purpose: the row re-qualifies the moment it becomes
      // measurable again (the re-embed self-heal worker replacing a degenerate vector), so
      // this defers the edge, it does not abandon it.
      notComparable++;
      if (!opts.dryRun) {
        await pool.query(
          `UPDATE links
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $1`,
          [
            row.id,
            JSON.stringify({
              repairUnmeasurable: true,
              repairCheckedAt: new Date().toISOString(),
            }),
          ]
        );
      }
      continue;
    }

    const measured = row.currentSimilarity;

    // ── RE-POINT? Only when the current target is below our present standard. ──
    if (measured < opts.minSimilarity) {
      const better = await findBetterNeighbour(pool, row, measured, opts.improvementMargin);
      if (better) {
        repointed++;
        if (!opts.dryRun) {
          await repointEdge(pool, row, better);
        }
        continue;
      }
    }

    // ── RE-LABEL. Unconditional by construction: REPAIR_POPULATION_SQL only returns
    // measurable edges that do NOT already carry an honest label, so every measurable row
    // that reached here (i.e. was not re-pointed above) needs one. There is deliberately no
    // second, TypeScript-side honesty check to disagree with the SQL one — and no
    // `unchanged` counter, because a row that needed nothing is no longer fetched at all.
    {
      relabeled++;
      if (!opts.dryRun) {
        await pool.query(
          `UPDATE links
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $1`,
          [
            row.id,
            JSON.stringify({
              provenance: EDGE_PROVENANCE.guess,
              method: GUESS_METHOD,
              similarity: measured,
              repairedBy: 'graph-backfill:repair',
              repairedAt: new Date().toISOString(),
            }),
          ]
        );
      }
      continue;
    }
  }

  return {
    examined: rows.length,
    relabeled,
    repointed,
    notComparable,
    remainingUnprocessed: Math.max(0, total - rows.length),
  };
}

/**
 * Find a materially better neighbour for a below-floor edge, using the SAME candidate
 * statement the inference path uses (with the reachability filter lifted, as everywhere in
 * this job). Returns null unless a DIFFERENT context beats the current target by at least
 * `margin`.
 */
async function findBetterNeighbour(
  pool: Pool,
  row: RepairRow,
  measured: number,
  margin: number
): Promise<{ id: string; similarity: number } | null> {
  const col = activeEmbeddingColumn();
  const src = await pool.query(`SELECT ${col}::text AS embedding FROM contexts WHERE id = $1`, [
    row.fromId,
  ]);
  const embedding: string | null = src.rows[0]?.embedding ?? null;
  if (!embedding) return null;

  // Ask for a few candidates, not one: the current target is usually still the nearest row,
  // and a LIMIT 1 would return it and conclude "no better neighbour exists" for every edge.
  const cand = await pool.query(inferenceCandidateSql(col, { requireReachableCandidate: false }), [
    embedding,
    row.fromId,
    row.projectId,
    5,
  ]);

  for (const c of cand.rows as Array<{ id: string; similarity: unknown }>) {
    if (c.id === row.toId) continue;
    const sim = Number(c.similarity);
    if (!Number.isFinite(sim)) continue;
    if (sim - measured >= margin) return { id: c.id, similarity: sim };
    // Rows are distance-ascending, so the first non-target candidate is the best available.
    break;
  }
  return null;
}

/**
 * Move an edge's target. Written as DELETE-then-INSERT-shaped UPDATE with an explicit
 * conflict check because `links` carries UNIQUE(from_id, to_id, edge_type): if an edge to the
 * better neighbour ALREADY exists, updating this row would violate the constraint. In that
 * case the old row is deleted instead — the relationship it recorded is already present, more
 * accurately, under whatever provenance minted it.
 */
async function repointEdge(
  pool: Pool,
  row: RepairRow,
  better: { id: string; similarity: number }
): Promise<void> {
  const clash = await pool.query(
    `SELECT 1 FROM links WHERE from_id = $1 AND to_id = $2 AND edge_type = $3`,
    [row.fromId, better.id, INFERENCE_EDGE_TYPE]
  );
  if (clash.rows.length > 0) {
    await pool.query(`DELETE FROM links WHERE id = $1`, [row.id]);
    return;
  }
  await pool.query(
    `UPDATE links
        SET to_id = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE id = $1`,
    [
      row.id,
      better.id,
      JSON.stringify({
        provenance: EDGE_PROVENANCE.guess,
        method: GUESS_METHOD,
        similarity: better.similarity,
        repairedBy: 'graph-backfill:repair',
        repairedAt: new Date().toISOString(),
        repointedFrom: row.toId,
      }),
    ]
  );
}

// ── The job ────────────────────────────────────────────────────────────────────────────

export interface GraphBackfillOptions {
  /** WRITE. Default false = dry run (safe by default, like every backfill in this repo). */
  apply?: boolean;
  /**
   * Opt IN to the CN2-gated declared leg. Default false. The systemd unit does not pass it,
   * so a scheduled run can never execute it. See this module's header.
   */
  includeDeclared?: boolean;
  /** Overrides, each defaulting to graphBackfillConfig. */
  threshold?: number;
  maxOrphans?: number;
  maxRepairs?: number;
  repair?: boolean;
}

/**
 * RUN THE WHOLE JOB. Order is deliberate: DECLARED first (when opted in), then GUESSED, then
 * REPAIR.
 *
 * Declared before guessed because a declared edge is strictly better evidence than a cosine
 * guess, and minting it first removes its endpoints from the orphan set — so the guessed leg
 * never spends a guess on a record whose real relationship was already recoverable from a tag
 * somebody actually wrote. Repair last so it also sees, and can converge on, anything the
 * guessed leg just minted.
 */
export async function runGraphBackfill(
  opts: GraphBackfillOptions = {},
  pool: Pool = db
): Promise<GraphBackfillSummary> {
  const started = Date.now();
  const dryRun = !opts.apply;
  const threshold = opts.threshold ?? GUESS_THRESHOLD;
  const maxOrphans = opts.maxOrphans ?? MAX_ORPHANS_PER_RUN;
  const maxRepairs = opts.maxRepairs ?? MAX_REPAIRS_PER_RUN;
  const repairEnabled = opts.repair ?? REPAIR_ENABLED;
  const includeDeclared = opts.includeDeclared === true;

  const orphansBefore = await countOrphans(pool);

  const emptyRepair: RepairLegSummary = {
    examined: 0,
    relabeled: 0,
    repointed: 0,
    notComparable: 0,
    remainingUnprocessed: 0,
  };

  logger.info(
    `🕸️  graph-backfill: starting (${dryRun ? 'DRY-RUN' : 'APPLY'}), orphans=${orphansBefore}, ` +
      `threshold=${threshold}, declaredLeg=${includeDeclared ? 'INCLUDED (CN2 opt-in)' : 'skipped'}`
  );

  const declared = includeDeclared
    ? await runTaskEdgeBackfill({ apply: opts.apply === true }, pool)
    : null;

  const guessed = await runGuessedLeg({ dryRun, threshold, maxOrphans }, pool);

  const repair = repairEnabled
    ? await runRepairLeg(
        {
          dryRun,
          minSimilarity: REPAIR_MIN_SIMILARITY,
          improvementMargin: REPAIR_IMPROVEMENT_MARGIN,
          maxRepairs,
        },
        pool
      )
    : emptyRepair;

  const orphansAfter = dryRun ? guessed.orphansAfter : await countOrphans(pool);

  return {
    dryRun,
    includedDeclared: includeDeclared,
    guessThreshold: threshold,
    guessed,
    declared,
    repair,
    orphansBefore,
    orphansAfter,
    durationMs: Date.now() - started,
  };
}
