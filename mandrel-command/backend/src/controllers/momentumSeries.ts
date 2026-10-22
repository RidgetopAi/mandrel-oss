import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { getRequestProjectId } from '../services/projectScopeResolver';
import { MomentumSeriesService, spanDaysBetween } from '../services/momentumSeries';
import { resolveAggTimeZone } from '../config/analyticsTime';
import { DAY_SUMMARY_CONFIG } from '../config/daySummary';
import { logger } from '../config/logger';
import { resolveListScope } from '../services/projectListScope';

/**
 * Momentum-Series Controller — GET /api/momentum-series?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA>&project=<id|all>
 * Returns per-day Momentum for `[from..to]` so the Calendar grids paint a momentum ring on
 * every day cell.
 *
 * READ-BOUNDARY hygiene — identical discipline to `/api/day-summary`:
 *   • `from`/`to` → REQUIRED, strictly validated `YYYY-MM-DD` calendar dates; `from` must be
 *                   ≤ `to`; the inclusive span is CAPPED at `momentumSeries.maxSpanDays`
 *                   (abuse guard). Any violation → 400 (never a 500 or a runaway query).
 *   • `tz`      → sanitized to a real IANA zone via `resolveAggTimeZone` (bad/absent → UTC);
 *                 bound as a PARAM into `AT TIME ZONE $n` in the service (no injection).
 *   • `project` → the QUERY param is AUTHORITATIVE over the auto-attached `X-Project-ID`
 *                 header (the caller's stated intent wins, e.g. 'all' while a project is
 *                 header-selected). 'all'/absent → unscoped; else MUST be a valid uuid → 400.
 */

/** Strict YYYY-MM-DD validator: correct shape AND a real calendar date (rejects 2026-02-31). */
function parseDateParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/** The validated, ready-to-serve query shape, or a 400-worthy error message. */
export type MomentumSeriesQuery =
  | { ok: true; from: string; to: string; tz: string; projectId?: string }
  | { ok: false; error: string };

/**
 * Pure request-param validation for the momentum-series endpoint — extracted from the
 * handler so the 400 rules (date validity, from ≤ to, the span cap, project uuid) are
 * unit-testable WITHOUT a DB or an HTTP round-trip (tests-are-the-rock).
 *
 * @param query        the raw `req.query`-shaped bag (dates/tz only — see below)
 * @param maxSpanDays  the configured inclusive-span cap
 * @param resolvedProjectId the ALREADY-RESOLVED, ALREADY-AUTHORIZED project scope from
 *        getRequestProjectId(req). This used to be `headerProject`, and this function
 *        used to pick between it and `query.project` itself — that hand-rolled precedence
 *        (and its shape-only uuid check) moved to services/projectScopeResolver.ts in
 *        so there is exactly one implementation of the rule and it is the
 *        one that authorizes.
 */
export function parseMomentumSeriesQuery(
  query: Record<string, unknown>,
  maxSpanDays: number,
  resolvedProjectId?: string,
): MomentumSeriesQuery {
  const from = parseDateParam(query.from);
  if (!from) {
    return { ok: false, error: 'Query param `from` is required and must be a valid YYYY-MM-DD calendar date' };
  }
  const to = parseDateParam(query.to);
  if (!to) {
    return { ok: false, error: 'Query param `to` is required and must be a valid YYYY-MM-DD calendar date' };
  }
  const span = spanDaysBetween(from, to);
  if (span < 0) {
    return { ok: false, error: 'Query param `from` must be on or before `to`' };
  }
  if (span > maxSpanDays) {
    return { ok: false, error: `Requested range is too large (max ${maxSpanDays} days between from and to)` };
  }

  const tz = resolveAggTimeZone(query.tz);

  // Project scope is resolved AND AUTHORIZED upstream by projectContextMiddleware via
  // services/projectScopeResolver.ts, which implements the precedence this
  // function used to hand-roll (explicit `project` query param beats the X-Project-ID
  // header; 'all' = explicitly unscoped). `resolvedProjectId` is that answer.
  return { ok: true, from, to, tz, projectId: resolvedProjectId };
}

export class MomentumSeriesController {
  static async getMomentumSeries(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = parseMomentumSeriesQuery(
        req.query as Record<string, unknown>,
        DAY_SUMMARY_CONFIG.momentumSeries.maxSpanDays,
        getRequestProjectId(req),
      );
      if (!parsed.ok) {
        res.status(400).json({ success: false, error: parsed.error });
        return;
      }

      const data = await MomentumSeriesService.getMomentumSeries(
        parsed.from,
        parsed.to,
        parsed.tz,
        await resolveListScope(req),
      );
      res.json({ success: true, data });
    } catch (error) {
      logger.error('Get momentum series error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get momentum series',
      });
    }
  }
}
