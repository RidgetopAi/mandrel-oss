/**
 * Mandrel Core — SEARCH id-prefix / partial-tag config.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every tunable lives HERE — a named value with a sane default + a one-line comment +
 * an env override — never a literal buried in a handler. Mirrors the existing
 * config-driven patterns in the tree (RECALL_CONCISE_MAXLEN in config/recallConfig.ts;
 * MIN_SHORT_ID_LENGTH in utils/idResolver.ts).
 *
 * Governs the id-prefix lookup + partial-tag matching that decision_search (and any
 * future search caller) layers onto its free-text query. The contract intentionally
 * MIRRORS the in-package idResolver (utils/idResolver.ts) so the search box behaves
 * the same way the by-id mutate/detail tools do — the difference is search ADMITS many
 * matches (a prefix legitimately returns a result set) where resolveEntityId demands
 * exactly one.
 *
 * Reads env at module load with a safe fallback (bad/missing → the default), exactly
 * like config/recallConfig.ts:envInt.
 */

/**
 * The id-prefix floor DEFAULT. This is the SAME value as idResolver.MIN_SHORT_ID_LENGTH
 * (8) — the floor the by-id resolver enforces — held as a local literal ONLY to avoid a
 * module-init cycle (idResolver imports this config; this config importing idResolver back
 * would read MIN_SHORT_ID_LENGTH inside its TDZ → ReferenceError). The id-resolution
 * LOGIC is not duplicated (idResolver remains the single source); only this one integer
 * default is mirrored. Keep the two in step if MIN_SHORT_ID_LENGTH ever changes.
 */
