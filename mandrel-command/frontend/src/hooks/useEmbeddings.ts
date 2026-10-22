import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import embeddingsClient from '../api/embeddingsClient';
import type {
  EmbeddingClusterResult,
  EmbeddingDataset,
  EmbeddingProjection,
  EmbeddingQualityMetrics,
  EmbeddingSimilarityMatrix,
  EmbeddingProjectRelationships,
  EmbeddingKnowledgeGaps,
  EmbeddingUsagePatterns,
} from '../api/generated';

const embeddingsQueryKeys = {
  all: ['embeddings'] as const,
  datasets: (projectId?: string) => [...embeddingsQueryKeys.all, 'datasets', projectId ?? 'none'] as const,
  similarity: (datasetId: string | undefined, rows: number, cols: number, projectId?: string) =>
    [...embeddingsQueryKeys.all, 'similarity', projectId ?? 'none', datasetId ?? 'none', rows, cols] as const,
  projection: (
    datasetId: string | undefined,
    algorithm: string,
    sampleSize: number,
    projectId?: string
  ) => [...embeddingsQueryKeys.all, 'projection', projectId ?? 'none', datasetId ?? 'none', algorithm, sampleSize] as const,
  clusters: (datasetId: string | undefined, clusterCount: number, projectId?: string) =>
    [...embeddingsQueryKeys.all, 'clusters', projectId ?? 'none', datasetId ?? 'none', clusterCount] as const,
  metrics: (datasetId: string | undefined, projectId?: string) =>
    [...embeddingsQueryKeys.all, 'metrics', projectId ?? 'none', datasetId ?? 'none'] as const,
  relationships: (projectId?: string) => [...embeddingsQueryKeys.all, 'relationships', projectId ?? 'none'] as const,
  knowledge: (projectId?: string) => [...embeddingsQueryKeys.all, 'knowledge', projectId ?? 'none'] as const,
  usage: (projectId?: string) => [...embeddingsQueryKeys.all, 'usage', projectId ?? 'none'] as const,
};

type QueryOptions<T> = Partial<UseQueryOptions<T>>;

export const useEmbeddingDatasets = (
  projectId: string | undefined,
  options?: QueryOptions<EmbeddingDataset[]>
) => {
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.datasets(projectId),
    queryFn: () => embeddingsClient.getDatasets(projectId),
    enabled: Boolean(projectId) && (enabled ?? true),
    staleTime: 5 * 60 * 1000,
    ...rest,
  });
};

export const useSimilarityMatrixQuery = (
  params: {
    datasetId: string | undefined;
    rows: number;
    cols: number;
    projectId?: string;
  },
  options?: QueryOptions<EmbeddingSimilarityMatrix>
) => {
  const { datasetId, rows, cols, projectId } = params;
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.similarity(datasetId, rows, cols, projectId),
    queryFn: () => {
      if (!datasetId) {
        throw new Error('Dataset ID is required for similarity matrix queries.');
      }
      if (!projectId) {
        throw new Error('Project context is required for similarity matrix queries.');
      }
      return embeddingsClient.getSimilarityMatrix(datasetId, rows, cols, projectId);
    },
    enabled: Boolean(datasetId && projectId) && (enabled ?? true),
    ...rest,
  });
};

export const useEmbeddingProjectionQuery = (
  params: {
    datasetId: string | undefined;
    algorithm: string;
    sampleSize: number;
    projectId?: string;
  },
  options?: QueryOptions<EmbeddingProjection>
) => {
  const { datasetId, algorithm, sampleSize, projectId } = params;
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.projection(datasetId, algorithm, sampleSize, projectId),
    queryFn: () => {
      if (!datasetId) {
        throw new Error('Dataset ID is required for embedding projection.');
      }
      if (!projectId) {
        throw new Error('Project context is required for embedding projection.');
      }
      return embeddingsClient.getProjection(datasetId, algorithm, sampleSize, projectId);
    },
    enabled: Boolean(datasetId && projectId) && (enabled ?? true),
    ...rest,
  });
};

export const useEmbeddingClustersQuery = (
  params: { datasetId: string | undefined; clusterCount: number; projectId?: string },
  options?: QueryOptions<EmbeddingClusterResult>
) => {
  const { datasetId, clusterCount, projectId } = params;
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.clusters(datasetId, clusterCount, projectId),
    queryFn: () => {
      if (!datasetId) {
        throw new Error('Dataset ID is required for embedding clusters.');
      }
      if (!projectId) {
        throw new Error('Project context is required for embedding clusters.');
      }
      return embeddingsClient.getClusters(datasetId, clusterCount, projectId);
    },
    enabled: Boolean(datasetId && projectId) && (enabled ?? true),
    ...rest,
  });
};

export const useEmbeddingMetricsQuery = (
  params: { datasetId: string | undefined; projectId?: string },
  options?: QueryOptions<EmbeddingQualityMetrics>
) => {
  const { datasetId, projectId } = params;
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.metrics(datasetId, projectId),
    queryFn: () => {
      if (!datasetId) {
        throw new Error('Dataset ID is required for embedding metrics.');
      }
      if (!projectId) {
        throw new Error('Project context is required for embedding metrics.');
      }
      return embeddingsClient.getQualityMetrics(datasetId, projectId);
    },
    enabled: Boolean(datasetId && projectId) && (enabled ?? true),
    ...rest,
  });
};

export const useEmbeddingRelationshipsQuery = (
  projectId: string | undefined,
  options?: QueryOptions<EmbeddingProjectRelationships>
) => {
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.relationships(projectId),
    queryFn: () => {
      if (!projectId) {
        throw new Error('Project context is required for relationship analytics.');
      }
      return embeddingsClient.getProjectRelationships(projectId);
    },
    enabled: Boolean(projectId) && (enabled ?? true),
    staleTime: 5 * 60 * 1000,
    ...rest,
  });
};

export const useEmbeddingKnowledgeGapsQuery = (
  projectId: string | undefined,
  options?: QueryOptions<EmbeddingKnowledgeGaps>
) => {
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.knowledge(projectId),
    queryFn: () => {
      if (!projectId) {
        throw new Error('Project context is required for knowledge gap analytics.');
      }
      return embeddingsClient.getKnowledgeGaps(projectId);
    },
    enabled: Boolean(projectId) && (enabled ?? true),
    staleTime: 5 * 60 * 1000,
    ...rest,
  });
};

export const useEmbeddingUsagePatternsQuery = (
  projectId: string | undefined,
  options?: QueryOptions<EmbeddingUsagePatterns>
) => {
  const { enabled, ...rest } = options ?? {};

  return useQuery({
    queryKey: embeddingsQueryKeys.usage(projectId),
    queryFn: () => {
      if (!projectId) {
        throw new Error('Project context is required for usage analytics.');
      }
      return embeddingsClient.getUsagePatterns(projectId);
    },
    enabled: Boolean(projectId) && (enabled ?? true),
    staleTime: 5 * 60 * 1000,
    ...rest,
  });
};
