import { useEffect, useMemo } from 'react';
import type { EmbeddingDataset } from '../api/generated';
import { useEmbeddingStore } from '../stores/embeddingStore';
import { useEmbeddingDatasets } from './useEmbeddings';

type UseEmbeddingDatasetSelectionResult = {
  datasetsQuery: ReturnType<typeof useEmbeddingDatasets>;
  datasets: EmbeddingDataset[];
  selectedDatasetId: string | null;
  setSelectedDatasetId: (datasetId: string | null) => void;
};

/**
 * Shared helper for embedding analytics components.
 * Keeps the selected dataset in sync across tabs and auto-selects the first
 * available dataset for the active project.
 */
export const useEmbeddingDatasetSelection = (
  projectId: string | undefined
): UseEmbeddingDatasetSelectionResult => {
  const { selectedDatasetId, setSelectedDatasetId } = useEmbeddingStore();
  const datasetsQuery = useEmbeddingDatasets(projectId, {
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
  });

  // Memoize datasets to prevent re-renders causing effect loops
  const datasets = useMemo(() => datasetsQuery.data ?? [], [datasetsQuery.data]);

  useEffect(() => {
    if (!projectId) {
      if (selectedDatasetId !== null) {
        setSelectedDatasetId(null);
      }
      return;
    }

    if (!selectedDatasetId && datasets.length > 0) {
      setSelectedDatasetId(datasets[0].id);
      return;
    }

    if (
      selectedDatasetId &&
      datasets.length > 0 &&
      !datasets.some(dataset => dataset.id === selectedDatasetId)
    ) {
      setSelectedDatasetId(datasets[0].id);
    }
  }, [projectId, datasets, selectedDatasetId, setSelectedDatasetId]);

  return {
    datasetsQuery,
    datasets,
    selectedDatasetId,
    setSelectedDatasetId,
  };
};

export default useEmbeddingDatasetSelection;