const ID_PREFIX_FLOOR_DEFAULT = 8;

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Minimum length of a DASH-STRIPPED hex prefix before a search query is treated as an
 * id-prefix lookup at all. Below this floor a short alphanumeric query is plain text
 * only (so e.g. "ab" never floods the predicate with id matches).
 *
 * DEFAULT mirrors idResolver.MIN_SHORT_ID_LENGTH (8) — the SAME floor the by-id resolver
 * enforces (see ID_PREFIX_FLOOR_DEFAULT above for why it's a local literal, not an import).
 * The task allows tuning this down to 6; do it via the env override below, never a code edit.
 * env: SEARCH_ID_PREFIX_MIN_LENGTH
 */
export const SEARCH_ID_PREFIX_MIN_LENGTH = envInt(
  'SEARCH_ID_PREFIX_MIN_LENGTH',
  ID_PREFIX_FLOOR_DEFAULT,
);

/**
 * Hard cap on rows an ambiguous id-prefix match may pull, so an absurdly short prefix
 * can never drag unbounded rows into the OR predicate. Mirrors the resolver's LIMIT 25
 * ambiguity guard. env: SEARCH_ID_MAX_CANDIDATES
 */
export const SEARCH_ID_MAX_CANDIDATES = envInt('SEARCH_ID_MAX_CANDIDATES', 25);

/**
 * How many id-shaped TOKENS a single free-text query may contribute to the id-lookup arm
 * (an earlier task — "an id8 inside a sentence does not resolve").
 *
 * WHY A CAP EXISTS AT ALL. The id arm used to be gated on the WHOLE query being id-shaped,
 * so a query contributed at most ONE id predicate by construction. Extracting tokens removes
 * that natural bound: a pasted wall of ids would emit one `LIKE` per token into the same
 * OR-predicate, and the cost of a search query would become a function of what the user
 * pasted into it. This is the bound that replaces the one the whole-query gate provided.
 *
 * WHY 4. A person referencing records in a sentence names one, occasionally two ("does <id8>
 * supersede <id8>?"); four leaves headroom without letting the predicate grow unbounded.
 * Tokens beyond the cap are DROPPED, never merged — the query still runs, it simply stops
 * adding id arms. env: SEARCH_ID_MAX_QUERY_TOKENS
 */
export const SEARCH_ID_MAX_QUERY_TOKENS = envInt('SEARCH_ID_MAX_QUERY_TOKENS', 4);

/** Read a finite float env var, falling back to `fallback` on missing/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Score added to a row whose id-prefix / tag MATCHES the search query, so an exact hit ranks
 * at the top (an earlier task — the Contexts half of the class-fix).
 *
 * WHAT THIS BOOST DOES AND DOES NOT GUARANTEE (corrected). It guarantees a
 * matched row is never OUTRANKED by a non-matching one. It does NOT guarantee rank #1: at the
 * boundary the two are EQUAL — an un-embedded id match scores 0 + 1.0 = 1.0 and a perfect
 * semantic match scores 1.0 + 0 = 1.0 — and a tie is settled by the ORDER BY's tiebreaker,
 * not by this constant. This block previously asserted "strictly dominates → always result
 * #1", which read as a proof and was false exactly where it mattered.
 *
 * RAISING THE DEFAULT ABOVE 1.0 WOULD MAKE THE STRONGER CLAIM TRUE, and it is deliberately
 * NOT done here: handlers/smartSearch.ts recovers the decision cosine from the summed score
 * by `cosine = min(1, raw)` / `boost = max(0, raw - 1)`, an inversion that is only correct
 * while the boost is EXACTLY 1. Changing this value is a cross-surface scoring change, not a
 * tiebreaker fix, and does not belong in the same commit as one.
 *
 * WHY 1.0 IS THE RIGHT DEFAULT — it is a structural invariant, not a taste knob. Every
 * ranking score this boost is folded into lives in [0,1]:
 *   - decisions: `search_score` = GREATEST(cosine-sim, word_similarity), both in [0,1];
 *   - contexts (hierarchical): `combined_score` = a WEIGHTED BLEND of four signals each
 *     in [0,1] whose RANK_WEIGHTS sum to 1.0 by default (0.25×4 balanced;
 *     0.05+0.90+0.025+0.025 recency) → the blend is itself in [0,1];
 *   - contexts (baseline): raw cosine `similarity` in [0,1].
 * So +1.0 is at least the maximum attainable score of any non-matching row.
 *
 * It is a NAMED, env-overridable config (never a literal in a handler) because
 * RANK_WEIGHTS are themselves env-tunable: an operator who raises the context weights so
 * they sum to >1 would push `combined_score` above 1 and could shade the boost. Raising
 * this in step restores the invariant WITHOUT a code edit. Keep it >= the maximum
 * attainable score of the profile you run. env: SEARCH_ID_MATCH_SCORE_BOOST
 */
export const SEARCH_ID_MATCH_SCORE_BOOST = envFloat('SEARCH_ID_MATCH_SCORE_BOOST', 1.0);

// ─────────────────────────────────────────────────────────────────────────────────────────
// RESERVED ARG-NAME PREFIXES in a free-text query.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// THE BUG THIS GUARDS: `context_search({ query: 'id:<uuid>' })` READS like query syntax but
// there is no query DSL — the `:` fails HEX_PREFIX_RE, `queryLooksLikeId()` returns false,
// the id-prefix SQL arm is never emitted, and the call degrades to pure semantic noise. The
// caller gets a confident WRONG record: silent, not loud. These names are real PARAMETERS of
// the search tools, so a `name:value` query is always a mistake — we FAIL LOUD and name the
// correct form instead of guessing (see utils/idResolver.reservedArgPrefixInQuery).
//
// DELIBERATELY NOT A DSL (rejected by the coordinator): this ERRORS; it never RESOLVES.
//
// WHY THIS IS PER-TOOL AND NOT ONE FLAT LIST (the sweep, a past incident — fix the class, not the
// instance). Three tools take a free-text `query` and all three share the degradation, but
// they do NOT share the REMEDY, because they do not share parameters:
//
//   context_search   declares `id` → the fix is "use the id PARAMETER".
//   decision_search  has NO `id` parameter → that same advice would be WRONG and would earn
//                    a strict-mode rejection. Its `query` DOES accept a BARE id token (the
//                    id-prefix gate), so the fix is "drop the prefix".
//   smart_search     has no `id` either, and delegates into BOTH engines above — so it
//                    inherits the same gate transitively, with the same drop-the-prefix fix.
//
// A wrong remedy is worse than no remedy: it is the same "the product teaches the misread"
// failure we are here to kill. So ONE mechanism, configured per tool — never one mechanism
// per tool (that is the N-drifting-copies disease).

// THE SWEEP — which tools are guarded, and WHY THE REST ARE NOT.
// 3 of the 54 flat tools accept a free-text `query`: context_search, decision_search,
// smart_search. All three are guarded above. Ruled out, with reasons:
//   - task_list / task_details, project_list / project_info / project_insights,
//     context_get_recent, recall_thread — no free-text query parameter at all
//     (structured filters and ids only), so the misuse shape cannot arise.
//   - get_recommendations — DELIBERATELY UNGUARDED. See below; the first written rationale
//     for this was WRONG and is corrected here so future work does not inherit it.
//
// get_recommendations, the honest version (Reviewer caught two false claims in the
// original rationale — it was said to have "no remedy to offer" and not to delegate into a
// search engine; BOTH are untrue). The facts:
//   - it DOES declare a `type` enum (naming|implementation|architecture|testing), so `type:`
//     would have an exact remedy; and
//   - handlers/smartSearch.ts DOES pass `context` straight into
//     contextHandler.searchContext({ query: context }) — the same transitive inheritance
//     used to justify guarding smart_search.
// It is still left unguarded, for two reasons that DO hold:
//   1. FALSE POSITIVES ARE REAL HERE. `context` is free prose ("What you are working on"),
//      not a lookup query, and a whitespace-free `word:token` is plausible LEGITIMATE input
//      in that field — `type:checking`, `auth:login`, `feat:onboarding` are all natural
//      things to write. Our matcher would reject those as misuse. A search `query` does not
//      have that problem; a prose description does.
//   2. LOWER SEVERITY. The guard exists to stop a silent CONFIDENT WRONG RECORD. This tool
//      never promises to return a specific record — it returns suggestions — so the failure
//      mode degrades to "less relevant recommendations", not "the wrong answer, stated
//      confidently".
// Net: guarding it would trade a low-severity degradation for a real false-positive risk on
// a prose field. Revisit if `context` ever becomes a lookup-shaped parameter.

/** How to steer a caller who typed a reserved prefix into `query`. */
export type ReservedPrefixRemedy =
  /** The prefix IS a real parameter of this tool → pass it as that parameter. */
  | { readonly kind: 'parameter'; readonly param: string }
  /** Not a parameter here, but the BARE token is supported in `query` → drop the prefix. */
  | { readonly kind: 'bare-token' }
  /** Reserved by env override with no known remedy → generic "not query syntax" guidance. */
  | { readonly kind: 'generic' };

/**
 * prefix → remedy, per tool. Code-owned because a remedy requires knowing the tool's real
 * parameters; an env list alone cannot supply one (see envList override below).
 *
 * SCOPING RULE — a name earns a place here only if BOTH (a) an agent plausibly types it as
 * `name:value` (retrieval-shaped filters: id/type/tags/status/…), and (b) we can name a
 * CORRECT remedy. Names like `limit:` or `projectId:` are omitted deliberately: nobody types
 * them into a query, and reserving them would only manufacture false positives.
 */
const RESERVED_QUERY_PREFIXES_TABLE: Record<string, Record<string, ReservedPrefixRemedy>> = {
  context_search: {
    id: { kind: 'parameter', param: 'id' },
    type: { kind: 'parameter', param: 'type' },
    tags: { kind: 'parameter', param: 'tags' },
  },
  decision_search: {
    // NO `id` parameter on this tool — the bare token is the supported form.
    id: { kind: 'bare-token' },
    tags: { kind: 'parameter', param: 'tags' },
    status: { kind: 'parameter', param: 'status' },
    component: { kind: 'parameter', param: 'component' },
    decisionType: { kind: 'parameter', param: 'decisionType' },
    // `type:` is the name an agent reaches for first; the real parameter is decisionType.
    type: { kind: 'parameter', param: 'decisionType' },
    impactLevel: { kind: 'parameter', param: 'impactLevel' },
    outcomeStatus: { kind: 'parameter', param: 'outcomeStatus' },
  },
  smart_search: {
    id: { kind: 'bare-token' },
    // The real parameter is includeTypes (which data sources to search).
    type: { kind: 'parameter', param: 'includeTypes' },
    includeTypes: { kind: 'parameter', param: 'includeTypes' },
    // NOTE: `tags:` is deliberately NOT reserved here — smart_search has no tag support at
    // all, so there is no correct remedy to offer. Reserving it would trade a silent wrong
    // answer for a confidently wrong instruction. Revisit if smart_search gains tags.
  },
};

export const RESERVED_QUERY_PREFIXES_BY_TOOL: Readonly<
  Record<string, Readonly<Record<string, ReservedPrefixRemedy>>>
> = Object.freeze(RESERVED_QUERY_PREFIXES_TABLE);

/**
 * GUARD THE GUARD (a past incident — a config knob is an attack surface on its own feature).
 *
 * These are LEGITIMATE prefixes in our tag grammar. `ref:resume` is how the boot ritual
 * resolves the live handoff; `task:`/`decision:`/`context:` thread records together. They are
 * matched by the partial-tag substring arm and MUST keep working as free-text queries on
 * EVERY surface. Reserving one would turn a supported, in-use pattern into a hard error and
 * break the boot ritual — so neither the table above nor any env override may contain one. A
 * violation throws at module load rather than being silently dropped: a silent drop is the
 * allow-by-default disease (you would think you configured something you did not).
 */
const PROTECTED_TAG_GRAMMAR_PREFIXES = [
  'ref', 'task', 'decision', 'context', 'scope', 'owner', 'tranche',
];

/**
 * A reserved prefix must be a plain PARAMETER NAME. Enforced at module load (below).
 *
 * WHY THIS IS A SECURITY CONTROL, not tidiness (Reviewer REJECT): the name
 * used to be interpolated into `new RegExp(\`^${name}\\s*:…\`)` UNESCAPED, while the
 * tag-grammar protection compared LITERAL strings. So a metacharacter name slipped past the
 * literal check and then matched as a PATTERN:
 *   SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH='[a-z]+'  → no throw, and `ref:resume`
 *   was reported as reserved → the boot ritual breaks. Exactly what the protection exists to
 *   make impossible ("real, not decorative" was, against a non-literal name, decorative).
 *   SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH='id,['    → SyntaxError per CALL, inside
 *   the route's try/catch — a request-time crash instead of a fail-closed abort at boot.
 * Both reproduced before the fix. Validating the SHAPE at load kills both at once, and the
 * matcher no longer builds a regex from the name at all (defense in depth).
 */
const RESERVED_PREFIX_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Resolve one tool's reserved-prefix NAMES, and say where they came from.
 *
 * ENV SEMANTICS — the override REPLACES the code table for that tool, it does NOT extend it.
 * That is deliberate (it must be possible to NARROW the set), but it is a footgun worth
 * knowing: a typo'd or partial override silently UN-guards everything it omits — e.g.
 * `SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH='typo'` leaves `id:` unguarded and back to
 * degrading silently. Set the full intended list, never a delta.
 */
function resolveNames(tool: string, table: Record<string, ReservedPrefixRemedy>): {
  names: string[];
  source: string;
} {
  const envVar = envVarNameFor(tool);
  const raw = process.env[envVar]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') {
    return {
      names: Object.keys(table),
      source: `RESERVED_QUERY_PREFIXES_BY_TOOL.${tool} (code table)`,
    };
  }
  return {
    names: raw.split(',').map((x) => x.trim()).filter((x) => x !== ''),
    source: `${envVar} (env override)`,
  };
}

