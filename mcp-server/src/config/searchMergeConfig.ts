/**
 * Mandrel Core — SMART_SEARCH MERGE CONFIG (parent 7b8af00d).
 *
 * smart_search used to allocate a per-source QUOTA of the result set (contexts
 * ⌈limit/2⌉, decisions ⌈limit/4⌉, components ⌈limit/4⌉), score each source on its own
 * private scale, and concatenate. This file holds the tunables for the replacement: an
 * OVER-FETCH per source, one comparable score, and a single global sort.
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED TUNABLES. Every value here is named, has a
 * documented default and an env override, and appears in no handler as a literal.
 */

/** Positive-integer env read; missing/garbage → fallback. */
function envPosInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Non-negative-integer env read. SEPARATE from envPosInt on purpose: the floor below
 * has 0 as its SHIPPED DEFAULT and 0 as a meaningful value, so a `v > 0` guard would
 * silently reject the very setting we ship.
 */
function envNonNegInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** Finite-float env read; missing/garbage → fallback. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Boolean env read; only the exact string 'true' enables. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true';
}

/**
 * THE DEFAULT SOURCE SET for smart_search.
 *
 * `component` was REMOVED (defect D4, measured on prod 2026-08-18): code_components held
 * 14 rows fleet-wide, all of them in one unrelated project and zero in riverbend; the
 * table has no embedding column, so the source was admitted by an ILIKE gate and then
 * SCORED BY complexity_score/10 — a code-complexity number, not a relevance number, on a
 * scale shared with nothing else. It consumed ⌈limit/4⌉ of every result set to return
 * nothing. A source that cannot produce a comparable score cannot participate in a
 * global sort.
 *
 * This constant exists so the list is DERIVED rather than retyped. It was duplicated in
 * four unsynchronised places — handlers/smartSearch.ts, routes/search.routes.ts,
 * config/opRegistry.ts (the advertised `includeTypes` help) and config/gatewayConfig.ts
 * (the lazy-list one-liner). ALL FOUR now read it from here; the model-facing two render
 * it through the helpers below rather than retyping it as English.
 *
 * `task` JOINED THIS SET on 2026-08-20 (the tranche-B flip). THIS LINE IS THE KILL SWITCH:
 * reverting the single commit that added 'task' here disarms the source completely — the
 * merge stops asking it for candidates — WITHOUT touching the schema, the baked vectors, the
 * reader, or the validator's vocabulary. It stays explicitly requestable via
 * includeTypes:['task'] after a revert, which is the point: a bad RANKING and a broken
 * CAPABILITY get different remedies, and the flip should only ever be the first one.
 */
export const SMART_SEARCH_DEFAULT_SOURCES: readonly string[] = Object.freeze(['context', 'decision', 'task']);

/**
 * THE SOURCE VOCABULARY — every key smart_search has an adapter for, whether or not it is
 * in the DEFAULT set above.
 *
 * WHY THIS IS A SECOND CONSTANT AND NOT THE SAME ONE. Two different questions were being
 * answered by one list, and the difference is the whole shape of this build:
 *   - "what do we search when the caller says nothing?"  → SMART_SEARCH_DEFAULT_SOURCES
 *   - "what may a caller ASK for?"                       → this
 * They differ on purpose while a source is built-but-not-yet-default: `task` is reachable
 * by an explicit `includeTypes:['task']` before it joins the default set, which is what
 * makes the default-set flip a one-line, separately-revertable kill switch rather than a
 * change that also has to add and remove capability.
 *
 * IT IS ALSO THE VALIDATOR'S ENUM (middleware/validation.ts smartSearchSchemas.search).
 * `includeTypes` used to be `z.array(z.string())` — unconstrained — so an unknown key was
 * accepted, matched no adapter, and returned a CLEAN EMPTY SUCCESS. That is the third
 * instrument state (C1): "I found nothing" and "you asked for something that does not
 * exist" were the same answer, and `includeTypes:['task']` returned it for weeks while the
 * vectors sat baked and unread. An unknown key now fails validation naming the valid set.
 *
 * INVARIANT, asserted executably in smartSearchMerge.contract.test.ts: every member of
 * SMART_SEARCH_DEFAULT_SOURCES is a member of this, and every member of this has an adapter
 * in smartSearchHandler's sourceAdapters().
 */
export const SMART_SEARCH_SOURCE_KEYS: readonly string[] = Object.freeze([
  'context',
  'decision',
  'task',
]);

/**
 * DERIVED PROSE for the ADVERTISED tool surface (same move as decisionVocab's `vocabList`).
 *
 * The two remaining copies of the source list were model-facing SENTENCES, which is exactly
 * the copy a compiler cannot keep honest: `component` stayed advertised in both long after
 * the handler stopped searching it. Rendering them from SMART_SEARCH_DEFAULT_SOURCES makes
 * the advertised list unable to disagree with the searched list.
 *
 * Three shapes because the three call sites need three shapes; all three read one constant.
 */

