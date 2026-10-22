/**
 * attributionNoticeConfig — the knobs for the UNATTRIBUTED-WRITE NOTICE.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * Measured on a live customer tenant 2026-09-09: contoso has **42 sessions** on the flagged
 * `anonymous` fallback (last 2026-09-06) against **2** that ever carried his actor (last
 * 2026-08-29). He believes he is configured. His tenant runs
 * `MANDREL_SESSION_REQUIRE_ACTOR=false` — a deliberate waiver — so his writes SUCCEED and
 * say nothing at all. Every record he creates is indistinguishable from every other
 * anonymous caller's, and he has no way to find that out.
 *
 * We already shipped the caller-identity echo on ping (v0.57.0, services/callerEcho.ts) and
 * verified it live on his own container, both directions. **It still failed him**, because
 * his MCP client SUMMARISED the tool result: it kept the headline ("Status: Operational")
 * and dropped the identity line that followed the newline. What he reported back was
 * "Mandrel is operational. Pong received successfully." — a string that exists nowhere in
 * this codebase.
 *
 * THE DESIGN LESSON THAT DRIVES THIS MODULE, and it is the thing to preserve if you edit
 * the message: **a line that reads as STATUS gets summarised away by an LLM client; a line
 * that reads as an INSTRUCTION ADDRESSED TO THE AGENT gets relayed**, because relaying
 * instructions is what the agent believes its job to be. And a warning must LEAD, never
 * trail — a summariser keeps the first line and discards the tail.
 *
 * ── THE STANDING RULE THIS FILE OBEYS ──────────────────────────────────────────────────
 * NO HARDCODED VARIABLES (the operator, binds every build). Every tunable the notice touches lives
 * HERE: a named value, a default, a documented env override. Never a literal buried in the
 * service or the route. Mirrors sessionConfig.ts / autoThreadConfig.ts.
 *
 * ── THE KNOBS ──────────────────────────────────────────────────────────────────────────
 *   MANDREL_ATTRIBUTION_NOTICE_ENABLED    (bool, default TRUE)
 *       The kill switch. Off ⇒ nothing is ever attached and no suppression state is
 *       touched; the response is byte-identical to before this feature.
 *   MANDREL_ATTRIBUTION_SUGGESTED_ACTOR   (string, default UNSET)
 *       The actor value to SUGGEST in the message. Unset ⇒ the literal placeholder
 *       `<your-name>` is used, which is the honest answer for a multi-user instance: we do
 *       not know who this caller is — that is the whole defect. A single-tenant deployment
 *       (contoso's) can set it to the one name that is correct there and turn the message
 *       into copy-paste instructions.
 *   MANDREL_ATTRIBUTION_NOTICE_SETUP_URL  (string, default UNSET)
 *       Where per-client setup instructions live. Unset ⇒ the "Setup instructions" line is
 *       OMITTED from the notice entirely rather than pointing at a host this deployment does
 *       not own; set it to your own published setup page to turn the line on.
 *   MANDREL_ATTRIBUTION_NOTICE_DEADLINE   (string, default UNSET)
 *       A date/phrase after which unattributed writes will be REJECTED. Unset ⇒ the
 *       deadline sentence is OMITTED entirely rather than rendered empty: announcing a
 *       deadline we have not set is the kind of true-sounding sentence nobody can act on.
 *       Set it in the same change that schedules the flip of MANDREL_SESSION_REQUIRE_ACTOR.
 *   MANDREL_ATTRIBUTION_NOTICE_TTL_MS     (int ms, default 6h)
 *       The once-per-window suppression. A notice on EVERY write would be noise a client
 *       learns to strip; once per working session is a nag that still gets relayed.
 *   MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS   (int, default 5000)
 *       Hard bound on the in-memory suppression map. This is a long-lived server process
 *       and connection ids are attacker-supplied strings, so the map MUST NOT grow without
 *       limit (C5). At the bound, oldest-first eviction: the worst case is that a caller
 *       gets the notice again, which is the safe direction to fail.
 */

