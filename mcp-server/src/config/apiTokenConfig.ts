/**
 * apiTokenConfig — the named config for VERIFYING per-user API tokens on /mcp and
 * /mcp/tools/*.
 *
 * The tokens are MINTED by the Command backend (Settings → API tokens,
 * mandrel-command/backend/src/config/apiTokens.ts) and VERIFIED here. The two services
 * share no package, so the two facts both sides must agree on — the recognizable prefix
 * and the digest rule (lower-case hex SHA-256 of the whole plaintext, prefix included) —
 * are pinned on BOTH sides to one golden vector (API_TOKEN_GOLDEN_VECTOR below and its
 * twin in the Command backend config). Each side's unit test asserts its own
 * implementation reproduces the vector, so a change on one side alone goes RED.
 */

export const API_TOKEN_CONFIG = {
  /**
   * Every API token starts with this. The verifier only consults the database for a
   * presented bearer that carries it, so static-token and OAuth-JWT callers never pay a
   * lookup. Mirrors API_TOKEN_CONFIG.prefix in the Command backend.
   */
  prefix: 'mdl_',
  /**
   * The owner's admin_users.role required AT CHECK TIME. A token opens /mcp with full
   * read/write access to every project, which non-admin Command users are deliberately
   * denied (routes/mcp.ts) — so only an admin's token authenticates, and
   * demoting the owner revokes it in effect. Grant-scoped tokens for non-admins are a
   * possible future option (the operator decides). Mirrors the Command backend's requireAdmin.
   */
  requiredOwnerRole: 'admin',
  /**
   * last_used_at is written at most once per this window, per token — an unattended loop
   * polling every few seconds must not turn every request into a row write. Enforced in
   * SQL (a conditional UPDATE), so concurrent requests on several processes cannot
   * double-write inside the window either.
   */
  lastUsedThrottleSeconds: Number(process.env.MANDREL_API_TOKEN_LAST_USED_THROTTLE_SECONDS || 60),
} as const;

/**
 * The cross-service contract, as data. sha256('mdl_golden-vector-not-a-real-token') in
 * lower-case hex. The Command backend config carries the same pair.
 */
export const API_TOKEN_GOLDEN_VECTOR = {
  plaintext: 'mdl_golden-vector-not-a-real-token',
  sha256Hex: 'a1d5cfd6629b8bddf4dc4fbeb1311aa8773617109e89ba42820299ae0b1203b0',
} as const;
