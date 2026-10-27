/**
 * Knowledge Gap Analytics
 * 
 * Identify missing tags, stale content, and underrepresented types.
 */

import { db } from '../../database/connection';
import { logger } from '../../config/logger';
import type { 
  EmbeddingScope, 
  KnowledgeGapMetrics, 
  KnowledgeGapMissingTag, 
  KnowledgeGapStaleTag, 
  KnowledgeGapTypeInsight, 
  KnowledgeGapSummary 
} from './types';

/**
 * Get knowledge gap metrics for a project
 */
export async function getKnowledgeGapMetrics(
  _userId: string,
  scope: EmbeddingScope
): Promise<KnowledgeGapMetrics> {
  try {
    // Name lookup DELETED with EmbeddingScope.projectName (Reviewer D1):
    // the unauthorized legacy `project` header was its only source.
    const projectId = scope.projectId;

    if (!projectId) {
      throw new Error('Project context required for knowledge gap analytics.');
    }

    const focusSummaryResult = await db.query(
      `
        SELECT
          COUNT(*) AS context_count,
          COUNT(DISTINCT LOWER(tag)) AS tag_count
        FROM contexts c
        LEFT JOIN LATERAL UNNEST(c.tags) tag ON true
        WHERE c.archived_at IS NULL AND c.project_id = $1
      `,
      [projectId]
    );

    const focusSummary = focusSummaryResult.rows[0] ?? { context_count: 0, tag_count: 0 };

    const lastContextResult = await db.query(
      `SELECT MAX(created_at) AS last_context_at FROM contexts
       WHERE archived_at IS NULL AND project_id = $1`,
      [projectId]
    );
    const lastContextAt = lastContextResult.rows[0]?.last_context_at
      ? new Date(lastContextResult.rows[0].last_context_at).toISOString()
      : null;

    const missingTagsResult = await db.query(
      `
        WITH global_tags AS (
          SELECT
            LOWER(tag) AS tag,
            COUNT(*) AS total_count,
            COUNT(DISTINCT project_id) AS project_count,
            MAX(created_at) AS last_used
          FROM contexts
          CROSS JOIN LATERAL UNNEST(tags) AS tag
          WHERE archived_at IS NULL
          GROUP BY tag
        ),
        focus_tags AS (
          SELECT DISTINCT LOWER(tag) AS tag
          FROM contexts
          CROSS JOIN LATERAL UNNEST(tags) AS tag
          WHERE archived_at IS NULL AND project_id = $1
        ),
        missing AS (
          SELECT g.tag, g.total_count, g.project_count, g.last_used
          FROM global_tags g
          LEFT JOIN focus_tags f ON f.tag = g.tag
          WHERE f.tag IS NULL
        ),
        tag_projects AS (
          SELECT
            LOWER(tag) AS tag,
            c.project_id,
            COALESCE(p.name, 'Unknown Project') AS project_name,
            COUNT(*) AS tag_count,
            ROW_NUMBER() OVER (PARTITION BY LOWER(tag) ORDER BY COUNT(*) DESC) AS project_rank
          FROM contexts c
          CROSS JOIN LATERAL UNNEST(c.tags) AS tag
          LEFT JOIN projects p ON p.id = c.project_id
          WHERE c.archived_at IS NULL AND c.project_id <> $1
          GROUP BY tag, c.project_id, p.name
        )
        SELECT
          m.tag,
          m.total_count,
          m.project_count,
          m.last_used,
          COALESCE(
            json_agg(
              json_build_object(
                'projectId', tp.project_id,
                'projectName', tp.project_name,
                'count', tp.tag_count
              )
              ORDER BY tp.tag_count DESC
            ) FILTER (WHERE tp.project_rank <= 3),
            '[]'::json
          ) AS top_projects
        FROM missing m
        LEFT JOIN tag_projects tp ON tp.tag = m.tag AND tp.project_rank <= 3
        GROUP BY m.tag, m.total_count, m.project_count, m.last_used
        ORDER BY m.total_count DESC
        LIMIT 12;
      `,
      [projectId]
    );

    const staleTagsResult = await db.query(
      `
        SELECT
          LOWER(tag) AS tag,
          COUNT(*) AS total_count,
          MAX(created_at) AS last_used,
          EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 86400 AS days_since_last
        FROM contexts
        CROSS JOIN LATERAL UNNEST(tags) AS tag
        WHERE archived_at IS NULL AND project_id = $1
        GROUP BY tag
        HAVING MAX(created_at) < NOW() - INTERVAL '21 days'
        ORDER BY MAX(created_at)
        LIMIT 10;
      `,
      [projectId]
    );

    const typeGapResult = await db.query(
      `
        WITH global_type_stats AS (
          SELECT
            context_type AS type,
            COUNT(*)::float AS total_count,
            COUNT(DISTINCT project_id)::float AS project_count
          FROM contexts
          WHERE archived_at IS NULL
          GROUP BY context_type
        ),
        focus_type_stats AS (
          SELECT context_type AS type, COUNT(*)::float AS project_count
          FROM contexts
          WHERE archived_at IS NULL AND project_id = $1
          GROUP BY context_type
        )
        SELECT
          g.type,
          g.total_count,
          g.project_count,
          CASE WHEN g.project_count > 0 THEN g.total_count / g.project_count ELSE 0 END AS avg_per_project,
          COALESCE(f.project_count, 0) AS project_count_for_type,
          CASE WHEN g.project_count > 0 THEN (g.total_count / g.project_count) - COALESCE(f.project_count, 0) ELSE 0 END AS gap
        FROM global_type_stats g
        LEFT JOIN focus_type_stats f ON f.type = g.type
        WHERE g.project_count > 1
        ORDER BY gap DESC
        LIMIT 10;
      `,
      [projectId]
    );

    const missingTags: KnowledgeGapMissingTag[] = missingTagsResult.rows.map(row => ({
      tag: row.tag,
      totalCount: Number(row.total_count ?? 0),
      projectCount: Number(row.project_count ?? 0),
      lastUsed: row.last_used ? new Date(row.last_used).toISOString() : null,
      topProjects: Array.isArray(row.top_projects)
        ? row.top_projects.map((project: any) => ({
            projectId: project.projectId ?? null,
            projectName: project.projectName,
            count: Number(project.count ?? 0),
          }))
        : [],
    }));

    const staleTags: KnowledgeGapStaleTag[] = staleTagsResult.rows.map(row => ({
      tag: row.tag,
      lastUsed: row.last_used ? new Date(row.last_used).toISOString() : null,
      daysSinceLastUsed: Number(row.days_since_last ?? 0),
      totalCount: Number(row.total_count ?? 0),
    }));

    const underrepresentedTypes: KnowledgeGapTypeInsight[] = typeGapResult.rows
      .filter(row => Number(row.gap ?? 0) > 0.5)
      .map(row => ({
        type: row.type,
        totalCount: Number(row.total_count ?? 0),
        globalProjectCount: Number(row.project_count ?? 0),
        averagePerProject: Number(row.avg_per_project ?? 0),
        projectCount: Number(row.project_count_for_type ?? 0),
        gap: Number(row.gap ?? 0),
      }));

    const summary: KnowledgeGapSummary = {
      projectContextCount: Number(focusSummary.context_count ?? 0),
      projectTagCount: Number(focusSummary.tag_count ?? 0),
      missingTagCount: missingTags.length,
      staleTagCount: staleTags.length,
      lastContextAt,
    };

    return {
      missingTags,
      staleTags,
      underrepresentedTypes,
      summary,
    };
  } catch (error) {
    logger.error('Error getting knowledge gap metrics', { error });
    throw new Error('Failed to get knowledge gap metrics');
  }
}
