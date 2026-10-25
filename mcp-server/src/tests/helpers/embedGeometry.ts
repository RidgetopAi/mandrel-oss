/**
 * TEST-SIDE EMBEDDER GEOMETRY — the single source every fixture uses so a stub vector
 * matches the ACTIVE embedder's column geometry instead of a hardcoded 1536.
 *
 * WHY THIS EXISTS (WS-1 Pass-2):
 * the CI gate used to PIN MANDREL_EMBEDDER=minilm for the whole suite, and dozens of contract
 * tests hardcoded `new Array(1536)` / `dimensions: 1536` / asserted the column is
 * 'embedding'. That made the generic suite STRUCTURALLY UNABLE to run under prod's real
 * config (gemma → `embedding_gemma`, vector(768)): a 1536-d fixture is rejected by the
 * 768-d column's CHECK constraint. CI could never catch a gemma-only regression (it bit us
 * on an earlier task). The fix is embedder-agnostic BY CONSTRUCTION: derive geometry from
 * activeEmbedder() so the SAME test runs correctly under either embedder, and the CI gate exercises
 * BOTH as an axis instead of pinning one.
 *
 * STANDING PRINCIPLE (Operator): no hardcoded tunables — the dimension is a named value read
 * from the embedder registry, never a literal buried in a fixture.
 */
import { activeEmbedder, activeEmbeddingColumn, embedders } from '../../config/embeddingConfig.js';

/**
 * Native dimensionality of the ACTIVE embedder (minilm→1536, gemma→768). Fixtures size
 * their stub vectors to THIS so they land in the active column without a dimension mismatch.
 *
 * A FUNCTION, NOT A CONST. As `export const embedDim = activeEmbedder.dimensions`
 * this helper re-introduced, one layer up, exactly the module-scope memoization that made the
 * clean gate non-deterministic: 22 test files import it, and its value was frozen at whichever
 * file first evaluated this helper. Reading it at point of use keeps every fixture's geometry
 * in lockstep with the embedder the file actually selected.
 */
export function embedDim(): number {
  return activeEmbedder().dimensions;
}

/** Re-exported so a test's SQL fixtures name the active column instead of a literal 'embedding'. */
export { activeEmbeddingColumn, embedders };

/**
 * A fresh all-zero stub vector at the active geometry. Use for tests that only need a VALID
 * vector to satisfy the embed/NOT-NULL path and do not assert on retrieval ranking.
 * Returns a new array each call, so callers may mutate it (e.g. set concept dims).
 */
export function zeroEmbedding(): number[] {
  return new Array(embedDim()).fill(0);
}

/**
 * The standard deterministic PATTERN stub used across the contract suite
 * (`((i % 7) - 3) / 10`), sized to the active geometry. Deterministic + non-degenerate so
 * store/search paths behave identically under either embedder.
 */
export function patternEmbedding(): number[] {
  return new Array(embedDim()).fill(0).map((_v, i) => ((i % 7) - 3) / 10);
}

// =============================================================================
// conceptEmbedding — a CONTENT-DERIVED test embedder (plan amendment A3)
// =============================================================================
// WHY: patternEmbedding() above is INPUT-INDEPENDENT — it ignores its (absent) argument
// and returns the same vector for every fixture and every query, so cosine is 1.0
// everywhere. MEASURED on this tree before this helper existed: a test asserting that a
// query written entirely in "zeta" vocabulary returns the unrelated "alpha" record at
// rank 1 PASSED, with rawCosinePct=[100,100]; recency alone decided the order. Any
// RANKING assertion written on patternEmbedding is therefore hollow — it passes with the
// ranking deleted. Tests that only need A valid vector (store/NOT-NULL/dimension paths)
// are unaffected and should keep using patternEmbedding.
//
// WHAT THIS IS, AND WHAT IT IS NOT (amendment A3, deliberately rescoped):
//   IS:  a deterministic token -> concept-bucket projection over an EXPLICIT DECLARED
//        SYNONYM TABLE that fixture and query share. It gives the pipeline a real,
//        input-dependent cosine geometry, so ranking guards can distinguish "ranked on
//        the active embedding column" from "ranked on metadata / a lexical path".
//   NOT: a semantic model. It has no learned semantics. It proves MECHANISM, never
//        retrieval QUALITY. True semantic quality is measured by the retrieval harness
//        against real data, never by a vitest fixture.
//
// GEOMETRY: each declared bucket owns ONE dimension, assigned by declaration order, so
// declared buckets can never collide. Undeclared tokens hash into the dimensions ABOVE
// the reserved block — self-consistent (a token always lands on the same dim) and
// disjoint from the declared concepts. The vector is L2-normalised, so cosine == dot.

