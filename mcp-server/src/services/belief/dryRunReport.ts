/**
 * dryRunReport — report-shaping for the belief-backfill dry-run (BL-8).
 *
 * The reconciler mints ONE edge type (edgeReconciliation.ts): `possibly_supersedes`, an
 * annotation-only candidate. The HARD `supersedes` tier was deleted in an earlier task — see
 * the beliefDerivation.ts module header for why an inferred edge may never reach an
 * exclusion predicate. This module therefore has ONE channel, not a tier split.
 *
 * Minted rows land in `links` with `created_by = 'auto:belief-adjudicator'`. This module
 * turns the raw minted-edge rows into a report fragment for the blind judge. Pure +
 * dependency-free so it is unit-testable without a DB or LLM calls.
 */

/** A minted belief edge as read back from the `links` table (all metadata as text). */
export interface MintedEdgeRow {
  from_id: string;
  to_id: string;
  /** The minted edge type — `possibly_supersedes` is the only one this pipeline can mint. */
  edge_type: string;
  mode: string | null;
  confidence: string | null;
  cosine: string | null;
  rationale: string | null;
}

/** One minted edge enriched with both records' content for spot-check / blind judging. */
export interface MintedDetail {
  from_id: string;
  to_id: string;
  edge_type: string;
  mode: string | null;
  confidence: string | null;
  cosine: string | null;
  /** The adjudicator rationale (task-spec field name for the blind judge). */
  reason: string | null;
  /** Alias of `reason` kept so pre-BL-8 readers of `minted_detail` keep working. */
  rationale: string | null;
  from_content: string;
  to_content: string;
}

/** The minted report — one channel, because one edge type can be minted. */
export interface MintedTierReport {
  /** Total minted edges. */
  minted_edges: number;
  /** All minted edges. */
  minted_detail: MintedDetail[];
}

/**
 * Shape raw minted-edge rows into the report fragment.
 *
 * @param rows         minted edges from `links` (created_by='auto:belief-adjudicator').
 * @param contentOf    lookup for a record's full content by id (from the corpus).
 * @param contentSlice max chars of content to embed per record (default 700, as pre-BL-8).
 */
export function shapeMintedReport(
  rows: MintedEdgeRow[],
  contentOf: (id: string) => string | undefined,
  contentSlice = 700,
): MintedTierReport {
  const toDetail = (e: MintedEdgeRow): MintedDetail => ({
    from_id: e.from_id,
    to_id: e.to_id,
    edge_type: e.edge_type,
    mode: e.mode,
    confidence: e.confidence,
    cosine: e.cosine,
    reason: e.rationale,
    rationale: e.rationale,
    from_content: (contentOf(e.from_id) ?? '').slice(0, contentSlice),
    to_content: (contentOf(e.to_id) ?? '').slice(0, contentSlice),
  });

  const minted_detail = rows.map(toDetail);

  return {
    minted_edges: minted_detail.length,
    minted_detail,
  };
}