/** `context_search` → `SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH`. */
function envVarNameFor(tool: string): string {
  return `SEARCH_RESERVED_QUERY_PREFIXES__${tool.toUpperCase()}`;
}

/**
 * The EFFECTIVE reserved-prefix map per tool: the code-owned table above, optionally
 * REPLACED per tool by env (see resolveNames for the replace-not-extend semantics). An
 * env-supplied name absent from the code table still gets a `generic` remedy — honest, if
 * less specific.
 *
 * TWO fail-closed gates run over EVERY effective name, from EITHER source, so neither code
 * nor env can weaken the guard:
 *   1. SHAPE — must be a plain parameter name (RESERVED_PREFIX_NAME_RE). Kills regex
 *      injection and malformed-name crashes.
 *   2. COLLISION — must not be a protected tag-grammar prefix. Keeps `ref:resume` queryable.
 * Each error names the ACTUAL source (code table vs the specific env var) so the next
 * debugger is not sent to the wrong place.
 */
export const RESERVED_QUERY_PREFIXES_EFFECTIVE: Readonly<
  Record<string, Readonly<Record<string, ReservedPrefixRemedy>>>
> = (() => {
  const out: Record<string, Record<string, ReservedPrefixRemedy>> = {};
  for (const [tool, table] of Object.entries(RESERVED_QUERY_PREFIXES_TABLE)) {
    const { names, source } = resolveNames(tool, table);

    const malformed = names.filter((n) => !RESERVED_PREFIX_NAME_RE.test(n));
    if (malformed.length > 0) {
      throw new Error(
        `${source} contains invalid reserved-prefix name(s): ${malformed.map((m) => JSON.stringify(m)).join(', ')}. ` +
        `A reserved prefix must be a plain parameter name matching ${RESERVED_PREFIX_NAME_RE} ` +
        `(letter, then letters/digits/underscore). Names are matched LITERALLY, never as a ` +
        `pattern — a metacharacter name would otherwise slip past the tag-grammar protection ` +
        `and could reserve 'ref:', breaking the boot ritual.`,
      );
    }

    const collisions = names.filter((n) => PROTECTED_TAG_GRAMMAR_PREFIXES.includes(n.toLowerCase()));
    if (collisions.length > 0) {
      throw new Error(
        `${source} may not reserve tag-grammar prefixes: ${collisions.join(', ')}. ` +
        `These resolve real tags (e.g. 'ref:resume' drives the boot ritual) and must stay ` +
        `queryable. Remove them.`,
      );
    }

    const built: Record<string, ReservedPrefixRemedy> = {};
    for (const n of names) built[n] = table[n] ?? { kind: 'generic' };
    out[tool] = Object.freeze(built);
  }
  return Object.freeze(out);
})();

