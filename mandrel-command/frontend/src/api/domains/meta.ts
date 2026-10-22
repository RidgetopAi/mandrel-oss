/**
 * meta domain — cross-cutting metadata. `aiModels()` hits `/api/v2/meta/ai-models`
 * (mcp-server), the ONLY `/api/v2/meta/*` surface the UI consumes (model dropdowns).
 * Like the sessions split, the `/v2` path is an ownership boundary hidden here — the
 * caller just calls `api.meta.aiModels()`.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';

export interface AiModel {
  id?: string;
  name?: string;
  label?: string;
  [key: string]: unknown;
}

export const metaApi = {
  /** GET /api/v2/meta/ai-models (mcp-server) */
  async aiModels(): Promise<AiModel[]> {
    const body = await http.get<ApiEnvelope<{ models?: AiModel[] }> | AiModel[]>(
      '/v2/meta/ai-models'
    );
    // Endpoint returns either `{ success, data: { models } }` or a raw array.
    if (Array.isArray(body)) {
      return body;
    }
    return unwrapData(body, 'Failed to fetch AI models')?.models ?? [];
  },
};

export type MetaApi = typeof metaApi;
