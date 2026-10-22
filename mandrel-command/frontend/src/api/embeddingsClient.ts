import { EmbeddingsService } from './generated';
import { resolveProjectHeader } from './http/projectHeaders';
import type {
  EmbeddingClusterResult,
  EmbeddingDataset,
  EmbeddingProjection,
  EmbeddingQualityMetrics,
  EmbeddingSimilarityMatrix,
  EmbeddingProjectRelationships,
  EmbeddingKnowledgeGaps,
  EmbeddingUsagePatterns,
} from './generated';

/**
 * PROJECT RESOLUTION HERE GOES THROUGH THE SHARED PATH (epic 41293984 §E).
 *
 * This module used to carry its OWN localStorage reader: two keys, three parse shapes,
 * its own UNASSIGNED check — a second, drifting copy of the rule that lives in
 * `resolveProjectHeader` (a past incident / C5: two paths doing one job). It accepted values
 * the shared resolver rejects (a bare string, a non-UUID) and it never purged a corrupt
 * value, so an id that wedged every other request kept being sent from here.
 *
 * It now delegates. The Embedding page passes its OWN project explicitly (one selector
 * for all 7 panels); `readStoredProjectId` is only the ambient fallback for a caller
 * that named none, and it is the SAME fallback ladder every other request uses.
 */
const readStoredProjectId = (): string | undefined => resolveProjectHeader();

const requireProjectId = (requested?: string): string => {
  if (requested) {
    return requested;
  }

  const projectId = readStoredProjectId();
  if (!projectId) {
    throw new Error('Select a project to view embedding analytics.');
  }
  return projectId;
};

export const embeddingsClient = {
  async getDatasets(projectId?: string): Promise<EmbeddingDataset[]> {
    const effectiveProjectId = projectId ?? readStoredProjectId();
    const params: { xProjectId?: string } = {};
    if (effectiveProjectId) {
      params.xProjectId = effectiveProjectId;
    }
    return EmbeddingsService.getEmbeddingList(params);
  },

  async getSimilarityMatrix(
    datasetId: string,
    rows: number,
    cols: number,
    projectId?: string
  ): Promise<EmbeddingSimilarityMatrix> {
    const effectiveProjectId = requireProjectId(projectId);
    return EmbeddingsService.getEmbeddingSimilarity({
      xProjectId: effectiveProjectId,
      id: datasetId,
      rows,
      cols,
    });
  },

  async getProjection(
    datasetId: string,
    algorithm: string,
    sampleSize: number,
    projectId?: string
  ): Promise<EmbeddingProjection> {
    const effectiveProjectId = requireProjectId(projectId);
    return EmbeddingsService.getEmbeddingProjection({
      xProjectId: effectiveProjectId,
      id: datasetId,
      algo: algorithm,
      n: sampleSize,
    });
  },

  async getClusters(
    datasetId: string,
    clusterCount: number,
    projectId?: string
  ): Promise<EmbeddingClusterResult> {
    const effectiveProjectId = requireProjectId(projectId);
    return EmbeddingsService.getEmbeddingCluster({
      xProjectId: effectiveProjectId,
      id: datasetId,
      k: clusterCount,
    });
  },

  async getQualityMetrics(
    datasetId: string,
    projectId?: string
  ): Promise<EmbeddingQualityMetrics> {
    const effectiveProjectId = requireProjectId(projectId);
    return EmbeddingsService.getEmbeddingMetrics({
      xProjectId: effectiveProjectId,
      id: datasetId,
    });
  },

  async getProjectRelationships(projectId?: string): Promise<EmbeddingProjectRelationships> {
    const effectiveProjectId = requireProjectId(projectId);
    return EmbeddingsService.getEmbeddingRelationships({
      xProjectId: effectiveProjectId,
    });
  },

  async getKnowledgeGaps(projectId?: string): Promise<EmbeddingKnowledgeGaps> {
    const effectiveProjectId = requireProjectId(projectId);
    return EmbeddingsService.getEmbeddingKnowledgeGaps({
      xProjectId: effectiveProjectId,
    });
  },

  async getUsagePatterns(projectId?: string): Promise<EmbeddingUsagePatterns> {
    const effectiveProjectId = requireProjectId(projectId);
    return EmbeddingsService.getEmbeddingUsage({
      xProjectId: effectiveProjectId,
    });
  },
};

export default embeddingsClient;
