import { useEffect, useState } from 'react';
import { apiErrorMessage } from '../api/request';

/**
 * useAiModels — fetches the SINGLE-SOURCE AI-model list from the mcp-server meta
 * endpoint (`/api/v2/meta/ai-models`, backed by mcp-server/src/config/aiModels.ts).
 *
 * WHY (the auditor review C4): the model list used to be hardcoded TWICE in the old antd
 * session modals, which drifted in prod ('amp smart' vs 'amp-smart'). This hook makes
 * the list live in exactly one place (the server config) and be fetched, never
 * hardcoded in the UI.
 *
 * STATUS: those old modals are gone; the current manual session
 * controls (NewSessionModal / SessionEditDrawer) don't yet expose model selection —
 * that field is deferred to the Sessions IA redesign, which will consume THIS hook.
 * Kept (not deleted) as the single-source model provider that redesign will wire.
 */
export interface AiModelOption {
  value: string;
  label: string;
  provider?: string;
}

const MCP_BASE_URL = import.meta.env.VITE_MCP_URL || '';
const AI_MODELS_URL = `${MCP_BASE_URL}/api/v2/meta/ai-models`;

const authHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('aidis_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

interface UseAiModelsResult {
  models: AiModelOption[];
  loading: boolean;
  error: string | null;
}

export function useAiModels(): UseAiModelsResult {
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(AI_MODELS_URL, { headers: authHeaders() });
        if (!res.ok) throw new Error(`ai-models fetch failed: ${res.status}`);
        const body = await res.json();
        const list: AiModelOption[] = body?.data?.models ?? [];
        if (!cancelled) {
          setModels(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(apiErrorMessage(e, 'Failed to load AI models'));
          setModels([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { models, loading, error };
}
