/**
 * HYBRID SEARCH — the tunables for P2b: rank fusion, the absent-term veto, and the input
 * bound the JavaScript identifier extractor needs now that it sees caller-supplied queries.
 * (design spike an earlier context.)
 *
 * P2a built the lexical PRIMITIVES and wired none of them in. This file is
 * the config for the phase that wires them in, and it is separate from
 * config/lexicalSearchConfig.ts on purpose: that file answers "how is a lexical token
 * defined and indexed", this one answers "what does search DO with the two channels". The
 * feature flag itself stays where P2a put it (LEXICAL_SEARCH_CONFIG.enabled) so there is
 * one switch, not two.
 *
 * STANDING PRINCIPLE (the operator): no hardcoded variables. Every number below is named here and
 * env-overridable, and every one carries the measurement or the argument that chose it.
 */

import { TRANSIENT_LIMITS } from './fieldLimits.js';

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a NON-NEGATIVE integer env var (0 allowed), falling back on missing/garbage/negative. */
function envNonNegInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** Read a boolean env var ('1'/'true'/'yes' → true), falling back on missing/garbage. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

/** Read a string env var from a closed set, falling back on anything else. */
function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  // NOT `const raw = (process.env[name] || '')…` — that line is shaped like an arrow-function
  // definition (`const NAME = (`), and the clean gate's env classifier derives a via-callers
  // helper's name from exactly that shape. Written the compact way it names the helper `raw`,
  // and every unrelated `something.raw(...)` in the repo is then scanned as a helper call —
  // which turned the authoritative gate RED on `git.raw(['ls-tree', …])` in ChangeService.ts,
  // a file this change never touched. Keep the env read on its own statement.
  const rawValue = process.env[name]; // env-read: via-callers
  const raw = (rawValue || '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * ═══ THE RRF SMOOTHING CONSTANT, AND WHY IT IS NOT THE THING an earlier change REJECTED ═══
 *
 * Reciprocal-rank fusion scores a document as Σ 1/(k + rank_c) over the channels c that
 * returned it. `k` is a constant, and an earlier decision rejected TUNED CONSTANTS, so the
 * distinction has to be stated rather than assumed:
 *
 *  1. IT CANNOT CREATE OR SUPPRESS THE EMPTY STATE. Every k > 0 is finite and positive, so
 *     1/(k+rank) is finite and positive for every returned row and zero for every row no
 *     channel returned. The set of rows with a nonzero fused score is exactly the UNION of
 *     the channels' outputs, for every k. The empty state is decided by BUILD 4's word-list
 *     veto and by whether either channel matched anything at all — never by this number.
 *     That is the property a similarity FLOOR does not have, and it is why P1 measured a
 *     floor to be impossible (14 of 16 correct answers score below the worst false positive)
 *     while this constant is merely a shape.
 *  2. IT IS A RANK DAMPER, NOT A WEIGHT. k controls only how steeply rank 1 outranks rank
 *     10 WITHIN a channel; it applies identically to every channel, so it cannot move the
 *     balance between them. A per-channel weight WOULD be the rejected thing, which is why
 *     there is no per-channel weight in this file.
 *  3. ⚠️ THE SCORE IS INSENSITIVE TO IT. THE ORDER BELOW RANK 1 IS NOT — and that is a
 *     MEASURED FINDING, reported rather than tuned around. The sweep (all three question
 *     sets re-run at k ∈ {1, 10, 30, 60, 120, 600}, 335 question-runs; artifact
 *     reports/artifacts/d8c1f00d-p2b-hybrid/k-sweep.tsv) found:
 *       · EVERY metric identical at every k — exact-token 15/17 hit@1 and 16/17 hit@5,
 *         negatives 12/17 empty, control 12/33 hit@1 and 17/33 hit@5, at all six values;
 *       · rank 1 identical to k=60 on 335 of 335 question-runs — no question changed its
 *         top answer at any k;
 *       · but the ORDER of positions 2-5 moves on the exact-token arm: 11 of 17 questions
 *         keep the k=60 top-5 at k ∈ {1, 10, 30}, 16 of 17 at k=120, 14 of 17 at k=600.
 *         The control and negative arms are 33/33 and 17/17 identical at every k.
 *     WHY, and why it does not make this a tuned constant: a small k makes 1/(k+rank) fall
 *     off steeply, so a row that ONE channel ranked 1st outscores a row two channels ranked
 *     3rd; a large k flattens the curve until agreement between channels dominates. The
 *     exact-token arm is where the channels disagree most (one channel holds an exact
 *     literal match, the other a paraphrase), so it is where the trade is visible. It does
 *     not reach rank 1 because IDENTIFIER PRECEDENCE decides that tier lexicographically,
 *     above the fused score entirely — see identifierPrecedence below.
 *
 * 60 is the value from the paper that introduced RRF (Cormack, Clarke & Buettcher, SIGIR
 * 2009), taken because it is the published default and NOT because it scored best here:
 * every value swept scores exactly the same, so there was nothing to pick a winner by.
 * env: MANDREL_SEARCH_RRF_K
 */
const RRF_K_DEFAULT = 60;

/**
 * THE QUERY LENGTH BOUND for the lexical layer.
 *
 * ═══ THE COST ═══
 * utils/lexicalTokens.extractIdentifiers() is QUADRATIC in a contiguous run of word
 * characters — Node's backtracking engine retries the `file.ext` alternative from every
 * position inside the run. P2a MEASURED it on one run of 'x' (Node 24, the shipped pattern):
 *     8 KB 77 ms | 16 KB 309 ms | 32 KB 1.25 s | 64 KB 5.03 s
 * against 2 ms for the same 64 KB as ordinary spaced words, and 3.5 ms for Postgres's
 * non-backtracking engine on the same input. P2b is the phase that first feeds a
 * CALLER-SUPPLIED string into it, so the phase has to answer for the cost.
 *
 * ⚠️ AND HERE IS WHAT THE OBVIOUS FRAMING GETS WRONG. "A 64 KB query is now a one-line way to
 * burn five seconds of server CPU" is FALSE over the MCP tool surface, and it took a live call
 * to find that out rather than a reading of this code. MEASURED against a running instance:
 *     query = 'x' × 65536  →  MCP error -32602: Input validation failed:
 *                             'query' is too big (maximum 1000 characters)
 * The tool schema already bounds it, from TRANSIENT_LIMITS.searchQuery (config/fieldLimits.ts),
 * for an unrelated reason — the embedder rejects >8000 chars. So no MCP caller could ever have
 * reached the quadratic region.
 *
 * ═══ WHY THE BOUND IS STILL HERE, AND WHY IT IS DERIVED RATHER THAN CHOSEN ═══
 * smartSearchDetailed is called directly as well as through the tool — by routes, by tests,
 * and by whatever internal caller comes next — and this file's own neighbour makes exactly
 * this argument about the unknown-source check: "THE CHOKE POINT IS HERE, not only in the zod
 * schema." A bound that lives only in the validator protects only the callers that go through
 * the validator.
 *
 * So the default is TAKEN FROM the tool surface's own limit rather than being a second number
 * next to it. A separate constant would be a second thing to drift, and it would be wrong in
 * whichever direction it drifted: SMALLER than the schema silently degrades queries the tool
 * accepts, LARGER protects nothing the schema does not already protect. One source, and the
 * relationship is asserted in src/tests/lexicalQueryBound.timing.test.ts rather than trusted.
 * env: MANDREL_SEARCH_LEXICAL_QUERY_MAX_CHARS
 */
const LEXICAL_QUERY_MAX_CHARS_DEFAULT = TRANSIENT_LIMITS.searchQuery.max;

/**
 * How many candidates the lexical channel fetches PER TABLE.
 *
 * Rank fusion only needs enough depth for a row to have a rank; rows past the cut cannot
 * influence the order of rows above them. This mirrors the semantic side's over-fetch
 * (SEARCH_MERGE_OVERFETCH_FACTOR × limit) in intent: fetch more than the caller asked for
 * so the fusion has something to choose between, and cut ONCE at the end.
 * env: MANDREL_SEARCH_LEXICAL_CANDIDATES_PER_TABLE
 */
const LEXICAL_CANDIDATES_PER_TABLE_DEFAULT = 50;

export const HYBRID_SEARCH_CONFIG = {
  /** See RRF_K_DEFAULT above — including why this is not a tuned constant. */
  rrfK: envInt('MANDREL_SEARCH_RRF_K', RRF_K_DEFAULT),

  /** See LEXICAL_QUERY_MAX_CHARS_DEFAULT above. */
  lexicalQueryMaxChars: envInt(
    'MANDREL_SEARCH_LEXICAL_QUERY_MAX_CHARS',
    LEXICAL_QUERY_MAX_CHARS_DEFAULT,
  ),

  /** See LEXICAL_CANDIDATES_PER_TABLE_DEFAULT above. */
  lexicalCandidatesPerTable: envInt(
    'MANDREL_SEARCH_LEXICAL_CANDIDATES_PER_TABLE',
    LEXICAL_CANDIDATES_PER_TABLE_DEFAULT,
  ),

  /**
   * THE PROSE CHANNEL'S MATCH MODE.
   *   'any' — a row matches if it contains ANY content lexeme of the query (OR), ranked by
   *           ts_rank. High recall, and the rank does the discriminating.
   *   'all' — a row matches only if it contains EVERY content lexeme (AND). This is what
   *           plainto_tsquery means, and it is the mode the design spike measured as a
   *           VETO rule. As a RETRIEVAL rule it is high-precision and low-recall: it can
   *           only fire on a query whose words are all present in one record.
   *   'off' — no prose channel at all; fusion is semantic + identifier. The ABLATION, kept
   *           because it is the only way to ask what the prose half is worth.
   *
   * ⚠️ MEASURED, ALL THREE MODES, ALL THREE SETS (reports/artifacts/d8c1f00d-p2b-hybrid/
   * RESULTS-P2b.md). 'any' IS THE MODE THAT ATE THE CONTROL SET, and finding that is the
   * reason this knob exists:
   *              exact-token @1/@5   negatives empty   control @1/@5
   *   pre-P2b          4/17  4/17          0/17         12/33 17/33
   *   'any'           15/17 15/17         12/17          8/33 14/33   ← REGRESSION
   *   'all'           15/17 16/17         12/17         12/33 17/33
   *   'off'           15/17 15/17         12/17         12/33 17/33
   * WHAT ATE IT, since the task asked for the cause rather than a better number: under RRF
   * every channel's rank 1 is worth the same 1/(k+1) no matter how it was earned. An OR
   * query over a paraphrased question matches most of the corpus on its common words, so
   * ts_rank's top row is noise — and that noise arrives carrying the SAME fused weight as
   * the semantic channel's genuine best answer, displacing it. Five control questions lost
   * their home out of the top five that way (D01 D02 D03 D17 D29) and four more slipped a
   * rank. RRF is only as good as its weakest channel's PRECISION; a high-recall channel is
   * not a free addition to it.
   * 'all' is the default: it is ≥ 'off' on every arm (it is worth +1 exact-token hit@5) and
   * costs nothing on the control set, because a conjunctive match cannot fire on a
   * paraphrase at all.
   * env: MANDREL_SEARCH_PROSE_MATCH_MODE
   */
  proseMatchMode: envEnum('MANDREL_SEARCH_PROSE_MATCH_MODE', ['any', 'all', 'off'] as const, 'all'),

  /**
   * IDENTIFIER PRECEDENCE — the answer to "how did you keep an exact identifier hit from
   * being diluted by prose ranking".
   *
   * When true, a record whose `search_idents` contains a literal the caller typed sorts
   * ABOVE every record that has no such match, ordered among themselves by fused rank. It
   * is a LEXICOGRAPHIC TIER, not a weight: no number was chosen, and no value of any
   * constant can trade one against the other.
   *
   * WHY A TIER IS THE RIGHT SHAPE, and not a bigger RRF contribution: an exact match on a
   * rare literal is a LOOKUP, not a similarity estimate. The product already holds that
   * position elsewhere — SEARCH_ID_MATCH_SCORE_BOOST exists precisely so an exact id/tag hit
   * is forced to #1 rather than competing on cosine. This is the same rule for the same
   * reason, applied to the other class of exact literal.
   *
   * MEASURED (reports/artifacts/d8c1f00d-p2b-hybrid/RESULTS-P2b.md), everything else held:
   *   tier ON    exact-token 15/17 hit@1, 16/17 hit@5
   *   tier OFF   exact-token 10/17 hit@1, 15/17 hit@5
   * with the control arm 12/33 and 17/33 and the negatives arm 12/17 in BOTH — the tier
   * costs nothing anywhere else. The five it loses without the tier are questions where the
   * identifier channel's rank 1 and the semantic channel's rank 1 both score exactly
   * 1/(k+1) and the deterministic tie-break (created_at, then id) picks between them on the
   * date. That is the "fusion eating the identifier channel" this task asked to be FOUND
   * rather than tuned around: RRF is scale-free by design, so it cannot know that one of
   * those two rank-1s is an exact literal match and the other is a guess. A tier can.
   * env: MANDREL_SEARCH_IDENTIFIER_PRECEDENCE
   */
  identifierPrecedence: envBool('MANDREL_SEARCH_IDENTIFIER_PRECEDENCE', true),

  /**
   * THE EMPTY-STATE VETO (BUILD 4). Return no rows when a query contains a term that occurs
   * in ZERO records of this project AND is not an ordinary English word.
   *
   * The operator approved the BEHAVIOUR; this flag exists so a bad measurement can be answered in
   * seconds instead of by a revert. Default ON, because off is today's behaviour and today's
   * behaviour is 0/17 on the known-negatives.
   * env: MANDREL_SEARCH_ABSENT_TERM_VETO
   */
  absentTermVeto: envBool('MANDREL_SEARCH_ABSENT_TERM_VETO', true),

  /**
   * ORDINALS ARE ORDINARY WORDS. "7th", "27th", "1st" are digits + st/nd/rd/th: not in the
   * word list and rarely spelled the same way twice ("the 7th" vs "March 7"), yet they are
   * ordinary English, never the name of a thing the corpus lacks. Measured on LongMemEval
   *: two of the four questions the veto wrongly emptied were ordinals.
   * env: MANDREL_SEARCH_ABSENT_TERM_ORDINALS_ORDINARY
   */
  absentTermOrdinalsOrdinary: envBool('MANDREL_SEARCH_ABSENT_TERM_ORDINALS_ORDINARY', true),

  /**
   * MULTI-WORD TOLERANCE — one unfamiliar token does not veto a question whose other terms
   * match. The veto exists for "a query ABOUT a thing we do not have"; in a long question
   * with one stray token (a typo, an identifier the asker quotes) the rest of the question
   * is evidently about things we DO have. The veto is waived only when no more than
   * `absentTermToleratedAbsent` vetoing terms exist AND at least `absentTermToleratedMinMatched`
   * of the query's other content terms occur in the corpus. A short question ("kubernetes
   * setup") has too few matched terms to qualify, so its subject being absent still vetoes.
   * env: MANDREL_SEARCH_ABSENT_TERM_TOLERATED_ABSENT / _TOLERATED_MIN_MATCHED
   */
  absentTermToleratedAbsent: envNonNegInt('MANDREL_SEARCH_ABSENT_TERM_TOLERATED_ABSENT', 1),

  /** How many of a question's other content terms must occur in the corpus before one absent term is tolerated. Short questions fall below it and still veto. */
  absentTermToleratedMinMatched: envInt('MANDREL_SEARCH_ABSENT_TERM_TOLERATED_MIN_MATCHED', 3),

  /**
   * NEAR-MISS SPELLING — an absent term within a small (Damerau-Levenshtein) edit distance of
   * a word in the retrieved records is a misspelling of a corpus term, not an absent thing.
   * Terms shorter than `absentTermNearMissMinLength` are never near-missed (a 3-letter word
   * is one edit from a dozen others); terms of `absentTermNearMissLongLength` or more get
   * the larger allowance.
   * env: MANDREL_SEARCH_NEAR_MISS_MIN_LENGTH / _LONG_LENGTH / _SHORT_DISTANCE / _LONG_DISTANCE
   */
  absentTermNearMissMinLength: envInt('MANDREL_SEARCH_NEAR_MISS_MIN_LENGTH', 5),

  /** Term length at which the larger near-miss edit-distance allowance starts. */
  absentTermNearMissLongLength: envInt('MANDREL_SEARCH_NEAR_MISS_LONG_LENGTH', 9),

  /** Largest edit distance still counted as a near-miss for a term shorter than the long length. */
  absentTermNearMissShortDistance: envInt('MANDREL_SEARCH_NEAR_MISS_SHORT_DISTANCE', 1),

  /** Largest edit distance still counted as a near-miss for a term at or above the long length. */
  absentTermNearMissLongDistance: envInt('MANDREL_SEARCH_NEAR_MISS_LONG_DISTANCE', 2),

  /**
   * Also check a would-be-vetoing term against every word in the whole project, not only the
   * retrieved records, before returning an empty result. Catches a typo whose correct spelling
   * is in a record the search did not retrieve; costs three per-table word-list reads, run
   * only when the search would otherwise come back empty.
   * (~350 ms on contexts alone for a 7.6k-context project when the reads ran sequentially;
   * they now run concurrently — an earlier task.)
   * env: MANDREL_SEARCH_NEAR_MISS_PROJECT_FALLBACK
   */
  absentTermNearMissProjectFallback: envBool('MANDREL_SEARCH_NEAR_MISS_PROJECT_FALLBACK', true),
} as const;

/**
 * THE FUSION CHANNELS. Named here rather than as string literals at the fusion site so the
 * set is stated once and a reader can see how many ranked lists exist without reading the
 * merge.
 *
 * `lexical-ident` and `lexical-prose` are TWO channels, not one, and that split is the
 * mechanism behind the identifier-precedence note above: a row's identifier rank is decided
 * by identifier evidence alone (how many of the caller's literals it contains), never by
 * ts_rank over its prose. One combined lexical list would have ordered an exact identifier
 * hit by how prose-similar the rest of the record happened to be — which is exactly the
 * dilution BUILD 1 forbids.
 */
export const FUSION_CHANNELS = Object.freeze([
  'semantic',
  'lexical-ident',
  'lexical-prose',
] as const);

export type FusionChannel = (typeof FUSION_CHANNELS)[number];

/**
 * The largest fused score any row can reach: top of every channel.
 *
 * Used ONLY to rescale the fused score into [0,1] for display. Rescaling by a CONSTANT is
 * monotone, so it cannot change the order — which is the property that lets smart_search
 * keep its display-consistency invariant (the number shown IS the sort key)
 * without showing callers a raw 0.049.
 */
export function maxFusedScore(k: number = HYBRID_SEARCH_CONFIG.rrfK): number {
  return FUSION_CHANNELS.length / (k + 1);
}
