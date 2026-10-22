/**
 * bridgeAuthConfig — the named config for the on-box MCP HTTP bridge auth gate
 * (SECURITY P0 interim shield, PHASE 1).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every knob the bridge guard touches — the master enforcement FLAG and the env var
 * NAMES of the secrets it validates against — lives HERE: a named value with a documented
 * default and an env override. Mirrors betterAuthConfig.ts: the config
 * is the contract, the code reads it.
 *
 * WHY this exists: the three on-box bridge routes on the mcp-server —
 *   GET  /mcp/tools/schemas
 *   GET  /mcp/tools
 *   POST /mcp/tools/:toolName
 * were historically UNAUTHENTICATED (localhost-only agents). PHASE 1 added an opt-in
 * credential gate in front of them, shipped DARK. PHASE 2
 * FLIPS THE DEFAULT to fail-CLOSED: this surface executes ANY MCP tool (context_search/
 * store, project data), so a fail-OPEN default is the wrong default for it. The flag now
 * defaults ENFORCE — unset ⇒ require a credential — and is disabled only by an EXPLICIT
 * falsey value. Enforce = accept the static bridge token, a command HS256 login JWT, or
 * (when enabled) an OAuth JWT; anything else → 401; enforce-but-no-secret-configured → 503
 * fail closed, never fall open. Prod already runs with the flag explicitly ON, so this
 * default flip is a no-op there; it only closes the hole on any env that left it unset.
 *
 * Reads happen at CALL TIME (not module load) via the getters below — matching how the
 * static MCP_AUTH_TOKEN is read at call time in bearerAuth.ts — so a per-process env change
 * (deploy, or a test) is picked up without a module reload.
 */

/**
 * The recognized EXPLICIT opt-out tokens for the enforcement flag. Named here (not buried as a
 * literal in the guard) per the no-hardcoded-variables standing principle. A fail-CLOSED flag
 * disables ONLY on one of these exact tokens — see bridgeAuthEnabled().
 */
const BRIDGE_AUTH_DISABLE_TOKENS: readonly string[] = ['false', '0', 'off', 'no'];

/**
 * The env var NAMES this gate reads. Kept as named constants (not string literals buried
 * in the guard) so the provisioner + DEPLOY NOTES reference one source of truth.
 */
export const BRIDGE_AUTH_ENV = {
  /**
   * Master enforcement flag for the bridge gate. Default TRUE (fail-CLOSED): unset ⇒ ENFORCE.
   * Opt OUT explicitly with a falsey value (`false`/`0`/`off`/`no`). See bridgeAuthEnabled().
   */
  ENABLED: 'MCP_BRIDGE_AUTH_ENABLED',
  /** The static bridge token (constant-time). Same var the /mcp remote transport uses. */
  STATIC_TOKEN: 'MCP_AUTH_TOKEN',
  /** The HS256 secret the command backend signs its login JWTs with (services/auth.ts). */
  COMMAND_JWT_SECRET: 'MANDREL_JWT_SECRET',
  /** Legacy fallback name for the command JWT secret (deprecated, still honored). */
  COMMAND_JWT_SECRET_LEGACY: 'AIDIS_JWT_SECRET',
} as const;

/**
 * enabled — the master enforcement switch. Default TRUE = fail-CLOSED.
 *
 * When TRUE (the DEFAULT, and whenever the flag is UNSET), the guard ENFORCES: accept a valid
 * credential, else 401; fail closed on 503 if no credential source is configured — it can NEVER
 * fall open. To turn the gate OFF you must set MCP_BRIDGE_AUTH_ENABLED to an EXPLICIT recognized
 * falsey token (`false`/`0`/`off`/`no`, case-insensitive), which makes the three routes a byte-
 * identical unauthenticated pass-through. This is the "require the token unless explicitly
 * disabled" posture: a security surface that executes any MCP tool defaults closed, never open.
 *
 * FAIL-CLOSED PARSE (deliberately NOT a symmetric boolean): only a recognized opt-out token
 * disables the gate. Unset, empty/whitespace, AND any UNRECOGNIZED value (a typo like `flase`,
 * a stray `enabled`, garbage) all resolve to ENFORCE — so a fat-fingered flag can never silently
 * fall the security gate open. Env: MCP_BRIDGE_AUTH_ENABLED.
 */
export function bridgeAuthEnabled(): boolean {
  const raw = process.env[BRIDGE_AUTH_ENV.ENABLED]; // env-read: MCP_BRIDGE_AUTH_ENABLED
  if (raw === undefined) return true; // unset ⇒ enforce (fail-closed default)
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return true; // empty/whitespace ⇒ treated as unset ⇒ enforce
  // Disable ONLY on an explicit recognized opt-out token; every other value stays CLOSED.
  return !BRIDGE_AUTH_DISABLE_TOKENS.includes(normalized);
}

/**
 * The command-login JWT signing secret, or null if it is not explicitly configured.
 *
 * SECURITY: there is intentionally NO insecure default here (unlike the command backend's
 * own dev fallback). Verifying a JWT against a well-known default secret would let anyone
 * FORGE a valid login token — so when the secret is unset the JWT credential path is simply
 * UNAVAILABLE (never validated against a guessable key). Honors the canonical
 * MANDREL_JWT_SECRET with the legacy AIDIS_JWT_SECRET as a transitional fallback.
 */
export function commandJwtSecret(): string | null {
  const raw =
    process.env[BRIDGE_AUTH_ENV.COMMAND_JWT_SECRET] ?? // env-read: MANDREL_JWT_SECRET
    process.env[BRIDGE_AUTH_ENV.COMMAND_JWT_SECRET_LEGACY]; // env-read: AIDIS_JWT_SECRET
  if (raw === undefined || raw.trim() === '') return null;
  return raw;
}
