/**
 * TEST-SIDE EMBEDDER GEOMETRY (backend) — the single source every backend fixture uses so
 * a stub vector matches the ACTIVE embedder's column geometry instead of a hardcoded 1536.
 *
 * WHY THIS EXISTS
 *   mcp-server has had src/tests/helpers/embedGeometry.ts since so the
 *   derived spelling was available there. The backend had no equivalent, so the hardcoded
 *   spelling was the easy one here — and on 2026-08-19 two backend fixtures written as
 *   `Array.from({ length: 1536 })` went RED the moment the CODE DEFAULT flipped to gemma,
 *   against a vector(768) column whose CHECK (migration 056) rejects them. That was
 *   invisible in every worktree and surfaced only on a merged ref (C4), because Stage 4 of
 *   the CI gate supplies no MANDREL_EMBEDDER and therefore runs at whatever the code
 *   default happens to be.
 *
 *   Fixing those two fixtures did not close the class; the NEXT fixture lands the same way.
 *   The ABSENCE OF THIS FILE was the defect. This is the deletion-shaped half of the fix.
 *
 * THIS FILE IS A DELIBERATE MIRROR of mcp-server/src/tests/helpers/embedGeometry.ts.
 *   Same names, same meanings, same "a FUNCTION, not a const" rule — two copies of one idea
 *   should agree on the idea. It mirrors rather than imports for the same reason
 *   src/config/embeddingColumn.ts mirrors the core registry: the core module cannot be
 *   imported across the workspace/tsconfig boundary. It reads its geometry from
 *   src/config/embeddingColumn.ts, which is itself pinned against the core by
 *   embeddingColumn.contract.test.ts.
 *
 *   NOT mirrored: conceptEmbedding() and the concept-bucket table. Those exist to make
 *   RANKING assertions non-hollow in the mcp-server retrieval suite. No backend fixture
 *   asserts on ranking (the backend's vector work is read-only analytics over rows the core
 *   wrote), so porting them would be dead code. Port it the day a backend test ranks.
 *
 * WHAT MAKES THE BAD STATE UNWRITABLE — three layers, weakest to strongest surface:
 *   1. eslint `no-restricted-syntax` (backend/.eslintrc.js, test-file override) makes a
 *      known embedder dimension written as a numeric literal in src/__tests__/ a LINT
 *      ERROR. That is the CI gate STAGE L, which is error-gated, needs no database, and
 *      fires under BOTH geometries — so it catches the "correct only by coincidence"
 *      spelling that a DB run under the matching embedder would wave through.
 *   2. vectorLiteral()'s length assertion below: a vector whose length disagrees with the
 *      active embedder throws by name, including the empty vector.
 *   3. the postgres CHECK constraint, which is where this class was found in the first
 *      place and remains the backstop for a wrong length no static rule enumerates.
 */
import { activeEmbeddingColumn, activeEmbeddingDimensions } from '../../config/embeddingColumn';

/**
 * Native dimensionality of the ACTIVE embedder (minilm 1536, gemma 768). Fixtures size
 * their stub vectors to THIS so they land in the active column without a mismatch.
 *
 * A FUNCTION, NOT A CONST — the same rule the mcp-server helper learned in an earlier task.
 * As a module-scope const the value freezes at whichever test file evaluated this module
 * first, and a suite that flips MANDREL_EMBEDDER between files silently keeps the stale
 * one. Read it at point of use.
 */
export function embedDim(): number {
  return activeEmbeddingDimensions();
}

/** Re-exported so a fixture's SQL names the active column instead of a literal 'embedding'. */
export { activeEmbeddingColumn };

/**
 * A fresh all-zero stub vector at the active geometry. For fixtures that need only a VALID
 * vector to satisfy a NOT-NULL / "this row has an embedding" path. Returns a new array each
 * call, so callers may mutate it.
 */
export function zeroEmbedding(): number[] {
  return new Array(embedDim()).fill(0);
}

/**
 * The standard deterministic PATTERN stub, sized to the active geometry — the same
 * `((i % 7) - 3) / 10` the mcp-server helper uses, deliberately, so a vector planted by one
 * package's fixtures is recognisable as the same idea in the other's.
 *
 * Deterministic and non-degenerate. It is INPUT-INDEPENDENT, so a ranking assertion written
 * on it would be hollow (cosine is 1.0 everywhere); use it for presence/analytics fixtures
 * only. No backend fixture ranks today.
 */
export function patternEmbedding(): number[] {
  return new Array(embedDim()).fill(0).map((_v, i) => ((i % 7) - 3) / 10);
}

/**
 * The pgvector TEXT form (`[a,b,c]`) that a backend fixture binds to a `$n::vector`
 * parameter. This is the backend-specific half of the helper: the mcp-server core hands the
 * driver a number[], while these fixtures write raw SQL.
 *
 * LENGTH IS ASSERTED, NOT ASSUMED. Handing this a vector that disagrees with the active
 * embedder throws here, by name, instead of arriving at postgres as a constraint violation
 * two frames away — and instead of PASSING under whichever embedder happens to match. The
 * empty vector is not a special case: `[]` has length 0, 0 never equals a real dimension, so
 * it throws like any other disagreement. That matters because an empty fixture is the shape
 * that silently produces a suite asserting over zero rows.
 */
export function vectorLiteral(vec: number[] = patternEmbedding()): string {
  const want = embedDim();
  if (vec.length !== want) {
    throw new Error(
      `embedGeometry.vectorLiteral: vector has ${vec.length} dimensions but the ACTIVE ` +
        `embedder needs ${want}. Do not write the length by hand — call zeroEmbedding(), ` +
        `patternEmbedding(), or vectorLiteral() with no argument, so the fixture tracks ` +
        `MANDREL_EMBEDDER instead of being correct only by coincidence.`,
    );
  }
  return `[${vec.join(',')}]`;
}
