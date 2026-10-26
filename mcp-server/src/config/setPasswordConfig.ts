/**
 * setPasswordConfig — the one-time SET-PASSWORD LINK a new hosted customer receives in their
 * welcome email (sign-up S5).
 *
 * MECHANISM (why so little code): better-auth's own password-reset endpoint
 * (`POST <basePath>/reset-password {token, newPassword}`) already does the hard parts. It
 * CONSUMES the `verification` row `reset-password:<token>` inside a transaction (single use:
 * a second submit finds no row), refuses a row whose `expiresAt` has passed, hashes with
 * better-auth's own hasher and updates the `credential` account. What it lacks is a way to
 * ISSUE a token without an email callback (`sendResetPassword`, which we do not configure)
 * and a page to type the password into. So we add exactly those two:
 *   - src/scripts/mint-set-password-link.ts writes the verification row server-side;
 *   - src/server/setPasswordPage.ts serves the page + a read-only "is this link still good?" check.
 *
 * configs-not-hardcoded: every tunable is here, env-overridable.
 */

/** Read a positive integer env var, falling back on missing/invalid. */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface SetPasswordConfig {
  /**
   * How long a freshly minted link works. Default 48 h (an earlier decision asked for 24-72 h).
   * The mint script accepts a per-call override (MANDREL_SET_PASSWORD_TTL_HOURS on the exec).
   */
  ttlHours: number;
  /**
   * The page path. It MUST sit under `/sign-in`: the tenant's Traefik OAuth router
   * (docker-compose.yml, `<handle>-oauth` rule) sends `PathPrefix(/sign-in)` to the mcp-server
   * and everything else to the Command frontend. A path outside it would need a routing change.
   */
  pagePath: string;
  /**
   * better-auth's own identifier prefix for a password-reset verification row
   * (better-auth/dist/api/routes/password.mjs: `reset-password:${token}`). Not ours to choose:
   * the reset endpoint looks the token up under exactly this prefix.
   */
  identifierPrefix: string;
  /** Random bytes in a token (base64url-encoded into the link). 32 bytes = 256 bits. */
  tokenBytes: number;
  /**
   * Per-client limit on POST <pagePath>/status: at most `statusRateMax` calls per
   * `statusRateWindowMs`, keyed on `statusRateIpHeader` (nginx's mandrel-wildcard vhost sets
   * X-Real-IP to $remote_addr), else the socket address. Over the limit → 429, which the page
   * shows as "could not check, reload" — never as "ask us for a new one". The page calls it
   * once per open; a 256-bit token is not guessable, so this is hygiene, not the defence.
   * NOTE: if a proxy in front rewrites the header to its own address, every client shares
   * one bucket — keep the limit modest-but-generous for that reason.
   */
  statusRateMax: number;
  statusRateWindowMs: number;
  statusRateIpHeader: string;
}

export const SET_PASSWORD_CONFIG: SetPasswordConfig = {
  ttlHours: envPositiveInt('MANDREL_SET_PASSWORD_TTL_HOURS', 48),
  pagePath: '/sign-in/set-password',
  identifierPrefix: 'reset-password:',
  tokenBytes: 32,
  statusRateMax: envPositiveInt('MANDREL_SET_PASSWORD_STATUS_RATE_MAX', 30),
  statusRateWindowMs: envPositiveInt('MANDREL_SET_PASSWORD_STATUS_RATE_WINDOW_MS', 60_000),
  statusRateIpHeader: 'x-real-ip',
};

/** Token shape the page and the status check accept (base64url, what the mint emits). */
export const SET_PASSWORD_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
