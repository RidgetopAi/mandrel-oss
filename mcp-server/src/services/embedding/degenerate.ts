/**
 * DEGENERATE-EMBEDDING DETECTION — the ONE definition of "this vector cannot be compared
 * to anything", in BOTH the forms the system needs.
 *
 * THE DEFECT THIS CLOSES (measured 2026-07-27, real pgvector, disposable ci_* DB):
 *   An all-zero embedding is `NOT NULL`, so it satisfies every "already embedded" check we
 *   have — `WHERE <col> IS NULL` (services/reembedBackfill.ts buildWhere, the predicate BOTH
 *   the self-heal worker and the CLI backfill run) never selects it. Measured: with a
 *   zero-vector row and a NULL-vector row in the same project, the heal set contained ONLY
 *   the NULL row. So the row LOOKS EMBEDDED FOREVER and is never retried.
 *
 *   Meanwhile it is invisible to semantic recall: pgvector's cosine distance against a
 *   zero-norm vector is NaN, so `1 - (<col> <=> $q)` is NaN for every query. Measured, same
 *   probe: healthy row sim=1, neighbor sim=0.9, zero row sim=NaN → dropped by any
 *   min-similarity filter, and it sorts LAST in an ASC distance order.
 *
 *   A state that reads as success while the guarantee (this capture is retrievable) is not
 *   met. That is the whole class this module exists to make impossible.
 *
 * WHY TWO FORMS, CO-LOCATED (a past incident — "a guard is only as strong as the weakest place
 * its rule is written"): the rule is needed in JS (reject a bad vector BEFORE it is written)
 * and in SQL (find the bad vectors already written). Two copies of a rule that agree today
 * and can be weakened independently is exactly the failure shape. So both live in THIS file,
 * next to each other, and the agreement test in
 * `src/tests/degenerateEmbeddingOrphan.contract.test.ts` (describe block "the JS predicate and
 * the SQL predicate are ONE rule") hands the SAME fixture vectors to BOTH — this module and
 * real pgvector — and requires an identical verdict. Weaken either one and that test goes RED.
 *
 * THE AGREEMENT IS ARITHMETIC, NOT ASPIRATIONAL — and the first version of this file got it
 * WRONG (Reviewer REJECT of 403ef00; "verified narrow, claimed broad"). It said
 * the rule "is computed the same way on both sides", having only ever tested fixtures down to
 * 1e-6. It is not enough for both sides to compute "a sum of squares in float": pgvector's
 * `vector` column is float4 and its `<#>` multiplies AND accumulates in FLOAT32, while
 * JavaScript numbers are float64. The underflow thresholds differ by ~140 orders of magnitude,
 * which opens a band of STORABLE vectors where the two verdicts differ. Measured on
 * pgvector 0.8.3 at 768-d, every component = m:
 *
 *     m = 1e-6 … 1e-22    stored; both say usable                       — agree
 *     m = 1e-23 … ~1e-45  stored as REAL non-zero float4s, but each
 *                         product underflows float32 to 0 → SQL says
 *                         DEGENERATE while float64 JS said usable       — DISAGREED
 *     m ≲ 1e-46           the COMPONENT itself underflows float4, so the
 *                         column literally holds zeros, yet float64 JS
 *                         still saw a non-zero array and said usable    — DISAGREED
 *     m ≲ 1e-162          float64 underflows too; both say zero-norm    — agree
 *
 * Consequence past the wording: the choke point did not make an uncomparable STORED vector
 * impossible. Such a row would be written (nothing failed, from the write path's view), then
 * flagged by the SQL gate, then re-embedded on EVERY self-heal sweep — a non-converging churn
 * loop with no loud signal.
 *
 * THE FIX IS BY CONSTRUCTION, NOT BY ASSERTION: {@link degeneracyOf} rounds each component to
 * float32 (the precision the column stores) and rounds each square to float32 (the precision
 * pgvector multiplies in), so a product underflows to zero for exactly the values it underflows
 * for in the database. The agreement is then a property of the code, and the fixtures — which
 * now straddle the float32 underflow edge at 1e-22/1e-23 — pin the boundary rather than
 * sampling far from it. See "THE ACCUMULATOR IS DELIBERATELY float64" below for the one place
 * this intentionally does NOT mirror pgvector, and why that cannot affect the verdict.
 *
 * WHY ZERO-NORM IS THE COMPLETE SQL PREDICATE: pgvector REFUSES to store a NaN or Infinity
 * component (`ERROR: NaN not allowed in vector` — measured on 0.8.3), so once a vector is IN
 * the column the only way it can be uncomparable is a zero norm. The JS side, which sees the
 * vector BEFORE the column, must additionally reject empty and non-finite.
 *
 * NO HARDCODED TUNABLES (standing principle): there is nothing to tune here. "Zero norm" is
 * not a threshold — it is the exact condition under which cosine similarity is undefined. A
 * tolerance would be a made-up number that either hides real vectors or admits dead ones.
 */

