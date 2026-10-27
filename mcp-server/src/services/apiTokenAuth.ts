/**
 * apiTokenAuth — VERIFY a per-user API token presented as `Authorization: Bearer mdl_…`
 *. Minted by the Command backend (Settings → API tokens);
 * only its SHA-256 is stored (migration 108).
 *
 * THE RULE, in order:
 *   1. No `mdl_` prefix → 'no-match' with NO database call (static and OAuth bearers are
 *      never API tokens, and must not pay a lookup).
 *   2. Hash the whole presented string (SHA-256) and look it up by INDEXED EQUALITY on
 *      api_tokens.token_hash, in the same statement refusing a revoked token, an expired
 *      token, a token whose owner is deactivated, and a token whose owner is no longer an
 *      ADMIN (Reviewer F1: a token carries full MCP access, so a demoted admin's tokens
 *      stop on the next request). All of those are 'no-match' — the
 *      caller answers 401 exactly as for a wrong token, so the response never says WHICH.
 *   3. Constant-time compare of the stored digest against the computed one
 *      (timingSafeEqual on two 32-byte buffers). The equality already matched in SQL; this
 *      is the belt to the index's braces, and it keeps the final accept decision out of a
 *      short-circuiting string compare.
 *   4. Throttled last_used_at: a CONDITIONAL UPDATE that only writes when the stored value
 *      is older than the window, so at most one write per token per window across every
 *      process. A failure to record last-use never fails the request.
 *
 * THREE STATES, NOT TWO (CLASSES C1): a database error during the lookup is 'unavailable',
 * never 'no-match'. The guards answer 503 for it — fail-closed, and honest that the server
 * could not check, rather than telling a customer their working token is wrong.
 *
 * NEVER LOGGED: the presented token. Log lines name the token ROW id only.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { API_TOKEN_CONFIG } from '../config/apiTokenConfig.js';
import { logger } from '../utils/logger.js';

/** The principal an accepted API token resolves to. */
export interface ApiTokenPrincipal {
  /** api_tokens.id — safe to log. */
  tokenId: string;
  /** admin_users.id of the owner. */
  userId: string;
  /**
   * The ACTOR the request is attributed to. ONE LOGIN: when the owner's
   * dashboard row is linked to a better-auth user, this is that better-auth user id — the
   * same `sub` an OAuth access token for the same person carries — so a customer's loop
   * (API token) and their Claude.ai / Claude Code session (OAuth) are one actor. An unlinked
   * (legacy, dashboard-only) owner is attributed by admin_users.username, as before.
   */
  principal: string;
}

export type ApiTokenResult =
  | { kind: 'ok'; principal: ApiTokenPrincipal }
  | { kind: 'no-match' }
  | { kind: 'unavailable' };

export type ApiTokenVerifier = (presented: string) => Promise<ApiTokenResult>;

/** Lower-case hex SHA-256 of the whole presented string. The cross-service digest rule. */
export function hashApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Cheap, DB-free shape test: does this bearer even claim to be an API token? */
export function looksLikeApiToken(presented: string): boolean {
  return presented.startsWith(API_TOKEN_CONFIG.prefix);
}

interface TokenRow {
  id: string;
  user_id: string;
  principal: string;
  token_hash: string;
}

/**
 * Build a verifier over a pool. The pool is a parameter (not the module-level `db`) so the
 * integration test drives the SHIPPED function against its own scratch database.
 */
export function createApiTokenVerifier(pool: Pick<Pool, 'query'>): ApiTokenVerifier {
  return async (presented: string): Promise<ApiTokenResult> => {
    if (!looksLikeApiToken(presented)) return { kind: 'no-match' };

    const computedHex = hashApiToken(presented);
    let row: TokenRow | undefined;
    try {
      const res = await pool.query<TokenRow>(
        `SELECT t.id, t.user_id, COALESCE(u.auth_user_id, u.username) AS principal, t.token_hash
           FROM api_tokens t
           JOIN admin_users u ON u.id = t.user_id
          WHERE t.token_hash = $1
            AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())
            AND u.is_active = true
            AND u.role = $2`,
        [computedHex, API_TOKEN_CONFIG.requiredOwnerRole]
      );
      row = res.rows[0];
    } catch (err) {
      logger.error(`🔒 API token lookup failed (could not verify): ${(err as Error).message}`);
      return { kind: 'unavailable' };
    }
    if (!row) return { kind: 'no-match' };

    const stored = Buffer.from(row.token_hash, 'hex');
    const computed = Buffer.from(computedHex, 'hex');
    if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) {
      return { kind: 'no-match' };
    }

    try {
      await pool.query(
        `UPDATE api_tokens
            SET last_used_at = now()
          WHERE id = $1
            AND (last_used_at IS NULL OR last_used_at < now() - make_interval(secs => $2))`,
        [row.id, API_TOKEN_CONFIG.lastUsedThrottleSeconds]
      );
    } catch (err) {
      logger.warn(`API token ${row.id}: last_used_at not recorded: ${(err as Error).message}`);
    }

    return {
      kind: 'ok',
      principal: { tokenId: row.id, userId: row.user_id, principal: row.principal },
    };
  };
}

/**
 * The production verifier, over the server's guarded pool. Imported lazily so a module that
 * only needs the guards' types does not open a pool at import time.
 */
export const defaultApiTokenVerifier: ApiTokenVerifier = async (presented) => {
  if (!looksLikeApiToken(presented)) return { kind: 'no-match' };
  const { db } = await import('../config/database.js');
  return createApiTokenVerifier(db)(presented);
};