/** Tokens shorter than this are dropped. Named, not a literal in the tokenizer. */
export const CONCEPT_MIN_TOKEN_LEN = 3;

/**
 * Function words that carry no concept. Declared so a query's grammar cannot dilute its
 * cosine against a fixture that phrases the same concept differently.
 */
export const CONCEPT_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'had', 'how', 'what', 'when',
  'why', 'who', 'our', 'out', 'its', 'this', 'that', 'these', 'those', 'with', 'from',
  'into', 'about', 'we', 'do', 'does', 'did', 'of', 'to', 'in', 'on', 'at', 'by', 'is',
  'it', 'be', 'as', 'an', 'a', 'or', 'not', 'any', 'all', 'can', 'will', 'would',
]);

/**
 * THE DECLARED SYNONYM TABLE (amendment A3). Bucket name -> the surface tokens that mean
 * it. Fixture text and query text are projected through the SAME table, which is what
 * lets a query retrieve a fixture that shares no literal token with it. Every entry here
 * is a deliberate, reviewable statement — there is no inferred synonymy.
 */
export const CONCEPT_BUCKETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  secret: ['secret', 'secrets', 'credential', 'credentials', 'password', 'passwords', 'lease'],
  rotate: ['rotate', 'rotates', 'rotation', 'expiring', 'expire', 'expires', 'renew', 'renewal'],
  audit: ['audit', 'audits', 'compliance', 'review', 'reviews', 'inspection'],
  schedule: ['schedule', 'scheduled', 'quarterly', 'deadline', 'ahead', 'before'],
  retrieval: ['retrieval', 'search', 'searching', 'recall', 'ranking', 'rank', 'relevance'],
  storage: ['storage', 'database', 'postgres', 'table', 'column', 'persist', 'persisted'],
  deploy: ['deploy', 'deployment', 'release', 'ship', 'shipped', 'rollout'],
});

const CONCEPT_BUCKET_NAMES: readonly string[] = Object.keys(CONCEPT_BUCKETS);

/** token -> bucket index, derived from the table above (single source; no second copy). */
const TOKEN_TO_BUCKET_DIM: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  CONCEPT_BUCKET_NAMES.forEach((name, dim) => {
    for (const tok of CONCEPT_BUCKETS[name]) m.set(tok, dim);
    m.set(name, dim); // the bucket name is itself a member of its bucket
  });
  return m;
})();

/** Dimensions [0, CONCEPT_RESERVED_DIMS) belong to declared buckets, one each. */
export const CONCEPT_RESERVED_DIMS = CONCEPT_BUCKET_NAMES.length;

/** FNV-1a 32-bit — deterministic across processes; no dependence on JS string hashing. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Split text into concept-bearing tokens. Exported so a test can assert on the tokens. */
export function conceptTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(t => t.length >= CONCEPT_MIN_TOKEN_LEN && !CONCEPT_STOPWORDS.has(t));
}

/**
 * Deterministic, content-derived UNIT vector at the active embedder's geometry.
 * Same text -> identical vector (cosine 1). Concept-disjoint texts -> cosine 0.
 * Empty/stopword-only text -> a fixed unit vector on the last dimension, never a zero
 * vector (a zero vector makes cosine undefined and poisons every downstream comparison).
 */
export function conceptEmbedding(text: string): number[] {
  const dim = embedDim();
  const v = new Array(dim).fill(0);
  const toks = conceptTokens(text);
  if (toks.length === 0) {
    v[dim - 1] = 1;
    return v;
  }
  const unreserved = dim - CONCEPT_RESERVED_DIMS;
  for (const tok of toks) {
    const declared = TOKEN_TO_BUCKET_DIM.get(tok);
    const d = declared !== undefined
      ? declared
      : CONCEPT_RESERVED_DIMS + (fnv1a(tok) % unreserved);
    v[d] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map(x => x / norm);
}

/** Cosine of two equal-length vectors. Used by the helper's own probe and by guards. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
