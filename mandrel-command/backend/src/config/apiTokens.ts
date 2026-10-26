/**
 * API tokens — the named config for MINTING per-user API tokens from Settings → API tokens
 *. The mcp-server VERIFIES them
 * (mcp-server/src/config/apiTokenConfig.ts); the two services share no package, so the
 * prefix and the digest rule are pinned on both sides to ONE golden vector (below, and its
 * twin there). apiTokens.test.ts asserts this side reproduces it.
 */

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]; // env-read: via-callers
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const API_TOKEN_CONFIG = {
  /** Every token starts with this, so a leaked one is recognizable on sight (and by a
   *  secret scanner), and the mcp-server only does a lookup for bearers that carry it. */
  prefix: 'mdl_',
  /** CSPRNG bytes in the secret body (256 bits), rendered base64url (43 chars). */
  randomBytes: 32,
  /** Characters of the plaintext kept as the non-secret display prefix (`mdl_` + 8).
   *  8 base64url chars disclose 48 of the 256 random bits — enough to tell tokens
   *  apart in a list, nowhere near enough to matter. */
  displayPrefixLength: 12,
  /** Max length of a token's human label (matches the api_tokens.name column). */
  nameMaxLength: 100,
  /** Live (un-revoked, unexpired) tokens one user may hold at once. */
  maxActivePerUser: intFromEnv('MANDREL_API_TOKEN_MAX_PER_USER', 20),
  /** Optional expiry bounds for `expiresInDays` on create. Absent = never expires. */
  maxExpiresInDays: 3650,
  /** Create rate limit, keyed per authenticated user. Minting is a rare, deliberate act. */
  createRateLimit: {
    windowMs: 15 * 60 * 1000,
    max: intFromEnv('MANDREL_API_TOKEN_CREATE_RATE_MAX', 10),
  },
} as const;

/**
 * The cross-service contract, as data: sha256 of the plaintext, lower-case hex. The
 * mcp-server's apiTokenConfig.ts carries the identical pair.
 */
export const API_TOKEN_GOLDEN_VECTOR = {
  plaintext: 'mdl_golden-vector-not-a-real-token',
  sha256Hex: 'a1d5cfd6629b8bddf4dc4fbeb1311aa8773617109e89ba42820299ae0b1203b0',
} as const;
