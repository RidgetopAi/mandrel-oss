/**
 * Usage Pattern Analytics
 * 
 * Daily activity, type breakdown, tag usage, and hourly distribution.
 */

import { db } from '../../database/connection';
import type { EmbeddingScope, UsagePatternMetrics } from './types';
import { logger } from '../../config/logger';
import { DEFAULT_AGG_TIMEZONE } from '../../config/analyticsTime';

/**
 * Get usage pattern metrics for a project.
 *
 * `tz` (an earlier task — whole-class per-day-in-UTC bug) buckets the DAILY-activity
 * series (contexts/day) in the VIEWER's timezone so an evening-local context lands on
 * the correct local calendar day. Bound as a param (validated IANA zone); absent → UTC
 * = the historical bucketing. The hourly/type/tag breakdowns are unaffected.
 */
export async function getUsagePatterns(
  _userId: string,
  scope: EmbeddingScope,
  tz: string = DEFAULT_AGG_TIMEZONE
): Promise<UsagePatternMetrics> {
  try {
    // Name lookup DELETED with EmbeddingScope.projectName (Reviewer D1):
    // the unauthorized legacy `project` header was its only source.
    const projectId = scope.projectId;

    if (!projectId) {
      throw new Error('Project context required for usage analytics.');
    }

    const [dailyActivityResult, typeBreakdownResult, tagActivityResult, hourlyResult, summaryResult] = await Promise.all([
      db.query(
        `
          SELECT
            TO_CHAR((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
            COUNT(*) AS context_count
          FROM contexts
          WHERE archived_at IS NULL AND project_id = $1
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY day
          ORDER BY day
        `,
        [projectId, tz]
      ),
      db.query(
        `
          SELECT context_type AS type, COUNT(*) AS context_count
          FROM contexts
          WHERE archived_at IS NULL AND project_id = $1
          GROUP BY context_type
        `,
        [projectId]
      ),
      db.query(
        `
          SELECT LOWER(tag) AS tag, COUNT(*) AS context_count
          FROM contexts
          CROSS JOIN LATERAL UNNEST(tags) AS tag
          WHERE archived_at IS NULL AND project_id = $1
          GROUP BY tag
          ORDER BY context_count DESC
          LIMIT 10
        `,
        [projectId]
      ),
      db.query(
        `
          SELECT
            EXTRACT(HOUR FROM created_at)::int AS hour,
            COUNT(*) AS context_count
          FROM contexts
          WHERE archived_at IS NULL AND project_id = $1
          GROUP BY hour
          ORDER BY hour
        `,
        [projectId]
      ),
      db.query(
        `
          SELECT
            COUNT(*) AS total_contexts,
            COUNT(DISTINCT LOWER(tag)) AS unique_tags,
            SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) AS contexts_last_7,
            SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) AS contexts_last_30,
            MAX(created_at) AS last_context_at
          FROM contexts
          LEFT JOIN LATERAL UNNEST(tags) tag ON true
          WHERE archived_at IS NULL AND project_id = $1
        `,
        [projectId]
      ),
    ]);

    const totalContexts = Number(summaryResult.rows[0]?.total_contexts ?? 0);

    const dailyActivity = dailyActivityResult.rows.map(row => ({
      date: row.day,
      contexts: Number(row.context_count ?? 0),
    }));

    const contextsByType = typeBreakdownResult.rows.map(row => ({
      type: row.type,
      count: Number(row.context_count ?? 0),
      percentage:
        totalContexts > 0 ? (Number(row.context_count ?? 0) / totalContexts) * 100 : 0,
    }));

    const topTags = tagActivityResult.rows.map(row => ({
      tag: row.tag,
      count: Number(row.context_count ?? 0),
    }));

    const hourlyDistribution = hourlyResult.rows.map(row => ({
      hour: Number(row.hour ?? 0),
      contexts: Number(row.context_count ?? 0),
    }));

    const summaryRow = summaryResult.rows[0] ?? {};

    const summary = {
      contextsLast7Days: Number(summaryRow.contexts_last_7 ?? 0),
      contextsLast30Days: Number(summaryRow.contexts_last_30 ?? 0),
      uniqueTags: Number(summaryRow.unique_tags ?? 0),
      totalContexts,
      lastContextAt: summaryRow.last_context_at
        ? new Date(summaryRow.last_context_at).toISOString()
        : null,
    };

    return {
      dailyActivity,
      contextsByType,
      topTags,
      hourlyDistribution,
      summary,
    };
  } catch (error) {
    logger.error('Error getting usage pattern metrics', { error });
    throw new Error('Failed to get usage pattern metrics');
  }
}
