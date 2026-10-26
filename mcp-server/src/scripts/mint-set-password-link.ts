/**
 * mint-set-password-link.ts — issue a ONE-TIME, EXPIRING set-password link for a tenant's
 * better-auth login user (sign-up S5).
 *
 * The customer's first OAuth user is seeded with a GENERATED password nobody is sent
 * (seed-first-oauth-user.ts). This link is how the customer
 * gets in: they open it, choose their own password, and the link is spent.
 *
 * MECHANISM — better-auth's OWN reset path, minus the email callback we do not configure:
 *   write   verification { identifier: "reset-password:<token>", value: <userId>, expiresAt }
 *   spend   POST <basePath>/reset-password { token, newPassword }   (better-auth, unchanged)
 * The spend side consumes the row in a transaction (single use) and rejects an expired one —
 * see setPasswordConfig.ts. We write the row through better-auth's internal adapter (never raw
 * SQL), so any identifier-hashing option better-auth applies is applied here too.
 *
 * SUPERSEDES: minting a new link deletes every earlier unspent set-password link for the same
 * user, so "ask us for a new one" also kills the old one.
 *
 * SECRETS: the token IS a credential until it is spent or expires. It is printed ONCE, to
 * stdout, by the CLI (the caller needs it to build the email) and never passed to the logger.
 *
 * CLI (inside the tenant's mcp-server container; inputs over ENV, never argv):
 *   MANDREL_SET_PASSWORD_EMAIL=<login email> [MANDREL_SET_PASSWORD_TTL_HOURS=<n>] \
 *     npx tsx src/scripts/mint-set-password-link.ts
 * stdout, exit 0:   SET_PASSWORD_RESULT=ok expires_at=<iso>
 *                   SET_PASSWORD_URL=<issuer><pagePath>#token=<token>
 * stdout, exit 1:   SET_PASSWORD_RESULT=no-user          (measured: no login user with that email)
 * stdout, exit 2:   SET_PASSWORD_RESULT=error <reason>   (could not measure / could not write)
 * The URL is on its OWN line so a caller that quotes the first line in an error never quotes it.
 */

import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createAuth, type AuthInstance } from '../server/auth.js';
import { BETTER_AUTH_CONFIG } from '../config/betterAuthConfig.js';
import { SET_PASSWORD_CONFIG, type SetPasswordConfig } from '../config/setPasswordConfig.js';
import { guardPool } from '../utils/datastoreError.js';

export class NoSuchLoginUser extends Error {
  constructor() {
    super('no login user with that email');
    this.name = 'NoSuchLoginUser';
  }
}

export interface MintInput {
  email: string;
  /** Overrides cfg.ttlHours for this one link. */
  ttlHours?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface MintResult {
  userId: string;
  token: string;
  expiresAt: Date;
  url: string;
  /** How many earlier unspent links for this user were deleted. */
  superseded: number;
}

/** The link the customer opens. The token rides in the FRAGMENT so it never reaches a server log. */
export function setPasswordUrl(issuer: string, token: string, cfg: SetPasswordConfig = SET_PASSWORD_CONFIG): string {
  return `${issuer.replace(/\/+$/, '')}${cfg.pagePath}#token=${token}`;
}

export async function mintSetPasswordLink(
  auth: AuthInstance,
  input: MintInput,
  cfg: SetPasswordConfig = SET_PASSWORD_CONFIG,
  issuer: string = BETTER_AUTH_CONFIG.issuer,
): Promise<MintResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error('mintSetPasswordLink: email is required');
  const ttlHours = input.ttlHours ?? cfg.ttlHours;
  if (!(Number.isFinite(ttlHours) && ttlHours > 0)) throw new Error('mintSetPasswordLink: ttlHours must be > 0');

  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  if (!found) throw new NoSuchLoginUser();
  const userId = found.user.id;

  // Supersede: every earlier UNSPENT set-password link for this user stops working now.
  const superseded = await ctx.adapter.deleteMany({
    model: 'verification',
    where: [
      { field: 'value', value: userId },
      { field: 'identifier', operator: 'starts_with', value: cfg.identifierPrefix },
    ],
  });

  const token = randomBytes(cfg.tokenBytes).toString('base64url');
  const now = (input.now ?? Date.now)();
  const expiresAt = new Date(now + ttlHours * 3_600_000);
  await ctx.internalAdapter.createVerificationValue({
    identifier: `${cfg.identifierPrefix}${token}`,
    value: userId,
    expiresAt,
  });
  return { userId, token, expiresAt, url: setPasswordUrl(issuer, token, cfg), superseded: Number(superseded) || 0 };
}

async function main(): Promise<void> {
  const email = (process.env.MANDREL_SET_PASSWORD_EMAIL ?? '').trim(); // env-read: MANDREL_SET_PASSWORD_EMAIL
  const out = (s: string) => process.stdout.write(`${s}\n`);
  if (!email) {
    out('SET_PASSWORD_RESULT=error MANDREL_SET_PASSWORD_EMAIL is required');
    process.exit(2);
  }
  if (!BETTER_AUTH_CONFIG.enabled) {
    out('SET_PASSWORD_RESULT=error OAuth is not enabled on this instance (MANDREL_OAUTH_ENABLED)');
    process.exit(2);
  }
  // DATASTORE ERROR BOUNDARY: every `new Pool(` under src/ is guarded.
  const pool = guardPool(new Pool({
    user: process.env.DATABASE_USER || 'mandrel',
    host: process.env.DATABASE_HOST || 'localhost',
    database: process.env.DATABASE_NAME || 'mandrel',
    password: process.env.DATABASE_PASSWORD || '',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    ssl: ((process.env.DATABASE_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'true')
      ? { rejectUnauthorized: false }
      : false,
    max: 2,
  }));
  let code = 0;
  try {
    const r = await mintSetPasswordLink(createAuth(BETTER_AUTH_CONFIG, pool), { email });
    out(`SET_PASSWORD_RESULT=ok expires_at=${r.expiresAt.toISOString()} superseded=${r.superseded}`);
    out(`SET_PASSWORD_URL=${r.url}`);
  } catch (err) {
    if (err instanceof NoSuchLoginUser) {
      out('SET_PASSWORD_RESULT=no-user');
      code = 1;
    } else {
      out(`SET_PASSWORD_RESULT=error ${String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 200)}`);
      code = 2;
    }
  } finally {
    await pool.end().catch(() => { /* already closed */ });
  }
  process.exit(code);
}

// CLI-main guard (ESM): importing mintSetPasswordLink from a test does NOT run the CLI.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
