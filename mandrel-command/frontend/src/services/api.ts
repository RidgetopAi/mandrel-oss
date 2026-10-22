import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from '../utils/logger';
import { apiConfig } from '../config/apiConfig';
import { resolveProjectHeader } from '../api/http/projectHeaders';
import { newCorrelationId } from '../utils/uuid';
import { addBreadcrumb } from '../config/sentry';

// Legacy auth interfaces removed - use generated types from src/api/generated/models/

export interface ApiError {
  message: string;
  code?: string;
  /** HTTP status of the failed response, when there was one (0 for network errors). */
  status?: number;
  details?: any;
}

/**
 * Auth-critical endpoints.
 *
 * Only a 401 from one of THESE means the session itself is dead and a
 * force-logout is the correct response. A 401 from any OTHER (non-critical)
 * call — e.g. the `/projects/sessions/all` dashboard widget — must NOT destroy
 * the whole session: it fails that widget gracefully and the user stays logged
 * in. This is the bug that turned a transient stale-token blip on one widget
 * call into a full logout loop.
 *
 * Matching is path-suffix based and case-insensitive so it works regardless of
 * the configured baseURL (`/api`, absolute origin, etc.).
 */
const AUTH_CRITICAL_PATHS = [
  '/auth/login',
  '/auth/logout',
  '/auth/profile',
  '/auth/refresh',
  '/auth/me',
] as const;

export const isAuthCriticalUrl = (url?: string): boolean => {
  if (!url) {
    return false;
  }
  // Strip query string, then normalise to lowercase for the suffix check.
  const path = url.split('?')[0].toLowerCase();
  return AUTH_CRITICAL_PATHS.some((critical) => path.endsWith(critical));
};

class ApiClient {
  private _instance: AxiosInstance;
  
  get instance(): AxiosInstance {
    return this._instance;
  }

  constructor() {
    // baseURL + timeout come from the single named config (configs-not-hardcoded),
    // not magic literals. Relative `/api` keeps the client host-agnostic.
    this._instance = axios.create({
      baseURL: apiConfig.baseUrl,
      timeout: apiConfig.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor to add auth token and project ID
    this._instance.interceptors.request.use(
      (config) => {
        // Add auth token
        const token = localStorage.getItem('aidis_token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }

        // Add the AMBIENT X-Project-ID header — but ONLY for a request that did not
        // scope itself. The UUID-validate-or-purge self-heal is centralized in
        // resolveProjectHeader() so this axios path and the generated-OpenAPI header
        // resolver (api/client.ts) can never drift. Only a real-UUID id is
        // attached; a corrupt/synthetic/UNASSIGNED id is never sent AND the stored keys
        // are purged so the dashboard heals without the user clearing site data.
        //
        // ── "MENTIONED" IS THE TEST, NOT "TRUTHY" (epic 41293984 §A1) ──────────────
        // This used to read `if (!config.headers[header])`, which cannot distinguish
        // "the caller said nothing" from "the caller explicitly said NO project". A
        // page choosing the All-projects view sets the header to undefined on purpose;
        // under the truthy test that request was silently re-narrowed to the ambient
        // default project, so an "All projects" screen quietly showed one project's
        // rows. Measured by the §A1 guard (hooks/usePageProject.test.tsx), not
        // anticipated. Checking whether the KEY IS PRESENT makes the caller's intent
        // expressible in both directions; the key is then deleted so axios does not
        // serialize a header with no value.
        if (!Object.prototype.hasOwnProperty.call(config.headers, apiConfig.projectHeader)) {
          const projectId = resolveProjectHeader();
          if (projectId) {
            config.headers[apiConfig.projectHeader] = projectId;
          }
        } else if (config.headers[apiConfig.projectHeader] == null) {
          // An explicit opt-out: the caller wants NO project scope on this request.
          delete config.headers[apiConfig.projectHeader];
        }

        // Correlation id for cross-service tracing (parity with the OpenAPI client).
        if (!config.headers[apiConfig.correlationHeader]) {
          config.headers[apiConfig.correlationHeader] = newCorrelationId();
        }

        return config;
      },
      (error) => {
        logger.error('Request interceptor error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling
    this._instance.interceptors.response.use(
      (response) => response,
      (error) => {
        logger.error('API Response Error:', error.response?.data || error.message);

        // Leave a Sentry breadcrumb for every API failure so an eventual error
        // report carries the request trail. Never let telemetry throw into the
        // request path.
        try {
          addBreadcrumb(
            `API error ${error.response?.status ?? 'network'} ${error.config?.method ?? ''} ${error.config?.url ?? ''}`.trim(),
            'http',
            { status: error.response?.status, code: error.response?.data?.code }
          );
        } catch {
          /* telemetry must never break a request */
        }

        // DISCRIMINATING 401 HANDLING:
        // Force a logout ONLY when an AUTH-CRITICAL call 401s (the token is
        // genuinely dead). A 401 from a non-critical call (a dashboard widget,
        // etc.) must NOT nuke the session — that single call fails gracefully
        // and is rejected to its own caller, but the user stays logged in.
        // Previously ANY 401 cleared the token and hard-redirected to /login,
        // so one stale-token blip on the `/projects/sessions/all` widget call
        // produced a logout loop.
        if (
          error.response?.status === 401 &&
          isAuthCriticalUrl(error.config?.url)
        ) {
          // Token expired or invalid on an auth-critical request.
          localStorage.removeItem('aidis_token');
          localStorage.removeItem('aidis_user');
          window.location.href = '/login';
        }

        return Promise.reject({
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code,
          // Surface the HTTP status so callers can branch on it (e.g. the auth
          // profile query's `error.status === 401`), parity with the generated
          // client's ApiError.status now that auth rides this instance.
          status: error.response?.status ?? 0,
          details: error.response?.data,
        } as ApiError);
      }
    );
  }

  // Legacy authentication methods removed - use generated AuthenticationService instead
  // See: src/hooks/useAuth.ts for React Query auth hooks

  // Generic HTTP methods
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this._instance.get<T>(url, config);
    return response.data;
  }

  async post<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response = await this._instance.post<T>(url, data, config);
    return response.data;
  }

  async put<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response = await this._instance.put<T>(url, data, config);
    return response.data;
  }

  async patch<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response = await this._instance.patch<T>(url, data, config);
    return response.data;
  }

  async delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this._instance.delete<T>(url, config);
    return response.data;
  }

  // Health check
  async ping(): Promise<{ message: string; timestamp: string }> {
    const response = await this._instance.get<{ message: string; timestamp: string }>('/health');
    return response.data;
  }
}

// Export singleton instance
export const apiClient = new ApiClient();
export const apiService = apiClient;  // Alias for compatibility
export default apiClient;
