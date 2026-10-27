/**
 * THE ONE VOLUME VOCABULARY for every read tool (SEARCH P3).
 *
 * Before this module there were THREE names for one idea and a fourth on the way:
 *   context_search / context_get_recent  response_format: concise | detailed
 *   recall_thread                        altitude:        headline | summary | full
 *   recall_thread structured channel     MANDREL_RECALL_STRUCTURED_MODE: full | lean
 *   smart_search                         (no dial at all — always full bodies)
 * They are now ONE parameter, `altitude`, with the SAME three values on all four tools.
 * The semantics are recall_thread's, taken rather than invented (they already had a pure,
 * DB-free implementation and a clip affordance that names an argument).
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. Every knob this vocabulary
 * introduces — the per-tool default altitude, the per-tool snippet budget, the trust score
 * precision — is a named value here with an env override, never a literal in a route.
 *
 * WHY THE DEFAULT IS PER-TOOL AND NOT ONE CONSTANT. `RECALL_DEFAULT_FORMAT` was
 * deliberately flipped BACK to `detailed` because a lean default made the
 * DEFAULT read path return packaging instead of records. That finding is about
 * context_search/context_get_recent and it still stands, so their default altitude is
 * `full` — the same behaviour they ship today, said in the new words. smart_search, which
 * has never had a dial and returns whole bodies for every one of up to 100 rows, defaults
 * to `summary` (an earlier task scope item 1). recall_thread keeps its own `summary`.
 * One VOCABULARY does not mean one DEFAULT; it means one parameter with one meaning.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a string env var, falling back to `fallback` on missing/empty. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw;
}

/** Read a non-negative-integer env var (0 is legal), falling back on missing/garbage. */
function envIntZeroOk(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/**
 * THE THREE ALTITUDES — the whole zoom axis, defined ONCE.
 *
 *   headline — identity + trust only. NO body key at all (absent, not empty).
 *   summary  — headline PLUS the body clipped to the tool's configured snippet budget,
 *              with the clipped-N-more affordance.
 *   full     — headline PLUS the whole, untruncated body.
 *
 * Every zod enum, every route, every projection and every doc string derives from this
 * array. An off-axis value is a LOUD THROW, never a silent fall-through to a default
 *: a caller who asked for `brief` and got `summary` was told nothing.
 */
export const ALTITUDES = ['headline', 'summary', 'full'] as const;
export type Altitude = (typeof ALTITUDES)[number];

/** Is this string one of the three altitudes? */
export function isAltitude(value: unknown): value is Altitude {
  return typeof value === 'string' && (ALTITUDES as readonly string[]).includes(value);
}

/** Read an env var constrained to ALTITUDES, falling back on missing/garbage. */
function envAltitude(name: string, fallback: Altitude): Altitude {
  const raw = process.env[name]; // env-read: via-callers
  return isAltitude(raw) ? raw : fallback;
}

/**
 * THE DEPRECATED ALIAS (backward compatibility).
 *
 * `response_format` is a SHIPPED parameter on a surface customer instances are running, so
 * it is still ACCEPTED and mapped here — but it is absent from the advertised schema
 * description, and `altitude` is the advertised parameter. Retiring the NAME from the
 * surface is what was asked for; breaking a live caller mid-sentence was not.
 */
export const RESPONSE_FORMAT_TO_ALTITUDE: Readonly<Record<string, Altitude>> = Object.freeze({
  concise: 'summary',
  detailed: 'full',
});

/**
 * Resolve the effective altitude for a call: explicit `altitude` wins, then the deprecated
 * `response_format` alias, then the tool's configured default.
 *
 * PRECEDENCE IS EXPLICIT-OVER-ALIAS, not "last one wins": a caller that passes both has
 * stated the new vocabulary, and the alias exists only for callers that have not been
 * updated. An UNRECOGNIZED value in either slot throws — validation rejects it first on the
 * real surface, and this is the backstop for every caller zod cannot see.
 */
export function resolveAltitude(
  args: { altitude?: unknown; response_format?: unknown },
  fallback: Altitude,
  where: string
): Altitude {
  if (args.altitude !== undefined && args.altitude !== null) {
    if (!isAltitude(args.altitude)) {
      throw new Error(
        `${where}: altitude ${JSON.stringify(args.altitude)} is not one of ` +
          `${ALTITUDES.join(' | ')}. It is NOT defaulted — an unrecognised zoom level is a ` +
          `caller error, and silently answering a different question is how a wrong record ` +
          `gets read as the right one.`
      );
    }
    return args.altitude;
  }
  const rf = args.response_format;
  if (rf !== undefined && rf !== null) {
    const mapped = typeof rf === 'string' ? RESPONSE_FORMAT_TO_ALTITUDE[rf] : undefined;
    if (!mapped) {
      throw new Error(
        `${where}: response_format ${JSON.stringify(rf)} is not one of ` +
          `${Object.keys(RESPONSE_FORMAT_TO_ALTITUDE).join(' | ')}. response_format is a ` +
          `DEPRECATED alias for altitude (${ALTITUDES.join(' | ')}) — prefer altitude.`
      );
    }
    return mapped;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-TOOL DEFAULTS — one parameter, one meaning, tool-appropriate defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * smart_search's default. It has NEVER had a size dial and returns the WHOLE body of every
 * row (up to `limit`, max 100), which is why it measured 15,498 o200k tokens at limit 10
 * on prod (1,119 prose + 14,379 structured). `summary` is the default because a SEARCH
 * result list is a "which of these do I open" surface, and the id is right there.
 * Env: MANDREL_SMART_SEARCH_DEFAULT_ALTITUDE.
 */
export const SMART_SEARCH_DEFAULT_ALTITUDE: Altitude = envAltitude(
  'MANDREL_SMART_SEARCH_DEFAULT_ALTITUDE',
  'summary'
);

/**
 * The per-row body budget at `summary` for smart_search, in characters.
 *
 * The prose channel previously hard-clipped each row at a LITERAL 80 (`substring(0, 80)`)
 * while the structured channel carried the whole body — the exact "a dial that moves only
 * one channel is not a dial" shape this task exists to end. One budget, applied ONCE, to
 * BOTH channels. Env: MANDREL_SMART_SEARCH_SNIPPET_MAXLEN. Default 280 (the same few
 * sentences recall_thread's summary altitude settled on).
 */
export const SMART_SEARCH_SNIPPET_MAXLEN = envInt('MANDREL_SMART_SEARCH_SNIPPET_MAXLEN', 280);

/**
 * TRUST-ON-THE-WIRE score precision — decimal places (an earlier decision Part 2).
 *
 * `score: 0.9948746744592272` is sixteen digits of false precision on a blended heuristic.
 * 2dp is chosen because it is EXACTLY what the single prose renderer already prints
 * (`explainTrust().scoreText` is `toFixed(2)`), so the two channels state the same number
 * instead of two roundings of it. Env: MANDREL_TRUST_WIRE_SCORE_PRECISION.
 */
export const TRUST_WIRE_SCORE_PRECISION = envIntZeroOk('MANDREL_TRUST_WIRE_SCORE_PRECISION', 2);

/**
 * smart_search's clipped-snippet affordance at `summary`. `{omitted}` is the character count
 * dropped.
 *
 * IT NAMES THE PARAMETER, and that is load-bearing, not style. The sibling affordance in
 * recallConfig.ts previously read `context_search id:<id>` — shorthand for the `id` ARGUMENT
 * that PARSES as query syntax. Agents read it that way, called `context_search({query:
 * 'id:<uuid>'})`, and silently got an unrelated record back; the affordance is emitted on
 * EVERY truncation, so it was actively TEACHING the misread. Do not reintroduce a
 * `tool arg:value` form here. This wording is also SURFACE-NEUTRAL — it names no tool, so it
 * reads correctly on both the flat surface and the gateway.
 * Env: MANDREL_SMART_SEARCH_CLIP_AFFORDANCE.
 */
export const SMART_SEARCH_CLIP_AFFORDANCE = envStr(
  'MANDREL_SMART_SEARCH_CLIP_AFFORDANCE',
  '…[clipped: {omitted} more chars — re-call with altitude: "full" for the whole body]'
);
