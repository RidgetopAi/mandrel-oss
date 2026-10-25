/**
 * Mandrel Core — SHARED RANKING CONFIG.
 *
 * WHY THIS FILE EXISTS. The four-signal blend that ranks contexts — similarity, recency,
 * importance, type weight — lived as a private const inside handlers/context.ts. That was
 * fine while contexts were the only thing ranked on it. smart_search now merges rows from
 * SEVERAL sources into ONE globally-sorted list, and a global sort is only meaningful if
 * every source's score is on the same scale. The blend is therefore a cross-handler
 * contract, and a contract cannot live inside one of its parties.
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED TUNABLES. Every weight/half-life here is a
 * named value with a documented default and an env override — never a literal in a
 * handler. Mirrors config/searchConfig.ts and config/recallConfig.ts.
 */

/** Read a finite float env var, falling back to `fallback` on missing/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** The four blend weights plus the recency decay half-life, in days. */
export interface RankWeights {
  similarity: number;
  recency: number;
  importance: number;
  typeWeight: number;
  halfLifeDays: number;
}

export const RANK_WEIGHTS: { balanced: RankWeights; recency: RankWeights } = {
  // BALANCED default: similarity-dominant 0.70/0.10/0.10/0.10.
  // The prior 0.25-each blend weighted semantic similarity at only 25%, so on
  // data with real metadata variation (varied recency + context_type — i.e. all
  // production data) recency/type DEMOTED the best semantic match: a measured
  // -9 recall@1 pts on real LongMemEval session dates, up to -59 with varied
  // type. 0.70 recovers it (no-op on uniform-metadata data → zero regression on
  // the frozen eval baseline). See ref:ranking-blend-finding. Env-overridable.
  // 2026-08-19: recency cut 0.10 -> 0.05, similarity 0.70 -> 0.75.
  // This is the SAME finding as above, one turn further on — recency was still
  // taxing the best semantic match, just less visibly.
  //
  // MEASURED on a frozen replica of the prod corpus, running the real handler of
  // each ref (not a re-implementation), against a 33-question AGE-STRATIFIED dev
  // set — 45% of homes older than 30 days. The old 10-question set could not see
  // this: every home in it was 3-6 days old, so it was structurally incapable of
  // detecting a regression on old records, and would have REJECTED this change.
  //   dev hit@5 by recency weight: 0.10->12 · 0.075->14 · 0.05->14 · 0.025->15 · 0.0->15
  // 0.05 is the MIDDLE of that flat region, chosen on the dev plateau and
  // pre-committed BEFORE the holdout was read (the holdout is a check, never a
  // selection input — n=10 against a 4-weight blend fits the set trivially).
  // The 31-60d bucket goes 2/7 -> 4/7; >60d hit@1 1/8 -> 2/8.
  //
  // WHY NOT 0: the whole 0-7d bucket scores 3/8 at EVERY setting including zero.
  // At a 30-day half-life a young target and its young competitors all score ~0.9,
  // so the term never discriminates where it was meant to help while steadily
  // taxing older records. It is kept small rather than deleted because nothing
  // measured here argues for removing recency as a signal — only for it being
  // worth far less than it was charging.
  //
  // COST, stated so it is not rediscovered as a surprise: one holdout question
  // (a 2.7-day-old context) falls from rank 4 to 6. There is no setting that
  // recovers the 31-60d bucket without paying it; this is the cheapest version.
  //
  // SCOPE: these weights are shared — handlers/context.ts reads them too, so this
  // moves context_search ranking as well as smart_search. Same direction, but only
  // smart_search was measured. A search-specific profile is the follow-up.
  balanced: {
    similarity: envFloat('MANDREL_RANK_BAL_SIM', 0.75),
    recency: envFloat('MANDREL_RANK_BAL_REC', 0.05),
    importance: envFloat('MANDREL_RANK_BAL_IMP', 0.10),
    typeWeight: envFloat('MANDREL_RANK_BAL_TYPE', 0.10),
    halfLifeDays: envFloat('MANDREL_RANK_BAL_HALFLIFE_DAYS', 30.0),
  },
  // RECENCY-FOCUSED default: matches old 0.05 / 0.90 / 0.025 / 0.025 literals.
  //
  // SCOPE: this profile is selected by isRecencyQuery() and applies to
  // the CONTEXT source only. It is deliberately NOT propagated to the unified
  // smart_search score — see SEARCH_MERGE_RECENCY_PROFILE_APPLIES in
  // config/searchMergeConfig.ts for the reasoning and the switch.
  recency: {
    similarity: envFloat('MANDREL_RANK_REC_SIM', 0.05),
    recency: envFloat('MANDREL_RANK_REC_REC', 0.90),
    importance: envFloat('MANDREL_RANK_REC_IMP', 0.025),
    typeWeight: envFloat('MANDREL_RANK_REC_TYPE', 0.025),
    halfLifeDays: envFloat('MANDREL_RANK_REC_HALFLIFE_DAYS', 7.0),
  },
};

