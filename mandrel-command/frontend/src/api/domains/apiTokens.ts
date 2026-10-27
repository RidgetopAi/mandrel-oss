/**
 * apiTokens domain — Settings → API tokens (`/api/api-tokens`, Command backend).
 * Per-user tokens that authenticate /mcp and the Punch List loop.
 *
 * The plaintext token exists ONLY in the value `create()` resolves to. Nothing here caches
 * or logs it; the caller holds it in component state for the show-once modal and drops it.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { ApiToken } from '../generated/models/ApiToken';

export type { ApiToken };

export interface CreatedApiToken {
  token: ApiToken;
  /** The token itself. Shown once; it cannot be fetched again. */
  plaintext: string;
}

export const apiTokensApi = {
  /** GET /api/api-tokens — the current user's un-revoked tokens, newest first. */
  async list(): Promise<ApiToken[]> {
    const body = await http.get<ApiEnvelope<{ tokens?: ApiToken[] }>>('/api-tokens');
    return unwrapData(body, 'Failed to list API tokens')?.tokens ?? [];
  },

  /** POST /api/api-tokens — mint a token for the current user. */
  async create(name: string): Promise<CreatedApiToken> {
    const body = await http.post<ApiEnvelope<CreatedApiToken>>('/api-tokens', { name });
    const data = unwrapData(body, 'Failed to create API token');
    if (!data?.plaintext || !data.token) {
      throw new Error('API token payload missing in response');
    }
    return data;
  },

  /** DELETE /api/api-tokens/:id — revoke one of the current user's tokens. */
  async revoke(id: string): Promise<void> {
    await http.del<ApiEnvelope<unknown>>(`/api-tokens/${encodeURIComponent(id)}`);
  },
};

export type ApiTokensApi = typeof apiTokensApi;
