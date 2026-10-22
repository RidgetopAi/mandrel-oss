/**
 * Embedding Visualization
 * 
 * Similarity matrix, PCA projection, and clustering.
 */

import { db } from '../../database/connection';
import { PCA } from 'ml-pca';
import { resolveProjectId, cosineSimilarity } from './core';
import type { EmbeddingScope, SimilarityMatrix, Projection, ClusterResult } from './types';
import { logger } from '../../config/logger';
// Lesson-011 class-fix: read the ACTIVE embedder's column (config), never hardcode `embedding`.
import { activeEmbeddingColumn } from '../../config/embeddingColumn';

/**
 * Get similarity matrix for embeddings
 */
export async function getSimilarityMatrix(
  _userId: string,
  scope: EmbeddingScope,
  /** Dataset selector ONLY — deliberately unused: it must never choose a project (DOOR 2). */
  _datasetId: string,
  rows: number,
  cols: number
): Promise<SimilarityMatrix> {
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
      throw new Error('Project context required for similarity matrix queries.');
    }

    const limit = Math.max(rows, cols);
    const col = activeEmbeddingColumn();

    const result = await db.query(
      `
        SELECT id, content, ${col} AS embedding
        FROM contexts
        WHERE archived_at IS NULL AND project_id = $1
          AND ${col} IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [targetProjectId, limit]
    );
    const embeddingData = result.rows;
    
    if (embeddingData.length === 0) {
      throw new Error('No embeddings found for this project');
    }

    const parsedEmbeddings = embeddingData.map(row => ({
      id: row.id,
      content: row.content.substring(0, 50) + '...',
      embedding: JSON.parse(row.embedding)
    }));

    const matrix: number[][] = [];
    const labels = parsedEmbeddings.map(e => e.content);

    for (let i = 0; i < Math.min(parsedEmbeddings.length, rows); i++) {
      const row: number[] = [];
      for (let j = 0; j < Math.min(parsedEmbeddings.length, cols); j++) {
        if (i === j) {
          row.push(1.0);
        } else {
          const similarity = cosineSimilarity(
            parsedEmbeddings[i].embedding,
            parsedEmbeddings[j].embedding
          );
          row.push(similarity);
        }
      }
      matrix.push(row);
    }

    return {
      matrix,
      labels: labels.slice(0, Math.min(rows, cols)),
      metadata: {
        rows: Math.min(parsedEmbeddings.length, rows),
        cols: Math.min(parsedEmbeddings.length, cols),
        datasetId: targetProjectId
      }
    };
  } catch (error) {
    logger.error('Error getting similarity matrix', { error });
    throw new Error('Failed to get similarity matrix');
  }
}

/**
 * Get 2D/3D projection using PCA
 */
export async function getProjection(
  _userId: string,
  scope: EmbeddingScope,
  /** Dataset selector ONLY — deliberately unused: it must never choose a project (DOOR 2). */
  _datasetId: string,
  algorithm: string,
  n: number
): Promise<Projection> {
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
      throw new Error('Project context required for projection queries.');
    }

    const col = activeEmbeddingColumn();
    const result = await db.query(
      `
        SELECT id, content, ${col} AS embedding
        FROM contexts
        WHERE archived_at IS NULL AND project_id = $1
          AND ${col} IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [targetProjectId, n]
    );
    const embeddingData = result.rows;
    
    if (embeddingData.length === 0) {
      throw new Error('No embeddings found for this project');
    }

    const parsedEmbeddings = embeddingData.map(row => ({
      id: row.id,
      content: row.content.substring(0, 100) + '...',
      embedding: JSON.parse(row.embedding)
    }));

    if (algorithm === 'pca' || algorithm === 'pca3d') {
      const matrix = parsedEmbeddings.map(item => item.embedding);
      
      const components = algorithm === 'pca3d' ? 3 : 2;
      const pca = new PCA(matrix, { center: true });
      
      const projected = pca.predict(matrix, { nComponents: components });
      
      const points = parsedEmbeddings.map((item, index) => {
        const point: any = {
          x: projected.get(index, 0),
          y: projected.get(index, 1),
          label: `Context ${item.id}`,
          content: item.content,
          id: item.id
        };
        if (algorithm === 'pca3d') {
          point.z = projected.get(index, 2);
        }
        return point;
      });

      return {
        points,
        algorithm,
        varianceExplained: pca.getExplainedVariance()
      };
    } else {
      throw new Error(`Algorithm ${algorithm} not yet implemented`);
    }
  } catch (error) {
    logger.error('Error getting projection', { error });
    throw new Error('Failed to get projection: ' + (error instanceof Error ? error.message : 'Unknown error'));
  }
}

/**
 * Get clustering results using k-means
 */
export async function getClusters(
  _userId: string,
  scope: EmbeddingScope,
  /** Dataset selector ONLY — deliberately unused: it must never choose a project (DOOR 2). */
  _datasetId: string,
  k: number
): Promise<ClusterResult> {
  try {
    const projection = await getProjection(_userId, scope, _datasetId, 'pca', 1000);
    
    // Simple k-means clustering (mock implementation for now)
    const points = projection.points.map(p => ({ ...p, cluster: Math.floor(Math.random() * k) }));
    
    const centroids = [];
    for (let i = 0; i < k; i++) {
      const clusterPoints = points.filter(p => p.cluster === i);
      if (clusterPoints.length > 0) {
        const avgX = clusterPoints.reduce((sum, p) => sum + p.x, 0) / clusterPoints.length;
        const avgY = clusterPoints.reduce((sum, p) => sum + p.y, 0) / clusterPoints.length;
        centroids.push({ x: avgX, y: avgY, cluster: i });
      }
    }

    return {
      points,
      centroids,
      k,
      inertia: Math.random() * 100
    };
  } catch (error) {
    logger.error('Error getting clusters', { error });
    throw new Error('Failed to get clusters');
  }
}
