/**
 * QA Finding #2: React Query Integration with Generated OpenAPI Client
 * Configures the generated OpenAPI client for React Query usage
 */

import { OpenAPI } from './generated';
import { resolveProjectHeader } from './http/projectHeaders';
import { newCorrelationId } from '../utils/uuid';
import { apiConfig } from '../config/apiConfig';

const resolvedBase =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  '/api';

// Configure the generated OpenAPI client
OpenAPI.BASE = resolvedBase;
OpenAPI.WITH_CREDENTIALS = false;
OpenAPI.CREDENTIALS = 'include';

// Add authorization header if we have a token
OpenAPI.TOKEN = async () => {
  const token = localStorage.getItem('aidis_token');
  return token || '';
};

// Add headers including correlation ID. The X-Project-ID self-heal (UUID-validate
// or purge) is centralized in resolveProjectHeader() so this generated-client path
// and the axios interceptor (services/api.ts) can never drift.
OpenAPI.HEADERS = async () => {
  const headers: Record<string, string> = {
    [apiConfig.correlationHeader]: newCorrelationId(),
  };

  const projectId = resolveProjectHeader();
  if (projectId) {
    headers[apiConfig.projectHeader] = projectId;
  }

  return headers;
};

// Export configured client
export { OpenAPI };
export * from './generated';
