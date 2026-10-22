import { create } from 'zustand';

interface EmbeddingState {
  selectedDatasetId: string | null;
  activeTab: string;
  heatmapSize: { rows: number; cols: number };

  setSelectedDatasetId: (datasetId: string | null) => void;
  setActiveTab: (tab: string) => void;
  updateHeatmapSize: (size: { rows: number; cols: number }) => void;
}

/** The values a fresh session starts from — the single source for both create and reset. */
const INITIAL_STATE = {
  selectedDatasetId: null,
  activeTab: 'heatmap',
  heatmapSize: { rows: 50, cols: 50 },
} as const;

export const useEmbeddingStore = create<EmbeddingState>((set) => ({
  ...INITIAL_STATE,

  setSelectedDatasetId: (selectedDatasetId) => set({ selectedDatasetId }),
  setActiveTab: (activeTab) => set({ activeTab }),
  updateHeatmapSize: (heatmapSize) => set({ heatmapSize }),
}));

/**
 * Reset to a fresh session's state. Called on logout, from `resetAuthState`.
 *
 * ── WHY THIS IS TORN DOWN RATHER THAN EXCLUDED (review round 2) ───────
 * This is a module-lifetime singleton, so it survives a react-router logout like every
 * other one — and `resetAuthState`'s standing rule says anything that survives a route
 * change is handled there. Nothing here is a secret: `selectedDatasetId` is a dataset
 * selection, `activeTab`/`heatmapSize` are view state, none of it is persisted, and the
 * server authorizes every read regardless. So the honest options were "clear it" or
 * "write down why we don't".
 *
 * Clearing wins, and not because the risk is high. It is ONE line, and it removes a
 * judgement call from the rule: the moment the population is "everything that survives,
 * MINUS the ones someone decided were harmless", the next author has to re-derive that
 * decision for their module — and that re-derivation is exactly what failed three times
 * (the ambient project rungs, then this task's visited path). A rule with no exceptions
 * is cheaper to follow than a rule with one well-argued exception. A new user also has a
 * plain reason to expect a fresh UI, so nothing is lost by resetting.
 */
export const resetEmbeddingStore = (): void => {
  useEmbeddingStore.setState({ ...INITIAL_STATE });
};

export default useEmbeddingStore;
