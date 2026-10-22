/**
 * actorIdentityConfig — the named config for COMPOSITE ACTOR IDENTITY: the rule that a
 * verified OAuth `sub` SCOPES a client-declared handle instead of overriding it
 *.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * The kill switch and the env var NAME it is read from live HERE — a named value with a
 * documented default and an env override — never as a literal buried in actorRegistry.ts.
 * Mirrors config/claimConfig.ts (the kill-switch reference) and config/bridgeAuthConfig.ts
 * (the env-NAME constant + call-time getter): the config is the contract, the code reads it.
 *
 * WHY IT EXISTS (the real-world driver): one human/tenant can run N agents CONCURRENTLY on
 * different projects — Amp-Code orbs, and our own swarm (the coordinator + N Builders + the runtime
 * tick). Today `deriveActor` returns the verified `sub` BEFORE it ever reads the declared
 * `X-Actor-ID`, so on an OAuth tenant those N agents COLLAPSE INTO ONE ACTOR, share one
 * current-project, and silently write into each other's project. The composite actor is the
 * identity primitive that makes per-agent state possible (the state that keys off it is a
 * separate, later task — this config ships the primitive only).
 *
 * SHIPPED DARK. The flag defaults FALSE: with it off, `deriveActor`,
 * `classifyActor`, `normalizeActor` and `isKnownActor` behave EXACTLY as they do on main
 * today — proven by the golden-fixture parity test (tests/actorRegistry.unit.test.ts, oracle
 * captured from the pre-change commit). MERGE, DEPLOY and ENABLE are three separate,
 * individually reversible decisions.
 *
 * Reads happen at CALL TIME (not module load), matching bridgeAuthConfig.ts and matching the
 * module this serves — actorRegistry.ts already reads MANDREL_ACTOR_REGISTRY_EXTRA /
 * MANDREL_ACTOR_DEFAULT_KIND at call time. That keeps one read discipline in the actor stack
 * and lets a test flip the switch without a module reload or a mutable global.
 */

/**
 * The env var NAMES this feature reads. Named constants (not literals buried in the guard)
 * so the provisioner, the deploy notes and the tests reference ONE source of truth.
 */
export const ACTOR_IDENTITY_ENV = {
  /**
   * THE KILL SWITCH. Default FALSE = today's override behavior, byte-for-byte.
   * Set to a truthy token (`1`/`true`/`yes`/`on`) to enable scoped composition, per env.
   */
  COMPOSITE_ENABLED: 'MANDREL_ACTOR_COMPOSITE_ENABLED',
} as const;

/**
 * The delimiter that joins the verified principal to the declared handle:
 * `<sub>` + `/` + `<declared>`.
 *
 * WHY `/` and not `::` — `::` is ALREADY the transport principal key
 * (`remoteMcpTransport.ts`), and overloading one delimiter across two namespaces makes
 * parsing ambiguous exactly where identity must not be ambiguous.
 *
 * WHY THIS IS NOT ENV-TUNABLE (a deliberate exception to no-hardcoded-variables):
 * this character is a SECURITY FLOOR, not a preference. The invariant "an actor string
 * containing the delimiter can only have been produced by server-side composition" holds only
 * if the composer and the declared-segment sanitizer can never disagree about which character
 * that is. An env knob is a second place the rule is written down — i.e. a place one copy can
 * be weakened without the other noticing. One constant, read by both, no second copy.
 */
export const ACTOR_COMPOSITE_DELIMITER = '/';

/**
 * The characters STRIPPED from a client-DECLARED actor segment before it is used.
 *
 * `/` is the composite delimiter (above): a client that could emit it could forge
 * `<someone-elses-sub>/<handle>` and land on another principal's actor. `:` is reserved for
 * the same reason — it is the character the transport principal key is built from, so a
 * declared handle must not be able to spell one.
 *
 * Non-configurable for the same reason as the delimiter: it is the floor, not a preference.
 */
export const ACTOR_RESERVED_DELIMITER_CHARS: readonly string[] = ['/', ':'];

/**
 * What a stripped delimiter is replaced WITH in a DECLARED segment. `-` (not deletion) because
 * the actor vocabulary is a hyphen slug (`deploy-smoke`, `builder-<id8>`) and `normalizeActor`
 * already collapses hyphen runs and trims edge hyphens, so the result stays a well-formed actor.
 */
export const ACTOR_RESERVED_DELIMITER_REPLACEMENT = '-';

/**
 * The escape character for the PRINCIPAL segment (the reviewer N1). The principal is a VERIFIED
 * value we must not lose information from, so — unlike the declared segment, which is merely
 * stripped — it is percent-ENCODED: injective, so two different principals can never encode to
 * the same string.
 *
 * WHY THE PRINCIPAL NEEDS ANY TREATMENT AT ALL: an OAuth `sub` is not guaranteed
 * delimiter-free (an issuer-URL-shaped sub contains `/` and `:`). Left raw, `sub='a/b'` with no
 * declared handle and `sub='a'` with declared handle `b` BOTH produce the actor `a/b` — a
 * genuine CROSS-PRINCIPAL collision, i.e. the one thing this design promises can never happen.
 * Encoding the principal on EVERY path it is emitted removes the ambiguity at the source: an
 * encoded principal contains no raw reserved character, so a composite contains EXACTLY ONE,
 * and "everything before the first delimiter" is always exactly the principal.
 *
 * `%` itself must be encoded FIRST or the mapping is not injective (a literal `%2f` in a sub
 * would otherwise be indistinguishable from an encoded `/`).
 */
export const ACTOR_PRINCIPAL_ESCAPE = '%';

/**
 * THE SHIPPED DEFAULT for the kill switch: OFF (a past incident — the flag defaults to TODAY's
 * behavior, so merging this code changes nothing at runtime). Named rather than inlined so the
 * mutation probe has exactly one thing to flip and the tests have one thing to point at.
 */
export const COMPOSITE_ENABLED_DEFAULT = false;

/**
 * Parse a boolean env VALUE, falling back to `fallback` on missing/unknown. Accepts (case- and
 * whitespace-insensitive) 1/true/yes/on → true and 0/false/no/off → false; anything else
 * (incl. empty/blank/missing) → `fallback`. Same tolerant shape as claimConfig.envBool /
 * sessionConfig.envBool — a DARK feature flag parses symmetrically and falls back to OFF, so a
 * typo leaves the shipped default in place rather than half-enabling a foundation change.
 *
 * Takes the VALUE, not the var name, so the read itself stays a single co-located
 * `process.env[ACTOR_IDENTITY_ENV.…] // env-read: <NAME>` line (bridgeAuthConfig.ts's shape) —
 * which keeps the env var's name in exactly ONE place instead of a constant plus a literal.
 */
function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * compositeActorEnabled — the master switch for scoped composite actors.
 *
 * FALSE (THE DEFAULT, and whenever the flag is unset/blank/garbage): the actor stack behaves
 * exactly as it does today — a verified `sub` OVERRIDES the declared handle, `classifyActor`
 * classifies the whole string, and a declared handle is passed through untouched.
 *
 * TRUE: a verified `sub` SCOPES the declared handle into a server-assembled composite,
 * declared segments are delimiter-sanitized, and `classifyActor` classifies the LAST segment.
 *
 * env: MANDREL_ACTOR_COMPOSITE_ENABLED
 */
export function compositeActorEnabled(): boolean {
  const raw = process.env[ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED]; // env-read: MANDREL_ACTOR_COMPOSITE_ENABLED
  return parseEnvBool(raw, COMPOSITE_ENABLED_DEFAULT);
}
