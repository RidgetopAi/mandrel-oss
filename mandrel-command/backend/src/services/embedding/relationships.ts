/**
 * Project Relationship Analytics
 * 
 * Build project relationship graphs based on shared tags.
 */

import { db } from '../../database/connection';
import { resolveProjectId } from './core';
import { logger } from '../../config/logger';
import type { 
  EmbeddingScope, 
  ProjectRelationshipResponse, 
  ProjectRelationshipNode, 
  ProjectRelationshipEdge, 
  ProjectRelationshipSummary 
} from './types';

/**
 * Build project relationship graph centred on the active project.
 */
export async function getProjectRelationships(
  _userId: string,
  scope: EmbeddingScope
): Promise<ProjectRelationshipResponse> {
  try {
    const projectId = await resolveProjectId(scope);
    if (!projectId) {
      throw new Error('Project context required for relationship analytics.');
    }

    const focusSummaryQuery = `
      SELECT
        c.project_id,
        COALESCE(p.name, 'Selected Project') AS project_name,
        COUNT(DISTINCT c.id) AS context_count,
        COUNT(DISTINCT LOWER(tag)) AS tag_count
      FROM contexts c
      JOIN projects p ON p.id = c.project_id
      LEFT JOIN LATERAL UNNEST(c.tags) AS tag ON true
      WHERE c.archived_at IS NULL AND c.project_id = $1
      GROUP BY c.project_id, p.name
    `;

    const focusSummaryResult = await db.query(focusSummaryQuery, [projectId]);
    let focusRow = focusSummaryResult.rows[0];

    if (!focusRow) {
      const projectNameResult = await db.query(
        `SELECT name FROM projects WHERE id = $1`,
        [projectId]
      );
      focusRow = {
        project_id: projectId,
        project_name: projectNameResult.rows[0]?.name || 'Selected Project',
        context_count: 0,
        tag_count: 0,
      };
    }

    const relationshipsQuery = `
      WITH context_tags AS (
        SELECT
          c.project_id,
          LOWER(tag) AS tag,
          COUNT(*) AS tag_count
        FROM contexts c
        CROSS JOIN LATERAL UNNEST(c.tags) AS tag
        WHERE c.archived_at IS NULL
          AND c.tags IS NOT NULL
          AND array_length(c.tags, 1) > 0
        GROUP BY c.project_id, LOWER(tag)
      ),
      focus_tag_counts AS (
        SELECT tag, tag_count
        FROM context_tags
        WHERE project_id = $1
      ),
      other_tag_counts AS (
        SELECT project_id, tag, tag_count
        FROM context_tags
        WHERE project_id <> $1
      ),
      relationships AS (
        SELECT
          otc.project_id AS target_project_id,
          SUM(LEAST(focus.tag_count, otc.tag_count)) AS shared_tag_strength,
          COUNT(*) AS shared_tag_count
        FROM focus_tag_counts focus
        JOIN other_tag_counts otc ON otc.tag = focus.tag
        GROUP BY otc.project_id
      ),
      top_tags AS (
        SELECT
          otc.project_id AS target_project_id,
          focus.tag,
          LEAST(focus.tag_count, otc.tag_count) AS overlap_score,
          ROW_NUMBER() OVER (PARTITION BY otc.project_id ORDER BY LEAST(focus.tag_count, otc.tag_count) DESC) AS rank
        FROM focus_tag_counts focus
        JOIN other_tag_counts otc ON otc.tag = focus.tag
      )
      SELECT
        r.target_project_id,
        COALESCE(p.name, 'Unknown Project') AS project_name,
        COALESCE(cc.context_count, 0) AS context_count,
        r.shared_tag_strength,
        r.shared_tag_count,
        (
          SELECT ARRAY_AGG(tag)
          FROM (
            SELECT tag
            FROM top_tags tt
            WHERE tt.target_project_id = r.target_project_id AND tt.rank <= 5
            ORDER BY overlap_score DESC
            LIMIT 5
          ) sub
        ) AS top_shared_tags
      FROM relationships r
      LEFT JOIN projects p ON p.id = r.target_project_id
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS context_count
        FROM contexts
        WHERE archived_at IS NULL
        GROUP BY project_id
      ) cc ON cc.project_id = r.target_project_id
      WHERE r.shared_tag_strength > 0
      ORDER BY r.shared_tag_strength DESC, r.shared_tag_count DESC
      LIMIT 20;
    `;

    const relationshipsResult = await db.query(relationshipsQuery, [projectId]);

    const relatedProjects: ProjectRelationshipNode[] = relationshipsResult.rows.map(row => ({
      projectId: row.target_project_id,
      projectName: row.project_name,
      contextCount: Number(row.context_count ?? 0),
      tagCount: Number(row.shared_tag_count ?? 0),
      sharedTagCount: Number(row.shared_tag_count ?? 0),
      sharedTagStrength: Number(row.shared_tag_strength ?? 0),
    }));

    const edges: ProjectRelationshipEdge[] = relationshipsResult.rows.map(row => ({
      sourceProjectId: projectId as string,
      targetProjectId: row.target_project_id,
      sharedTagCount: Number(row.shared_tag_count ?? 0),
      sharedTagStrength: Number(row.shared_tag_strength ?? 0),
      topTags: (row.top_shared_tags ?? []) as string[],
    }));

    const summary: ProjectRelationshipSummary = {
      totalRelatedProjects: relatedProjects.length,
      totalSharedTagStrength: edges.reduce((sum, edge) => sum + edge.sharedTagStrength, 0),
      totalSharedTagCount: edges.reduce((sum, edge) => sum + edge.sharedTagCount, 0),
    };

    const focusProject: ProjectRelationshipNode = {
      projectId: focusRow.project_id,
      projectName: focusRow.project_name ?? 'Selected Project',
      contextCount: Number(focusRow.context_count ?? 0),
      tagCount: Number(focusRow.tag_count ?? 0),
    };

    return {
      focusProject,
      relatedProjects,
      edges,
      summary,
    };
  } catch (error) {
    logger.error('Error getting project relationships', { error });
    throw new Error('Failed to get project relationship metrics');
  }
}