import { EmbeddingError, EmbeddingErrorType } from './types.js';

/** Why a vector is unusable. `null` from the predicate means the vector is fine. */
export type DegeneracyReason = 'empty' | 'non-finite' | 'zero-norm';

/**
 * THE JS predicate. Returns the reason a vector cannot be used for similarity, or `null`
 * when it is usable.
 *
 * `zero-norm` is deliberately computed as "the sum of squares is 0" rather than "every element
 * === 0": a vector of values so tiny that their squares underflow to 0 is equally uncomparable
 * (cosine becomes 0/0), and that is what pgvector will compute.
 *
 * EVALUATED IN FLOAT32, ON PURPOSE. Exactly TWO roundings decide the verdict, and each one is
 * independently load-bearing — remove either alone and a COMMITTED test goes RED (probed).
 * Which test differs, and the difference is informative rather than incidental:
 *   - product rounding removed  -> the AGREEMENT test (JS vs real pgvector) goes RED.
 *   - component rounding removed -> the unit case table's float32-OVERFLOW case goes RED.
 * The agreement test structurally cannot catch the component rounding: that rounding's
 * independent job is the overflow direction (1e39 is finite in float64 but Infinity at the
 * column's precision), and pgvector REJECTS such a row on insert — so the row never exists
 * for a DB-side comparison to be made against. Do not "simplify" this to one named test.
 *
 *   - `Math.fround(value)` models the float4 COLUMN. A component like 1e-100 is a perfectly
 *     ordinary float64 but is stored as literally 0, so a vector of them lands in the column
 *     as all-zeros. Judging the float64 input would call that usable.
 *   - `Math.fround(f32 * f32)` models the float32 MULTIPLY. The product of two float32s is
 *     exact in float64, so rounding it once IS the float32 result, underflow included:
 *     (1e-23)² = 1e-46 is below the smallest float32 subnormal (~1.4e-45) and becomes 0.
 *
 * THE ACCUMULATOR IS DELIBERATELY float64, and that is not a gap. An earlier version of this
 * function also rounded the running sum, described as essential — a mutation probe then showed
 * removing it changed neither a verdict nor a value in any case tested, because it and the
 * product rounding each masked the other's removal. Two roundings that hide each other's loss
 * are a rot surface: a future edit deletes one, every test stays green, and the module keeps
 * claiming both are required. So there is now ONE rounding after the multiply, and the
 * accumulator's precision is argued rather than asserted: every term is a square and therefore
 * non-negative, and a sum of non-negative floats is 0 if and only if every term is 0 (a positive
 * term can never bring a running total back down to 0). The zero verdict is therefore invariant
 * to both the accumulator's precision AND its ordering.
 *
 * That last point matters because pgvector 0.8.3 accumulates with SIMD lane partials, so it does
 * NOT sum in this loop's order — measured on 768 components of 0.1: pgvector 7.679995059967041,
 * a sequential float32 loop 7.680080890655518, a 4-lane simulation 7.679994106292725. This
 * module therefore never claims to reproduce pgvector's inner product; it claims only that the
 * two agree on ZERO, which is the only thing either side asserts. Verified across a 76-vector
 * sweep spanning 1e-1 … 1e-300 plus structured/mixed cases: zero verdict disagreements, plus an
 * explicit order-independence probe in the test.
 *
 * A component that overflows float32 (finite in float64, ±Infinity after rounding) is reported
 * `non-finite`: it is infinite at the column's precision, and pgvector rejects it on insert.
 */