/**
 * Build the SQL fragment for `combined_score` from a weight profile. The four
 * signal expressions are passed in (so the SECONDS in the decay differ per mode),
 * and each is multiplied by its configured weight. Numeric literals are emitted
 * with full precision so the default 0.25 path is byte-equivalent in value to the
 * historical `/4` form.
 */
export function buildCombinedScoreSql(w: RankWeights, simExpr: string, recExpr: string,
                                      impExpr: string, typeExpr: string): string {
  return `(
              (${simExpr}) * ${w.similarity} +
              (${recExpr}) * ${w.recency} +
              (${impExpr}) * ${w.importance} +
              (${typeExpr}) * ${w.typeWeight}
            )`;
}

/**
 * The four raw signals a row contributes to the blend, each already in [0,1] except
 * `createdAt`, from which the recency signal is derived.
 */
export interface RankSignals {
  /** Cosine similarity to the query embedding, in [0,1]. */
  cosine: number;
  /** The row's date; recency decays from it. */
  createdAt: Date | string | null | undefined;
  /** The row's importance, in [0,1]. */
  importance: number;
  /** The row's type weight, in [0,1]. */
  typeWeight: number;
}

/**
 * Recency signal, mirroring the SQL emitted by recExprFor() in handlers/context.ts:
 *   EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / (halfLifeDays * 24 * 3600))
 *
 * NOTE the field is named `halfLifeDays` throughout but the expression is a 1/e decay,
 * not a 1/2 decay. That is the SHIPPED behaviour and this twin reproduces it EXACTLY —
 * a "corrected" JS copy would make the two formulas disagree, which is the failure this
 * function exists to avoid. A missing date scores 0 (no recency evidence), never NaN.
 */
export function recencySignal(createdAt: Date | string | null | undefined,
                              halfLifeDays: number, nowMs: number = Date.now()): number {
  if (createdAt === null || createdAt === undefined) return 0;
  const t = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageSeconds = Math.max(0, (nowMs - t) / 1000);
  return Math.exp(-ageSeconds / (halfLifeDays * 24 * 3600));
}

/**
 * THE JS TWIN of buildCombinedScoreSql, for sources whose ranking is assembled in the
 * handler rather than in SQL (today: decisions inside smart_search).
 *
 * WHY A TWIN AND NOT A SECOND FORMULA. smart_search sorts rows from several sources in
 * ONE list, so every source's score must be the same quantity. Contexts already produce
 * that quantity in SQL as `combined_score`; decisions do not, and computing them with a
 * different shape is exactly the incomparability that let a constant 0.6 base outrank
 * every real context. Two copies of one formula is a genuine drift risk (C5), so it is
 * closed EXECUTABLY rather than by comment: a contract test recomputes a real context
 * row's SQL combined_score through this function and asserts they agree.
 */
export function unifiedScore(signals: RankSignals, w: RankWeights,
                             nowMs: number = Date.now()): number {
  const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
  return (
    clamp01(signals.cosine) * w.similarity +
    recencySignal(signals.createdAt, w.halfLifeDays, nowMs) * w.recency +
    clamp01(signals.importance) * w.importance +
    clamp01(signals.typeWeight) * w.typeWeight
  );
}