/** The default set as a JSON array literal the caller can paste into `includeTypes`. */
export function smartSearchSourcesJson(): string {
  return `[${SMART_SEARCH_DEFAULT_SOURCES.map((s) => `"${s}"`).join(',')}]`;
}

/** The compact `a+b+c` "what gets searched by default" form. */
export function smartSearchSourcesPlus(): string {
  return SMART_SEARCH_DEFAULT_SOURCES.join('+');
}

/**
 * `contexts and decisions` — an English list for the one-line lazy description.
 * Pluralisation is a bare `+s`, which is correct for every member of the source
 * vocabulary (context/decision/task); a source needing otherwise gets an explicit map.
 */
export function smartSearchSourcesProse(): string {
  const plural = SMART_SEARCH_DEFAULT_SOURCES.map((s) => `${s}s`);
  if (plural.length <= 1) return plural.join('');
  return `${plural.slice(0, -1).join(', ')} and ${plural[plural.length - 1]}`;
}

/**
 * How many candidates to pull PER SOURCE, as a multiple of the caller's `limit`.
 *
 * WHY IT IS NOT 1 (defect D2, measured): the old quotas fetched 7 candidates to fill 5
 * slots, and — worse — truncated contexts INSIDE the SQL by combined_score before any
 * cross-source comparison happened. Two of the ten probe questions had their correct
 * record at combined-rank 4 and 5 within the context source; both were cut before
 * scoring, so NO scoring fix could recover them. Over-fetching is what recovers them.
 * env: SEARCH_MERGE_OVERFETCH_FACTOR
 */
export const SEARCH_MERGE_OVERFETCH_FACTOR = envPosInt('SEARCH_MERGE_OVERFETCH_FACTOR', 3);

/**
 * Minimum rows a source is GUARANTEED in the final set. DEFAULT 0 — pure global sort is
 * the shipped behaviour (plan amendment A5).
 *
 * WHY 0 AND NOT 1. A guaranteed row per source is a constant bonus — structural instead
 * of arithmetic, but the same thing this task exists to delete. Concretely, at limit=5
 * with 3 sources a floor of 1 evicts up to TWO legitimately-ranked rows to inject rows
 * from sources that had nothing relevant, and it can evict the correct record from rank
 * 4 or 5 — directly reducing the hit@5 this work is measured on. If the unified score is
 * genuinely comparable (which is this whole task's thesis) then a per-source quota at any
 * layer is unjustified.
 *
 * It is kept as an OPT-IN for a caller that wants source diversity over ranking, and
 * source-invisibility remains a HARNESS DIAGNOSTIC (per-source composition of top-k)
 * rather than a mutation of the result set.
 * env: SEARCH_MERGE_MIN_PER_SOURCE
 */
export const SEARCH_MERGE_MIN_PER_SOURCE = envNonNegInt('SEARCH_MERGE_MIN_PER_SOURCE', 0);

/**
 * PER-SOURCE SCORE WEIGHT — every entry DEFAULTS TO 1.0, which is the hard rule.
 *
 * This map exists so an operator can experiment without a code edit; it does NOT exist to
 * hold a handicap. A per-source constant multiplier or addend IS defect D1 (the constant
 * 0.6 decision base) under a different name, and any non-1.0 default here would be that
 * bug shipped. If a source ranks too high, fix its SIGNAL, not its multiplier.
 * env: SEARCH_MERGE_WEIGHT_CONTEXT, SEARCH_MERGE_WEIGHT_DECISION, SEARCH_MERGE_WEIGHT_TASK
 */
export const SEARCH_SOURCE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  context: envFloat('SEARCH_MERGE_WEIGHT_CONTEXT', 1.0),
  decision: envFloat('SEARCH_MERGE_WEIGHT_DECISION', 1.0),
  task: envFloat('SEARCH_MERGE_WEIGHT_TASK', 1.0),
});

