/**
 * ONE-TIME ORPHAN BACKFILL — Component C of reliable-auto-threading (CORE logic)
 * (branch:mandrel-reliability, task ST-6, spec
 * docs/specs/reliable-auto-threading.md §C1/C2/C3, §X4).
 *
 * THE PROBLEM (measured): 49% of existing contexts are born orphans (zero edges) because
 * auto-threading only fired when a `thread_set` anchor was remembered. ST-4/ST-5 stop NEW
 * writes from orphaning; this repairs the existing backlog by applying the SAME write-time
 * inference (Component B) to every current orphan in a project — minting one weak `related_to`
 * edge to each orphan's nearest reachable neighbor at/above the threshold.
 *
 * WHY THIS LIVES IN src/ (not scripts/): the repo pattern is logic-in-src, thin-executable-in-
 * scripts. Keeping the testable core here (a) lets the contract test import it under the
 * `rootDir: src` tsconfig (a scripts/ import trips TS6059), and (b) keeps the CLI a thin
 * wrapper. `scripts/backfill-orphan-threads.ts` is the npx-tsx entrypoint that calls this.
 *
 * REUSE, DON'T REINVENT: the inference is `inferAndMintRelatedTo`
 * (services/threadInference.ts) — the exact same helper the context_store route (ST-5) uses.
 * There is NO second nearest-neighbor query and NO second mint path here; this only
 * ENUMERATES orphans and drives the shared helper per orphan. Threshold/candidate-limit come
 * from config/reliableThreadingConfig.ts (configs-not-hardcoded); `--threshold` overrides the
 * floor for one run.
 *
 * SAFETY POSTURE (spec §X4 — no prod surgery, safe by default): DRY-RUN IS THE DEFAULT — a
 * live write requires an explicit `--apply`. Idempotent (mintEdge dedups; non-orphans are
 * excluded, so a re-run mints nothing new). Scoped to ONE project. No silent truncation — the
 * count + ids of un-rescuable orphans are reported.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { inferAndMintRelatedTo } from './threadInference.js';

// Re-export the DB-free CLI surface so callers can `import { ... } from './orphanBackfill.js'`
// for the whole API. (The parsing itself lives in the db-free ./orphanBackfill.cli.js so
// `--help` works without a DATABASE_NAME env — see that module's header.)
export { parseArgs, usageText, type BackfillCliOptions } from './orphanBackfill.cli.js';

/** created_by stamped on edges this backfill mints. The mint-PATH label is set by the helper
 *  it delegates to (inferAndMintRelatedTo → links.mint_via = 'inference'), not here. */
export const CREATED_BY = 'backfill:orphan-threads';

/** A single resolved project (id + human name). */
export interface ResolvedProject {
  id: string;
  name: string;
}

// ── Structured result (what the CLI prints AND the test asserts on) ─────────────────────

export interface BackfillSummary {
  projectId: string;
  projectName: string;
  /** The floor actually used this run. */
  threshold: number;
  /** True if this was a projection (no writes). */
  dryRun: boolean;
  /** Active (non-archived) contexts in the project — the orphan-rate denominator. */
  totalContexts: number;
  /** Orphan contexts (zero edges) found BEFORE the run. */
  orphansBefore: number;
  /** Orphans whose nearest reachable neighbor cleared the threshold (rescuable / would-rescue). */
  rescuable: number;
  /** NEW related_to edges actually written (always 0 in dry-run). */
  minted: number;
  /** Orphans that could NOT be rescued (sum of the buckets below). */
  unrescuable: number;
  /**
   * Un-rescuable: a neighbor WAS evaluated and the best one scored below the threshold. This
   * used to also absorb every other non-'minted' reason via a catch-all `else`
   * — so "no neighbor was close enough" was reported for orphans whose neighbourhood
   * was never measured at all. It now counts exactly what its name says.
   */
  noNeighbor: number;
  /**
   * Un-rescuable: there was NOTHING to compare against — the project has no other threaded,
   * embedded, unarchived context. Distinct from `noNeighbor` on purpose: a zero-candidate
   * result and an honest below-floor result are different facts, and their being one string
   * is why the RED went unattributed for a week.
   */
  noCandidates: number;
  /** Un-rescuable: the orphan itself has no embedding to compare. */
  noEmbedding: number;
  /**
   * Un-rescuable: the orphan's embedding is present but DEGENERATE (zero-norm), so it cannot
   * be compared to anything and is invisible to semantic search. A broken row, not a lonely
   * one — the re-embed self-heal gate now selects these for a fresh vector.
   */
  degenerateEmbedding: number;
  /** Un-rescuable: a similarity came back non-finite, so no comparison could be made. */
  notComparable: number;
  /** Un-rescuable: inference errored (logged, non-fatal). */
  errors: number;
  /** Orphans remaining AFTER: projected (before − rescuable) in dry-run; re-queried actual in live. */
  orphansAfter: number;
  /** Ids of the orphans not rescued — reported in full, never silently dropped. */
  unrescuableIds: string[];
  /** orphansAfter / totalContexts * 100 (0 when there are no contexts). */
  projectedOrphanRatePct: number;
}

