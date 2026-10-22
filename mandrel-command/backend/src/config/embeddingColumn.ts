/**
 * ACTIVE EMBEDDING COLUMN — the ONE name every backend vector-SQL site must use.
 *
 * WHY THIS EXISTS (a past incident — fix the CLASS, not the instance):
 *   The Command backend runs read-only vector ANALYTICS (similarity matrices,
 *   projections, clusters, knowledge-gap, dataset listing, row-to-row related
 *   contexts). Every one of those hardcoded the literal `embedding` column. After
 *   the gemma cutover (MANDREL_EMBEDDER=gemma), new rows embed into a DIFFERENT
 *   column (`embedding_gemma`) and the legacy `embedding` column goes NULL for
 *   them — so every hardcoded ref silently points at the stale/empty column. That
 *   is N drifting copies of one decision. This centralizes it into ONE helper.
 *
 * SOURCE PATTERN (mirrored deliberately, like searchPredicates mirrors idResolver):
 *   The Mandrel core owns the authoritative registry at
 *   mcp-server/src/config/embeddingConfig.ts (embedders()[key].column, selected by
 *   MANDREL_EMBEDDER). That module can't be imported across the workspace/tsconfig
 *   boundary (different rootDir, core-only deps), so we MIRROR the same 2-entry
 *   key→column map here, keyed off the SAME `MANDREL_EMBEDDER` env the core reads.
 *   If the core's column names/keys change, update THIS map to match (pinned by
 *   embeddingColumn.contract.test.ts so the two can't drift silently).
 *
 * SECURITY: the returned value is a TRUSTED identifier sourced from config (never
 * user input) — safe to interpolate into SQL. The analytics SQL already filters
 * `<col> IS NOT NULL`, so it degrades gracefully while a gemma backfill still has
 * NULLs.
 */

/** Env override names, mirroring embeddingConfig.ts's `envStr(...)` column keys. */
const MINILM_COLUMN = process.env.MANDREL_MINILM_COLUMN || 'embedding';
const GEMMA_COLUMN = process.env.MANDREL_GEMMA_COLUMN || 'embedding_gemma';

/** key → column, mirroring embedders() in mcp-server/src/config/embeddingConfig.ts. */
const EMBEDDER_COLUMNS: Record<string, string> = {
  minilm: MINILM_COLUMN,
  gemma: GEMMA_COLUMN,
};

/**
 * key → stored column dimensionality, mirroring embedders()[k].dimensions in the core.
 *
 * NOT env-overridable, on purpose and unlike the column names above: the dimension is a
 * physical property of the model AND of the postgres column (migration 056 puts a
 * `vector_dims(embedding_gemma) = 768` CHECK on the gemma column), so a "tunable" here
 * could only ever produce rows postgres rejects. The core writes them as literals for the
 * same reason (embeddingConfig.ts: minilm 1536, gemma 768).
 *
 * ADDED 2026-08-19 because the column mirror alone was not enough: three sites in this
 * package still said `1536` in longhand — the dataset-listing payload the UI renders, and
 * two DB fixtures — so they were correct only while the active embedder happened to be
 * minilm. That is the identical "correct by coincidence" shape as the env-vs-code-default
 * bug this task exists to delete, one layer down. Keys MUST stay in step with
 * EMBEDDER_COLUMNS; embeddingColumn.contract.test.ts pins both maps against each other.
 */
const EMBEDDER_DIMENSIONS: Record<string, number> = {
  minilm: 1536,
  gemma: 768,
};

/**
 * The active embedder key — selected by MANDREL_EMBEDDER, defaulting to `minilm`.
 *
 * IDENTICAL semantics to the core's activeEmbedderKey() (embeddingConfig.ts), and that
 * is the whole point of this mirror: if these two disagree, the backend queries a
 * different column than the mcp-server writes, and the UI's search goes empty with no
 * error. `minilm` is the default (built in, offline; the fleet runs
 * `MANDREL_EMBEDDER=gemma`); `gemma` stays selectable.
 *
 * An UNRECOGNIZED value THROWS rather than falling back — a typo'd env used to land on
 * the legacy column silently, which is the exact split-brain this file exists to prevent.
 * ABSENT is not an error; absent means minilm.
 */
export function activeEmbedderKey(): string {
  const k = process.env.MANDREL_EMBEDDER || 'minilm';
  if (!EMBEDDER_COLUMNS[k]) {
    throw new Error(
      `MANDREL_EMBEDDER=${JSON.stringify(k)} is not a known embedder. ` +
        `Valid values: ${Object.keys(EMBEDDER_COLUMNS).sort().join(', ')}. ` +
        `Unset it to get the default (minilm). Refusing to guess a vector column: ` +
        `guessing wrong makes every analytics/search query silently return nothing.`,
    );
  }
  return k;
}

/**
 * The postgres vector column the ACTIVE embedder reads+writes on `contexts`.
 * Import THIS in every backend vector-SQL site instead of hardcoding `embedding`.
 */
export function activeEmbeddingColumn(): string {
  return EMBEDDER_COLUMNS[activeEmbedderKey()];
}

/**
 * The native dimensionality of the ACTIVE embedder's vector column (minilm 1536,
 * gemma 768). Use THIS anywhere a vector length is needed — the dataset payload the UI
 * renders, and any fixture that builds a stub vector — instead of writing the number.
 *
 * Reads the env at point of use, like everything else here: a snapshot taken at module
 * load is the memoization bug the core removed in and a jest suite that
 * flips MANDREL_EMBEDDER between files would silently keep the first value.
 */
export function activeEmbeddingDimensions(): number {
  return EMBEDDER_DIMENSIONS[activeEmbedderKey()];
}

/**
 * The registry's key population — the UNION of both maps, so a key present in only one
 * of them is IN the population and therefore resolves an undefined half. Conformance
 * checks walk THIS, never a hand-typed list.
 */
export function knownEmbedderKeys(): string[] {
  return [...new Set([...Object.keys(EMBEDDER_COLUMNS), ...Object.keys(EMBEDDER_DIMENSIONS)])].sort();
}

export default activeEmbeddingColumn;