/**
 * Whether smart_search lets the CONTEXT source switch to the 0.90-recency rank profile
 * when isRecencyQuery() matches the query. DEFAULT FALSE — smart_search pins the balanced
 * profile for every source. context_search's own behaviour is untouched.
 *
 * THE DECISION AND ITS BASIS (this trapdoor is inherited if it is not decided):
 *  1. COMPARABILITY. The unified score's premise is that every row in the merged list is
 *     the same quantity. A context scored 0.05·cosine + 0.90·recency next to a decision
 *     scored 0.70·cosine is not the same quantity, so the global sort would be sorting
 *     two different things — defect D1's class, reintroduced by a query keyword.
 *  2. THE TRIGGER IS A SUBSTRING MATCH, NOT A WORD MATCH. MEASURED with the shipped
 *     keyword list against 9 probe queries: 8 fired, and 7 of those 8 are not temporal
 *     questions — 'current' inside "con*current* request handling", 'last' inside
 *     "b*last* radius" and "e*last*ic", 'new' inside "re*new*al" and "*new*sletter",
 *     'just' inside "ad*just* the ranking weights", 'now' inside "*now*here". Propagating
 *     that into three sources propagates a misfire, not an intent.
 *  3. HISTORY IS THE PRODUCT. The recency profile also applies a hard
 *     `created_at > NOW() - INTERVAL '60 days'` filter, which does not demote old records
 *     — it makes them unreachable. Recall of history is the signature capability; a
 *     keyword substring must not be able to switch it off.
 * env: SEARCH_MERGE_APPLY_RECENCY_PROFILE
 */
export const SEARCH_MERGE_APPLY_RECENCY_PROFILE =
  envBool('SEARCH_MERGE_APPLY_RECENCY_PROFILE', false);

/**
 * IMPORTANCE signal for a decision, from impact_level, in [0,1].
 *
 * Calibrated against the context source so neither gets a systematic edge: contexts use
 * COALESCE(relevance_score, 5.0)/10, i.e. an unset context sits at 0.5. This band is
 * centred on that same 0.5, so a medium-impact decision and a default-importance context
 * contribute identically. env: one per level.
 */
export const DECISION_IMPACT_IMPORTANCE: Readonly<Record<string, number>> = Object.freeze({
  critical: envFloat('SEARCH_MERGE_IMP_DECISION_CRITICAL', 1.0),
  high: envFloat('SEARCH_MERGE_IMP_DECISION_HIGH', 0.75),
  medium: envFloat('SEARCH_MERGE_IMP_DECISION_MEDIUM', 0.5),
  low: envFloat('SEARCH_MERGE_IMP_DECISION_LOW', 0.25),
});

/** Fallback when a decision's impact_level is absent or unrecognised: the neutral middle. */
export const DECISION_IMPACT_IMPORTANCE_DEFAULT =
  envFloat('SEARCH_MERGE_IMP_DECISION_DEFAULT', 0.5);

/**
 * TYPE-WEIGHT signal for a decision, in [0,1].
 *
 * DERIVED, NOT INVENTED: the context type-weight table already prices a record of type
 * 'decision' at 0.9 (handlers/context.ts TYPE_WEIGHT_CASE). A row in technical_decisions
 * is that same kind of record, so it takes that same weight. Picking 1.0 here would have
 * handed every decision a standing +0.01..+0.06 over every context — the constant bonus
 * this task deletes, at one tenth the size and just as unjustified.
 * env: SEARCH_MERGE_TYPEWEIGHT_DECISION
 */
export const DECISION_TYPE_WEIGHT = envFloat('SEARCH_MERGE_TYPEWEIGHT_DECISION', 0.9);

// =============================================================================
// THE TASK SOURCE'S TWO NON-COSINE SIGNALS (tranche B)
// =============================================================================
// The unified blend takes four signals per row: cosine, recency, importance, type weight.
// A task supplies its own cosine (from the vector column) and its own recency (created_at).
// The other two have no per-row column on `tasks` today, so they are constants — and a
// per-source constant inside a weighted sum is EXACTLY the shape of defect D1. Both are
// therefore stated with the arithmetic they imply, not just a number.

/**
 * IMPORTANCE for a task row, in [0,1]. DEFAULT 0.5 — the NEUTRAL MIDDLE, and the same value
 * the other two sources land on for an unremarkable row: a context with an unset
 * relevance_score scores COALESCE(relevance_score, 5.0)/10 = 0.5, and a decision with an
 * absent/unrecognised impact_level scores DECISION_IMPACT_IMPORTANCE_DEFAULT = 0.5. So a
 * task contributes identically to a default-importance context and a medium-impact decision,
 * and this term hands out no standing edge or deficit.
 *
 * THIS IS THE BASE the status map below multiplies. `tasks.status` reaches
 * the score HERE and nowhere else — it is excluded from the embed text on purpose (see
 * services/embedding/taskEmbeddingText.ts), so the one fact moves one term.
 *
 * env: SEARCH_MERGE_IMP_TASK_DEFAULT
 */
export const TASK_IMPORTANCE_DEFAULT = envFloat('SEARCH_MERGE_IMP_TASK_DEFAULT', 0.5);

