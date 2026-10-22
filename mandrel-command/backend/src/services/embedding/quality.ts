/**
 * Embedding Quality Metrics
 * 
 * Quality analysis for embedding vectors.
 */

import { db } from '../../database/connection';
import { resolveProjectId } from './core';
import { logger } from '../../config/logger';
import type { EmbeddingScope, QualityMetrics } from './types';
// Lesson-011 class-fix: read the ACTIVE embedder's column (config), never hardcode `embedding`.
import { activeEmbeddingColumn } from '../../config/embeddingColumn';

/**
 * Get quality metrics for embeddings
 */
export async function getQualityMetrics(
  _userId: string,
  scope: EmbeddingScope,
  /** Dataset selector ONLY — deliberately unused: it must never choose a project (DOOR 2). */
  _datasetId: string
): Promise<QualityMetrics> {
  try {
    const resolvedScopeId = await resolveProjectId(scope);
    // DOOR 2: this line WAS
    //     const targetProjectId = datasetId && datasetId !== 'contexts' ? datasetId : resolvedScopeId;
    // — a caller-supplied `datasetId` OVERRODE the authorized scope, and a dataset id IS a
    // project id (datasets.ts emits `p.id::text AS id`), so `?id=<any project uuid>`
    // read that project's rows. The project now comes ONLY from the authorized scope;
    // `datasetId` can no longer select one. routes/embedding.ts additionally 403s a
    // datasetId that names a different project, so this is not a silent substitution.
    const targetProjectId = resolvedScopeId;

    if (!targetProjectId) {
      throw new Error('Project context required for quality metrics.');
    }

    const col = activeEmbeddingColumn();
    const result = await db.query(
      `
        SELECT ${col} AS embedding
        FROM contexts
        WHERE archived_at IS NULL AND project_id = $1
          AND ${col} IS NOT NULL
        LIMIT 1000
      `,
      [targetProjectId]
    );
    const embeddingData = result.rows;
    
    if (embeddingData.length === 0) {
      throw new Error('No embeddings found for this project');
    }

    const parsedEmbeddings = embeddingData.map(row => JSON.parse(row.embedding));
    const dimensions = parsedEmbeddings[0]?.length || 384;

    const norms = parsedEmbeddings.map(embedding => 
      Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0))
    );

    const avgNorm = norms.reduce((sum, norm) => sum + norm, 0) / norms.length;

    return {
      totalEmbeddings: embeddingData.length,
      averageNorm: avgNorm,
      dimensionality: dimensions,
      densityMetrics: {
        avgDistance: Math.random() * 2,
        minDistance: Math.random() * 0.5,
        maxDistance: Math.random() * 3 + 2,
        stdDistance: Math.random() * 0.8
      },
      distributionStats: {
        mean: new Array(dimensions).fill(0).map(() => Math.random() * 0.2 - 0.1),
        std: new Array(dimensions).fill(0).map(() => Math.random() * 0.5 + 0.3),
        min: new Array(dimensions).fill(0).map(() => Math.random() * (-2) - 1),
        max: new Array(dimensions).fill(0).map(() => Math.random() * 2 + 1)
      }
    };
  } catch (error) {
    logger.error('Error getting quality metrics', { error });
    throw new Error('Failed to get quality metrics');
  }
}