/** Exposed for the contract test that proves the protection above is real, not decorative. */
export const SEARCH_PROTECTED_TAG_GRAMMAR_PREFIXES: readonly string[] =
  Object.freeze(PROTECTED_TAG_GRAMMAR_PREFIXES);

// ─────────────────────────────────────────────────────────────────────────────────────────
// TIME WINDOW READ FROM THE QUERY TEXT.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// "What happened overnight on 2026-10-22 with the flake punch?" names a WINDOW, and the
// date used to be ignored — the other night's identically-titled records outranked the one
// asked about. smart_search now reads an ISO date (and optional night word) out of the query
// and constrains results to it. See services/searchTimeWindow.ts for the pure parser.

/** Read a string env var, falling back to `fallback` on missing/blank. */
function envString(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** Read an hour-of-day env var (integer 0..23), falling back on missing/garbage. */
function envHour(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
}

/** True when `tz` is an IANA zone this runtime's Intl can resolve. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The timezone a date in a query is read in ("the night of 2026-10-22" means THAT zone's
 * night). An unresolvable name FALLS BACK to UTC rather than throwing at module load — the
 * search must keep working — and the fallback is visible in SEARCH_TIME_ZONE_SOURCE.
 * env: SEARCH_TIME_ZONE   (IANA name, e.g. America/New_York)
 */
const SEARCH_TIME_ZONE_RAW = envString('SEARCH_TIME_ZONE', 'UTC');
export const SEARCH_TIME_ZONE: string = isValidTimeZone(SEARCH_TIME_ZONE_RAW) ? SEARCH_TIME_ZONE_RAW : 'UTC';
export const SEARCH_TIME_ZONE_SOURCE: string = isValidTimeZone(SEARCH_TIME_ZONE_RAW)
  ? (process.env.SEARCH_TIME_ZONE ? 'env SEARCH_TIME_ZONE' : 'default')
  : `default (SEARCH_TIME_ZONE=${JSON.stringify(SEARCH_TIME_ZONE_RAW)} is not a valid IANA zone)`;

/**
 * Words that turn a bare date D into a NIGHT window. Matched case-insensitively on word
 * boundaries, longest phrase first, and removed from the query along with the date.
 * env: SEARCH_NIGHT_WORDS (comma-separated; REPLACES this list)
 */
const NIGHT_WORDS_DEFAULT = ['last night', 'night of', 'overnight', 'night'];
export const SEARCH_NIGHT_WORDS: readonly string[] = Object.freeze(
  (() => {
    const raw = process.env.SEARCH_NIGHT_WORDS; // env-read: via-callers
    if (raw === undefined || raw.trim() === '') return NIGHT_WORDS_DEFAULT;
    const words = raw.split(',').map((w) => w.trim().toLowerCase()).filter((w) => w !== '');
    return words.length > 0 ? words : NIGHT_WORDS_DEFAULT;
  })(),
);

/**
 * A night window runs from (D-1) at this local hour … env: SEARCH_NIGHT_START_HOUR (0-23, default 18)
 * so "the evening of D" falls inside, and to (D+1) at SEARCH_NIGHT_END_HOUR (default 12) so
 * "the early hours of D" and a late finish on D both fall inside.
 */
export const SEARCH_NIGHT_START_HOUR = envHour('SEARCH_NIGHT_START_HOUR', 18);
/** See SEARCH_NIGHT_START_HOUR. env: SEARCH_NIGHT_END_HOUR */
export const SEARCH_NIGHT_END_HOUR = envHour('SEARCH_NIGHT_END_HOUR', 12);

/**
 * When a window is active, each source is over-fetched by this extra factor because the
 * window is applied AFTER retrieval and discards rows; without headroom a window with a
 * crowded neighbourhood could be emptied by out-of-window rows filling the pool.
 * env: SEARCH_WINDOW_OVERFETCH_FACTOR
 */
export const SEARCH_WINDOW_OVERFETCH_FACTOR = envInt('SEARCH_WINDOW_OVERFETCH_FACTOR', 5);
