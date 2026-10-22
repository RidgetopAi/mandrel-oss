/**
 * Embedding Service Module
 *
 * Barrel exports for embedding analytics functionality.
 *
 * Structure:
 * - core.ts          - Shared utilities (resolveProjectId, cosineSimilarity)
 * - datasets.ts      - Available embedding datasets
 * - visualization.ts - Matrix, projection, clustering
 * - quality.ts       - Embedding quality metrics
 * - relationships.ts - Project relationship graphs
 * - knowledgeGap.ts  - Missing/stale tag analysis
 * - usagePatterns.ts - Activity patterns
 */

// Types
export * from './types';

// Core utilities
export { resolveProjectId, cosineSimilarity } from './core';

// Domain functions
export { getAvailableDatasets } from './datasets';
export { getSimilarityMatrix, getProjection, getClusters } from './visualization';
export { getQualityMetrics } from './quality';
export { getProjectRelationships } from './relationships';
export { getKnowledgeGapMetrics } from './knowledgeGap';
export { getUsagePatterns } from './usagePatterns';

// Re-export as EmbeddingService class for backward compatibility
import { getAvailableDatasets } from './datasets';
import { getSimilarityMatrix, getProjection, getClusters } from './visualization';
import { getQualityMetrics } from './quality';
import { getProjectRelationships } from './relationships';
import { getKnowledgeGapMetrics } from './knowledgeGap';
import { getUsagePatterns } from './usagePatterns';

export class EmbeddingService {
  static getAvailableDatasets = getAvailableDatasets;
  static getSimilarityMatrix = getSimilarityMatrix;
  static getProjection = getProjection;
  static getClusters = getClusters;
  static getQualityMetrics = getQualityMetrics;
  static getProjectRelationships = getProjectRelationships;
  static getKnowledgeGapMetrics = getKnowledgeGapMetrics;
  static getUsagePatterns = getUsagePatterns;
}