export function degeneracyOf(embedding: readonly number[] | null | undefined): DegeneracyReason | null {
  if (!embedding || embedding.length === 0) return 'empty';
  let sumSquares = 0;
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'non-finite';
    const f32 = Math.fround(value);
    if (!Number.isFinite(f32)) return 'non-finite';
    // float64 accumulation of a float32 square: see the header — the zero verdict is invariant
    // to the accumulator's precision and ordering, so rounding here would be unprobeable weight.
    sumSquares += Math.fround(f32 * f32);
  }
  return sumSquares === 0 ? 'zero-norm' : null;
}

/** Convenience boolean over {@link degeneracyOf}. */
export function isDegenerateEmbedding(embedding: readonly number[] | null | undefined): boolean {
  return degeneracyOf(embedding) !== null;
}

/**
 * THE SQL predicate — TRUE for a stored vector that is present but uncomparable.
 *
 * `<#>` is pgvector's negative inner product, so `col <#> col` is `-(v·v)` = `-‖v‖²`, which
 * is 0 exactly when the norm is 0 (measured: zero vector → `-0` which `= 0` is TRUE; a unit
 * vector → `-1`; a 0.001-scaled vector → not flagged). Available in every pgvector version
 * we run, needs no extension function, and matches {@link degeneracyOf}'s `zero-norm` branch.
 *
 * @param column a TRUSTED column identifier from config (embeddingConfig.activeEmbeddingColumn()) —
 *               never user input. Interpolated, like every other use of that accessor.
 */
export function degenerateEmbeddingSql(column: string): string {
  return `(${column} IS NOT NULL AND (${column} <#> ${column}) = 0)`;
}

/**
 * THE CHOKE-POINT ASSERTION. Throws an {@link EmbeddingError} when the vector cannot be used.
 *
 * Called from EmbeddingService.generateEmbedding's single return point — the ONE place every
 * embedding that reaches a write passes through (storeContext, updateContext, recordDecision,
 * updateDecision, backfillContexts, backfillDecisions all obtain their vector from it). A
 * throw there lands in each site's EXISTING embed-failure handling: the create paths persist
 * the record with a NULL column and fire the LOUD onEmbedFailure alert, the update paths
 * retain the prior vector and alert, and the backfill counts the row failed and retries it on
 * the next sweep. So the degenerate vector never reaches the column, the row is left in the
 * one state the healer can see (NULL), and the failure is announced — instead of being
 * written as a permanent, invisible, "already embedded" orphan.
 */
export function assertUsableEmbedding(embedding: readonly number[] | null | undefined, source: string): void {
  const reason = degeneracyOf(embedding);
  if (!reason) return;
  throw new EmbeddingError(
    `Refusing a DEGENERATE embedding from ${source}: ${reason} ` +
      `(length ${embedding?.length ?? 0}). Such a vector is NOT NULL but has no direction, so ` +
      `cosine similarity against it is undefined — it would be stored as permanently ` +
      `un-retrievable while passing every "already embedded" check. Treating this as an ` +
      `embed FAILURE so the row stays re-embeddable and the degradation is alerted.`,
    EmbeddingErrorType.MODEL_INFERENCE,
    false,
  );
}
