/**
 * embedding domain — the Embedding Analytics surface (`/api/embedding/*`, Command
 * backend). Every read is project-scoped; the projectId is sent as the
 * X-Project-ID header (an explicit header wins over the interceptor's default), so
 * a caller can request analytics for a specific project regardless of the globally
 * selected one. Return types reuse the generated Embedding* models.
 */
import { http } from '../request';
import { apiConfig } from '../../config/apiConfig';
import type { AxiosRequestConfig } from 'axios';
import type {
  EmbeddingDataset,
  EmbeddingSimilarityMatrix,
  EmbeddingProjection,
  EmbeddingClusterResult,
  EmbeddingQualityMetrics,
  EmbeddingProjectRelationships,
  EmbeddingKnowledgeGaps,
  EmbeddingUsagePatterns,
} from '../generated';

const scoped = (projectId?: string, params?: Record<string, unknown>): AxiosRequestConfig => ({
  params,
  headers: projectId ? { [apiConfig.projectHeader]: projectId } : undefined,
});

export const embeddingApi = {
  /** GET /api/embedding/list */
  list(projectId?: string): Promise<EmbeddingDataset[]> {
    return http.get<EmbeddingDataset[]>('/embedding/list', scoped(projectId));
  },

  /** GET /api/embedding/similarity */
  similarity(
    datasetId: string,
    rows: number,
    cols: number,
    projectId?: string
  ): Promise<EmbeddingSimilarityMatrix> {
    return http.get<EmbeddingSimilarityMatrix>(
      '/embedding/similarity',
      scoped(projectId, { id: datasetId, rows, cols })
    );
  },

  /** GET /api/embedding/projection */
  projection(
    datasetId: string,
    algo: string,
    n: number,
    projectId?: string
  ): Promise<EmbeddingProjection> {
    return http.get<EmbeddingProjection>(
      '/embedding/projection',
      scoped(projectId, { id: datasetId, algo, n })
    );
  },

  /** GET /api/embedding/cluster */
  cluster(datasetId: string, k: number, projectId?: string): Promise<EmbeddingClusterResult> {
    return http.get<EmbeddingClusterResult>(
      '/embedding/cluster',
      scoped(projectId, { id: datasetId, k })
    );
  },

  /** GET /api/embedding/metrics */
  metrics(datasetId: string, projectId?: string): Promise<EmbeddingQualityMetrics> {
    return http.get<EmbeddingQualityMetrics>(
      '/embedding/metrics',
      scoped(projectId, { id: datasetId })
    );
  },

  /** GET /api/embedding/relationships */
  relationships(projectId?: string): Promise<EmbeddingProjectRelationships> {
    return http.get<EmbeddingProjectRelationships>('/embedding/relationships', scoped(projectId));
  },

  /** GET /api/embedding/knowledge-gaps */
  knowledgeGaps(projectId?: string): Promise<EmbeddingKnowledgeGaps> {
    return http.get<EmbeddingKnowledgeGaps>('/embedding/knowledge-gaps', scoped(projectId));
  },

  /** GET /api/embedding/usage */
  usage(projectId?: string): Promise<EmbeddingUsagePatterns> {
    return http.get<EmbeddingUsagePatterns>('/embedding/usage', scoped(projectId));
  },
};

export type EmbeddingApi = typeof embeddingApi;