/**
 * TASK STATUS → IMPORTANCE WEIGHT. A MULTIPLIER on
 * TASK_IMPORTANCE_DEFAULT per `tasks.status`, so `importance = clamp01(base × weight)`.
 *
 * EVERY DEFAULT IS 1.0 — the hard rule from the plan. At 1.0 the map is the identity and
 * the score is byte-for-byte what it was before the map existed; a status only moves a task
 * once an operator sets a weight. A non-1.0 default here would be the constant handicap or
 * bonus the tranche-A rewrite deleted, back under a new name.
 *
 * THE BOUND THIS IMPLIES: the importance term carries RANK_WEIGHTS.balanced.importance
 * (0.10 shipped) and the product is clamped to [0,1], so the largest swing any weight can
 * produce is (1.0 − 0) × 0.10 = 0.10 of final score, and from the 0.5 base a weight ≥ 2
 * saturates. It is a tiebreaker between near-equal cosines, never enough to beat a real
 * semantic gap — that is the design constraint, not an accident.
 *
 * READ PER CALL, not at import: the contract test flips a weight through the real env var
 * and restores it, which an import-time read would make impossible without a module reload.
 * The five keys are the literal `tasks.status` vocabulary (middleware/validation.ts
 * taskStatusEnum); an unknown or absent status takes weight 1.0.
 *
 * env: one per status, listed in TASK_STATUS_IMPORTANCE_ENV.
 */
export const TASK_STATUS_IMPORTANCE_ENV: Readonly<Record<string, string>> = Object.freeze({
  todo: 'SEARCH_MERGE_IMP_TASK_STATUS_TODO',
  in_progress: 'SEARCH_MERGE_IMP_TASK_STATUS_IN_PROGRESS',
  blocked: 'SEARCH_MERGE_IMP_TASK_STATUS_BLOCKED',
  completed: 'SEARCH_MERGE_IMP_TASK_STATUS_COMPLETED',
  cancelled: 'SEARCH_MERGE_IMP_TASK_STATUS_CANCELLED',
});

export const TASK_STATUS_IMPORTANCE_WEIGHT_DEFAULT = 1.0;

/** The multiplier for one status: the env value when set and finite, else 1.0. */
export function taskStatusImportanceWeight(status: string | null | undefined): number {
  const envName = status ? TASK_STATUS_IMPORTANCE_ENV[status] : undefined;
  if (!envName) return TASK_STATUS_IMPORTANCE_WEIGHT_DEFAULT;
  return envFloat(envName, TASK_STATUS_IMPORTANCE_WEIGHT_DEFAULT);
}

/** The task's IMPORTANCE signal, in [0,1]: the base scaled by its status weight. */
export function taskImportance(status: string | null | undefined): number {
  const v = TASK_IMPORTANCE_DEFAULT * taskStatusImportanceWeight(status);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : TASK_IMPORTANCE_DEFAULT;
}

/**
 * TYPE-WEIGHT signal for a task row, in [0,1]. DEFAULT 0.5 — the neutral middle of the
 * signal's own range.
 *
 * ⚠️ CALIBRATION CHOICE, NOT A DERIVATION — SAY SO RATHER THAN DRESS IT UP. The decision
 * source's 0.9 WAS derived: `decision` is a context_type and handlers/context.ts's
 * TYPE_WEIGHT_CASE already prices that kind at 0.9, so the decision source inherited a
 * number the system had already committed to. `task` is NOT a context_type — it appears
 * nowhere in that table — so the table has no opinion about it and there is nothing to
 * inherit. Its ELSE branch (0.4) is the answer for an unlisted CONTEXT TYPE, not a verdict
 * about tasks, and taking it would be borrowing authority the table does not have.
 *
 * THE ARITHMETIC THIS IMPLIES, stated so nobody has to rediscover it. The type term carries
 * weight RANK_WEIGHTS.balanced.typeWeight (0.10 shipped), so against a decision (0.9) a task
 * runs (0.9 − 0.5) × 0.10 = 0.04 of final score behind on this term alone, and against
 * contexts (0.4 … 1.0 by type) it runs between +0.01 ahead and −0.05 behind. Measured
 * context cosines run 0.32–0.67 and enter at weight 0.75, so 0.04 is roughly the gap between
 * two rows six cosine points apart — real, not negligible.
 *
 * NOT MEASURED. Nothing in this task measured which value ranks best; the retrieval harness
 * has no task-bearing probe set yet. It is env-overridable without a code edit, and the
 * source's participation is separately revertable via SMART_SEARCH_DEFAULT_SOURCES, so a
 * measurement that disagrees with this can be acted on without touching schema or vectors.
 *
 * env: SEARCH_MERGE_TYPEWEIGHT_TASK
 */
export const TASK_TYPE_WEIGHT = envFloat('SEARCH_MERGE_TYPEWEIGHT_TASK', 0.5);