// ── Project resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve a `--project` ref (exact id OR exact name) to {id, name}. Throws a clear Error on
 * no-match or an ambiguous name (multiple projects share the name).
 */
export async function resolveProjectRef(ref: string, pool: Pool = db): Promise<ResolvedProject> {
  const byId = await pool.query('SELECT id::text AS id, name FROM projects WHERE id::text = $1', [ref]);
  if (byId.rows[0]) return byId.rows[0];

  const byName = await pool.query('SELECT id::text AS id, name FROM projects WHERE name = $1', [ref]);
  if (byName.rows.length === 1) return byName.rows[0];
  if (byName.rows.length > 1) {
    throw new Error(`Project name "${ref}" is ambiguous (${byName.rows.length} matches) — pass the id instead.`);
  }
  throw new Error(`No project matches "${ref}" by id or name.`);
}

// ── DB helpers (single owner of the orphan definition) ──────────────────────────────────

/** Active (non-archived) context count in a project — the orphan-rate denominator. */
async function countActiveContexts(projectId: string, pool: Pool): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM contexts WHERE project_id = $1 AND archived_at IS NULL`,
    [projectId]
  );
  return r.rows[0].n;
}

/**
 * The orphan set: active contexts in the project with NO edge in `links` on either endpoint.
 * This is the SAME orphan definition used everywhere (NOT EXISTS a links row referencing it).
 * Ordered oldest-first for deterministic processing.
 */
async function findOrphanIds(projectId: string, pool: Pool): Promise<string[]> {
  const r = await pool.query(
    `SELECT c.id::text AS id
       FROM contexts c
      WHERE c.project_id = $1
        AND c.archived_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM links l WHERE l.from_id = c.id OR l.to_id = c.id
            )
      ORDER BY c.created_at ASC`,
    [projectId]
  );
  return r.rows.map((row) => row.id);
}

/**
 * THE UN-RESCUABLE BREAKDOWN — one labelled line per cause, defined HERE rather than in the
 * CLI's printer.
 *
 * WHY THIS FUNCTION EXISTS: the printer used to hand-list three of the buckets. Splitting the
 * causes apart would have left it printing three of six, so an operator would read
 * `Un-rescuable: 6` above a breakdown summing to 2 and have no idea where the other 4 went —
 * trading one wrong number for a quieter wrong number. The breakdown is derived from the
 * summary in ONE place, so a new cause cannot be added without appearing in the report.
 *
 * It also RECONCILES: the parts must sum to `unrescuable`, or this throws. A report whose
 * parts silently fail to add up is the same disease as the reason that lied — a number that
 * reads as complete while it is not.
 */
export function unrescuableBreakdown(s: BackfillSummary): Array<{ label: string; count: number }> {
  const parts = [
    { label: 'no neighbor >= thr', count: s.noNeighbor },
    { label: 'no candidate at all', count: s.noCandidates },
    { label: 'no embedding', count: s.noEmbedding },
    { label: 'degenerate embedding', count: s.degenerateEmbedding },
    { label: 'similarity not comparable', count: s.notComparable },
    { label: 'inference error', count: s.errors },
  ];
  const sum = parts.reduce((t, p) => t + p.count, 0);
  if (sum !== s.unrescuable) {
    throw new Error(
      `orphanBackfill: un-rescuable breakdown does not reconcile — parts sum to ${sum} but ` +
        `unrescuable is ${s.unrescuable}. A cause is being counted twice or not at all.`,
    );
  }
  return parts;
}

// ── The backfill (used by BOTH the CLI and the tests) ───────────────────────────────────

/**
 * Run the orphan backfill for a resolved project. Enumerates orphans and drives the SHARED
 * inference helper per orphan (dry-run projects; live mints). Returns a structured
 * {@link BackfillSummary}. Never throws for a per-orphan inference failure (the helper is
 * non-throwing) — such an orphan is tallied under `errors` and reported, not dropped.
 */
export async function backfillOrphanThreads(
  opts: { projectId: string; projectName: string; dryRun: boolean; threshold: number },
  pool: Pool = db
): Promise<BackfillSummary> {
  const { projectId, projectName, dryRun, threshold } = opts;

  const totalContexts = await countActiveContexts(projectId, pool);
  const orphanIds = await findOrphanIds(projectId, pool);
  const orphansBefore = orphanIds.length;

  let rescuable = 0;
  let minted = 0;
  let noNeighbor = 0;
  let noCandidates = 0;
  let noEmbedding = 0;
  let degenerateEmbedding = 0;
  let notComparable = 0;
  let errors = 0;
  const unrescuableIds: string[] = [];

  for (const orphanId of orphanIds) {
    const res = await inferAndMintRelatedTo(
      { fromId: orphanId, projectId, createdBy: CREATED_BY },
      pool,
      { threshold, dryRun }
    );

    if (res.reason === 'minted') {
      // Cleared the floor → rescuable. `minted` is true only when a NEW edge was written
      // (false on dry-run OR on a live dedup).
      rescuable++;
      if (res.minted) minted++;
    } else {
      unrescuableIds.push(orphanId);
      // EXHAUSTIVE, NO CATCH-ALL. This was `if/else if/else noNeighbor++`,
      // an allow-by-default tally: any reason the chain did not name was silently counted as
      // "no neighbor was close enough". A `switch` with a `never` default makes an unhandled
      // reason a COMPILE error instead of a wrong number in an operator's report.
      switch (res.reason) {
        case 'source-has-no-embedding': noEmbedding++; break;
        case 'source-embedding-degenerate': degenerateEmbedding++; break;
        case 'similarity-not-comparable': notComparable++; break;
        case 'no-candidates': noCandidates++; break;
        case 'no-neighbor-above-threshold': noNeighbor++; break;
        case 'error': errors++; break;
        // 'minted' is not listed: TS has already narrowed it away in this else-branch, so
        // naming it is a compile error — the narrowing IS the proof it cannot arrive here.
        default: {
          const unhandled: never = res.reason;
          throw new Error(`orphanBackfill: unhandled InferenceReason ${String(unhandled)}`);
        }
      }
    }
  }

  const unrescuable = unrescuableIds.length;

  // Orphans after: in dry-run nothing changed, so project (before − rescuable). In a live run
  // re-query the ACTUAL remaining orphans (truthful, and a built-in idempotency cross-check).
  const orphansAfter = dryRun ? orphansBefore - rescuable : (await findOrphanIds(projectId, pool)).length;

  const projectedOrphanRatePct = totalContexts > 0 ? (orphansAfter / totalContexts) * 100 : 0;

  return {
    projectId,
    projectName,
    threshold,
    dryRun,
    totalContexts,
    orphansBefore,
    rescuable,
    minted,
    unrescuable,
    noNeighbor,
    noCandidates,
    noEmbedding,
    degenerateEmbedding,
    notComparable,
    errors,
    orphansAfter,
    unrescuableIds,
    projectedOrphanRatePct,
  };
}