/** Read a boolean env var, falling back to `fallback` on missing/garbage. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a non-empty string env var, falling back to `fallback` on missing/blank.
 * `null` fallback is meaningful: "unset" is a distinct, rendered-differently state, not an
 * empty string to be interpolated (C1's third state — absent is not the same as empty).
 */
function envStr(name: string, fallback: string | null): string | null {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined) return fallback;
  const v = raw.trim();
  return v === '' ? fallback : v;
}

/**
 * ⚠️ THE ENV NAME IS PASSED AS A STRING LITERAL AT EACH CALL SITE BELOW, AND MUST STAY THAT
 * WAY. This file used to route all six through an `ATTRIBUTION_NOTICE_ENV` constant object —
 * tidier to read, and it turned the clean gate RED (STAGE 0a5, ref b381b98a): the env-read
 * accounting guard extracts env var NAMES statically and fails closed on any it cannot
 * resolve, and `envBool('MANDREL_ATTRIBUTION_NOTICE_ENABLED', …)` is "a via-callers helper called
 * with a COMPUTED first arg (the name escapes extraction)". Six FAIL lines, one per knob.
 *
 * That guard is what lets the gate answer "which env names does this repo read?" without
 * running the code, and every downstream net (the product-prefix check, the .env.example
 * surface, the passthrough list) is applied to the names IT extracts. An indirection that
 * hides a name does not just annoy the guard — it removes the name from the population
 * every other env check reasons about. So: literal name first argument, always. The
 * DEFAULTS stay named constants; it is only the NAME that must be a literal.
 */

/** The default setup destination — none; the notice omits the line. See the header. */
export const DEFAULT_ATTRIBUTION_SETUP_URL = '';

/** Default suppression window: 6 hours, in milliseconds. */
export const DEFAULT_ATTRIBUTION_NOTICE_TTL_MS = 6 * 60 * 60 * 1000;

/** Default bound on the suppression map. */
export const DEFAULT_ATTRIBUTION_NOTICE_MAX_KEYS = 5000;

export interface AttributionNoticeConfig {
  /** Master switch. Off ⇒ the feature is inert end to end. */
  enabled: boolean;
  /** Actor to suggest, or null ⇒ render the literal `<your-name>` placeholder. */
  suggestedActor: string | null;
  /** Where the per-client setup instructions live. */
  setupUrl: string;
  /** Deadline phrase, or null ⇒ omit the deadline sentence entirely. */
  deadline: string | null;
  /** Once-per-window suppression, in ms. */
  ttlMs: number;
  /** Hard bound on the suppression map (oldest-first eviction at the bound). */
  maxKeys: number;
}

/**
 * MUTABLE ON PURPOSE, exactly like SESSION_CONFIG: env is read once at module load (the
 * deployment's answer), and a test provisions a non-default by assigning to the field and
 * restoring it. That keeps ONE resolution path in production while staying testable
 * without re-import gymnastics.
 */
export const ATTRIBUTION_NOTICE_CONFIG: AttributionNoticeConfig = {
  enabled: envBool('MANDREL_ATTRIBUTION_NOTICE_ENABLED', true),
  suggestedActor: envStr('MANDREL_ATTRIBUTION_SUGGESTED_ACTOR', null),
  setupUrl: envStr('MANDREL_ATTRIBUTION_NOTICE_SETUP_URL', DEFAULT_ATTRIBUTION_SETUP_URL) ?? DEFAULT_ATTRIBUTION_SETUP_URL,
  deadline: envStr('MANDREL_ATTRIBUTION_NOTICE_DEADLINE', null),
  ttlMs: envInt('MANDREL_ATTRIBUTION_NOTICE_TTL_MS', DEFAULT_ATTRIBUTION_NOTICE_TTL_MS),
  maxKeys: envInt('MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS', DEFAULT_ATTRIBUTION_NOTICE_MAX_KEYS),
};
