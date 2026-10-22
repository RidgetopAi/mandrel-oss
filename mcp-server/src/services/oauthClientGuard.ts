/**
 * oauthClientGuard.ts — the DB-level primitives + Express middleware that ENFORCE the
 * per-tenant OAuth-client controls (BA-3 arming). Kept as small,
 * pure, directly-testable functions (no server needed) so the sweeper worker
 * (oauthClientSweeper.ts) and the register-endpoint middleware (mounted in oauthRoutes.ts)
 * both reuse the exact same SQL.
 *
 * Two controls live here:
 *   • countOAuthClients + dcrClientCapMiddleware → the PER-TENANT CAP: reject a DCR register
 *     once the `oauthClient` table already holds OAUTH_CLIENT_CONFIG.perTenantCap rows.
 *   • sweepExpiredUnconsentedClients → the TTL-SWEEP body: DELETE abandoned DCR clients
 *     (older than ttlDays, never consented, never issued an access token). Sparing any client
 *     that was actually consented to / used.
 *
 * All thresholds come from config (oauthClientConfig) — no hardcoded numbers here.
 *
 * TABLE/COLUMN NAMES are the quoted camelCase identifiers better-auth's generated schema
 * creates (migration 052): "oauthClient", "oauthConsent", "oauthAccessToken", "clientId",
 * "createdAt". They are quoted because Postgres would otherwise fold them to lowercase.
 */

import type { Pool } from 'pg';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { OAUTH_CLIENT_CONFIG } from '../config/oauthClientConfig.js';

/** Count all OAuth clients currently registered in this instance (== this tenant). */
export async function countOAuthClients(pool: Pool = db): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM "oauthClient"');
  return rows[0]?.n ?? 0;
}

/**
 * Delete abandoned DCR clients: `createdAt` older than `ttlDays` AND never consented (no
 * "oauthConsent" row) AND never issued an access token (no "oauthAccessToken" row). Returns
 * the number of rows deleted. A consented/used client is ALWAYS spared regardless of age.
 *
 * NOTE on `createdAt`: the DCR register path sets it to `new Date()` on create, so a real
 * registered client always has it. A NULL `createdAt` is NOT matched by `< cutoff` (SQL
 * three-valued logic) — i.e. it is spared, the safe direction (never delete on ambiguity).
 */
export async function sweepExpiredUnconsentedClients(
  pool: Pool = db,
  ttlDays: number = OAUTH_CLIENT_CONFIG.ttlDays,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM "oauthClient" c
      WHERE c."createdAt" < (NOW() - ($1::int * INTERVAL '1 day'))
        AND NOT EXISTS (SELECT 1 FROM "oauthConsent"     oc WHERE oc."clientId" = c."clientId")
        AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" at WHERE at."clientId" = c."clientId")`,
    [ttlDays],
  );
  return rowCount ?? 0;
}

/**
 * Express middleware that enforces the PER-TENANT CAP on the DCR register endpoint. Mount it
 * (in oauthRoutes.ts) on `POST <basePath>/oauth2/register` BEFORE the better-auth node handler.
 * It does NOT read the request body (a COUNT is enough), so it is safe to run before
 * express.json() / the raw-body handler. Fail-OPEN on a DB error is deliberately AVOIDED: a
 * count failure rejects the registration (fail-closed) rather than silently letting the cap
 * be bypassed — mirrors the fail-closed posture of the auth surface.
 */
export function dcrClientCapMiddleware(pool: Pool = db): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cap = OAUTH_CLIENT_CONFIG.perTenantCap;
    try {
      const current = await countOAuthClients(pool);
      if (current >= cap) {
        logger.warn(
          `🚫 DCR register rejected — per-tenant OAuth client cap reached (${current}/${cap}). ` +
          `Raise MANDREL_OAUTH_DCR_CLIENT_CAP if this is a legitimate tenant with many integrations.`,
        );
        // RFC 7591 registration error shape; 429 signals "too many clients, back off".
        res.status(429).json({
          error: 'invalid_client_metadata',
          error_description:
            `OAuth client registration limit reached for this instance (${cap}). ` +
            `No new clients can be registered until existing ones are removed.`,
        });
        return;
      }
      next();
    } catch (error) {
      // Fail-CLOSED: if we cannot verify the count, do not let registration through.
      logger.error('❌ DCR cap check failed — rejecting registration (fail-closed)', error as Error);
      res.status(503).json({
        error: 'temporarily_unavailable',
        error_description: 'Unable to verify client registration capacity; try again later.',
      });
    }
  };
}
