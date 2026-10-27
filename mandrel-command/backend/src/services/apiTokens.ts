/**
 * ApiTokenService — mint, list and revoke a user's per-user API tokens (Settings → API
 * tokens). The mcp-server verifies them on /mcp and
 * /mcp/tools/* (mcp-server/src/services/apiTokenAuth.ts).
 *
 * SECURITY CONTRACT
 *   - Plaintext = `mdl_` + base64url(32 CSPRNG bytes). It exists only in the return value
 *     of create(); it is never stored, never logged, and no other method can produce it.
 *   - Stored: the lower-case hex SHA-256 of the whole plaintext. A fast hash is correct
 *     here: 256 bits of CSPRNG entropy make a preimage search infeasible at any hash
 *     speed (slow KDFs protect LOW-entropy passwords), and a deterministic digest is what
 *     lets the verifier find the row with one indexed equality. The column's CHECK
 *     constraint (migration 108) refuses anything that is not a 64-char hex digest.
 *   - EVERY query is scoped by user_id. There is no method that takes a token id without
 *     the caller's user id; revoking someone else's token is a 0-row UPDATE → not found,
 *     indistinguishable from an id that does not exist (no existence oracle).
 *   - The per-user cap is checked and the row inserted inside ONE transaction holding a
 *     row lock on the owner, so concurrent creates cannot overshoot the cap.
 */

import { createHash, randomBytes } from 'crypto';
import { db as pool } from '../database/connection';
import { API_TOKEN_CONFIG } from '../config/apiTokens';

/** A token as the API shows it — never carries the plaintext or the hash. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export type CreateResult =
  | { ok: true; token: ApiTokenSummary; plaintext: string }
  | { ok: false; reason: 'limit'; limit: number };

interface Row {
  id: string;
  name: string;
  display_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
}

const toSummary = (r: Row): ApiTokenSummary => ({
  id: r.id,
  name: r.name,
  prefix: r.display_prefix,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
});

const SUMMARY_COLUMNS = 'id, name, display_prefix, created_at, last_used_at, expires_at';

/** Lower-case hex SHA-256 of the whole plaintext — the cross-service digest rule. */
export function hashApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** A fresh plaintext token. */
export function generateApiToken(): string {
  return `${API_TOKEN_CONFIG.prefix}${randomBytes(API_TOKEN_CONFIG.randomBytes).toString('base64url')}`;
}

/** Validate a label; returns the trimmed value or an error message. */
export function validateTokenName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'name is required' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'name is required' };
  if (value.length > API_TOKEN_CONFIG.nameMaxLength) {
    return { ok: false, error: `name must be at most ${API_TOKEN_CONFIG.nameMaxLength} characters` };
  }
  return { ok: true, value };
}

/** Validate an optional expiry in whole days. undefined/null = never expires. */
export function validateExpiresInDays(
  raw: unknown
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > API_TOKEN_CONFIG.maxExpiresInDays) {
    return { ok: false, error: `expiresInDays must be an integer from 1 to ${API_TOKEN_CONFIG.maxExpiresInDays}` };
  }
  return { ok: true, value: raw };
}

export class ApiTokenService {
  /** Live tokens: not revoked and not past expiry. */
  private static readonly LIVE = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())';

  static async create(userId: string, name: string, expiresInDays: number | null): Promise<CreateResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize this user's creates so the cap check and the insert are one decision.
      await client.query('SELECT id FROM admin_users WHERE id = $1 FOR UPDATE', [userId]);
      const count = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND ${ApiTokenService.LIVE}`,
        [userId]
      );
      const limit = API_TOKEN_CONFIG.maxActivePerUser;
      if (count.rows[0].n >= limit) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'limit', limit };
      }

      const plaintext = generateApiToken();
      const inserted = await client.query<Row>(
        `INSERT INTO api_tokens (user_id, name, token_hash, display_prefix, expires_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
         RETURNING ${SUMMARY_COLUMNS}`,
        [userId, name, hashApiToken(plaintext), plaintext.slice(0, API_TOKEN_CONFIG.displayPrefixLength), expiresInDays]
      );
      await client.query('COMMIT');
      return { ok: true, token: toSummary(inserted.rows[0]), plaintext };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** The caller's un-revoked tokens, newest first. Expired ones are listed (with their
   *  expiry) so the user can see and clear them. */
  static async list(userId: string): Promise<ApiTokenSummary[]> {
    const r = await pool.query<Row>(
      `SELECT ${SUMMARY_COLUMNS} FROM api_tokens
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC, id`,
      [userId]
    );
    return r.rows.map(toSummary);
  }

  /** Revoke one of the CALLER's tokens. false = no such un-revoked token for this user. */
  static async revoke(userId: string, tokenId: string): Promise<boolean> {
    const r = await pool.query(
      `UPDATE api_tokens SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [tokenId, userId]
    );
    return (r.rowCount ?? 0) > 0;
  }
}
