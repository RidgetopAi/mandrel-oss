import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { DaySummaryService } from '../services/daySummary';
import { resolveAggTimeZone } from '../config/analyticsTime';
import { logger } from '../config/logger';
import { resolveListScope } from '../services/projectListScope';

/**
 * Day-Summary Controller — GET /api/day-summary?date=YYYY-MM-DD&tz=<IANA>&project=<id|all>
 * Assembles the Calendar click-into-date report.
 *
 * READ-BOUNDARY hygiene (mirrors the sibling analytics endpoints):
 *   • `tz`      → sanitized to a real IANA zone via `resolveAggTimeZone` (bad/absent → UTC);
 *                 the service binds it as a PARAM into `AT TIME ZONE $n` (no injection).
 *   • `date`    → REQUIRED; strictly validated as a real YYYY-MM-DD calendar date → 400 on a
 *                 missing/malformed value (bound as a `::date` param in the service, not
 *                 interpolated). A bad date must never 500 or silently pick "today".
 *   • `project` → 'all' / absent → no project filter; otherwise MUST be a valid uuid (an
 *                 invalid value is a 400, not a silent "all", so the caller isn't misled).
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

export class DaySummaryController {
  static async getDaySummary(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const date = parseDateParam(req.query.date);
      if (!date) {
        res.status(400).json({
          success: false,
          error: 'Query param `date` is required and must be a valid YYYY-MM-DD calendar date',
        });
        return;
      }

      // Bucket every per-day metric in the viewer's tz; default UTC.
      const tz = resolveAggTimeZone(req.query.tz);

      // project=<id|all>. The precedence this endpoint documented by hand — the explicit
      // `project` query param is AUTHORITATIVE over the auto-attached X-Project-ID header,
      // and 'all' means explicitly unscoped — is now the GENERAL rule, implemented once in
      // services/projectScopeResolver.ts. It also authorizes the value,
      // which the hand-rolled version above never did: it only checked the uuid SHAPE.
      // Malformed uuid → 400 and 'all' → unscoped are both handled there, before this runs.
      const summary = await DaySummaryService.getDaySummary(
        date,
        tz,
        await resolveListScope(req)
      );
      res.json({ success: true, data: summary });
    } catch (error) {
      logger.error('Get day summary error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get day summary',
      });
    }
  }
}
