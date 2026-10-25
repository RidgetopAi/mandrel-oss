/**
 * TR001-6: Frontend API Client Hardening
 * Enhanced type-safe API client with V2 endpoint integration, validation, and retry logic
 * Integrates with Phase 5 V2 API endpoints at port 8080
 */

import { z } from 'zod';
import { logger } from '../utils/logger';
import { getValidToken } from '../utils/authToken';

// ================================
// CORE SCHEMAS & TYPES
// ================================

export const McpResponseSchema = z.object({
  success: z.boolean(),
  // The Mandrel MCP HTTP server (/mcp/tools/*) returns the tool payload under
  // `result`; older/V2 responses used `data`. Accept both so validation passes
  // regardless of which shape the server returns.
  result: z.any().optional(),
  data: z.any().optional(),
  error: z.string().optional(),
  version: z.string().optional(),
  requestId: z.string().optional(),
  processingTime: z.number().optional(),
});

export const ApiErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  details: z.any().optional(),
  requestId: z.string().optional(),
  timestamp: z.string().optional(),
});

export type McpResponse<T = any> = z.infer<typeof McpResponseSchema> & {
  data?: T;
  result?: T;
};

export type ApiError = z.infer<typeof ApiErrorSchema>;

// ================================
// RETRY CONFIGURATION
// ================================

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
  retryCondition?: (error: ApiError, attempt: number) => boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffFactor: 2,
  retryCondition: (error, _attempt) => {
    // Retry on network errors, timeouts, and 5xx server errors
    const retryableCodes = ['NETWORK_ERROR', 'TIMEOUT', 'ECONNREFUSED'];
    const retryableMessages = ['timeout', 'network', 'connection', 'server error'];

    if (retryableCodes.includes(error.code || '')) return true;
    if (retryableMessages.some(msg => error.message.toLowerCase().includes(msg))) return true;

    return false;
  }
};

// ================================
// AIDIS API CLIENT CLASS
// ================================

export class MandrelApiClient {
  private baseUrl: string;
  private timeout: number;
  private retryConfig: RetryConfig;

  constructor(config?: {
    baseUrl?: string;
    timeout?: number;
    retryConfig?: Partial<RetryConfig>;
  }) {
    // SINGLE TRUST BOUNDARY (an earlier task — durable F-01/F-04 fix): the browser no
    // longer talks to the mcp-server at all. Every call rides same-origin
    // /api/mcp/* to the authenticated Command BACKEND, which validates the login
    // JWT + per-user project access and attaches the internal MCP token
    // server-side (backend routes/mcp.ts). Same-origin also keeps the original
    // Private-Network-Access posture: no loopback fetch, no PNA prompt — /api is
    // routed to the backend on prod nginx and every tenant's Traefik alike.
    //
    // An explicit absolute http(s) VITE_MCP_URL is still honored for dev, but it
    // must now point at a COMMAND BACKEND's /api/mcp root (e.g.
    // http://localhost:5000/api/mcp) — NOT at an mcp-server; the public
    // /mcp/tools/* surface is blocked at the proxies by the same change.
    const envMcpUrl = import.meta.env.VITE_MCP_URL;
    const absoluteEnvUrl = envMcpUrl && /^https?:\/\//.test(envMcpUrl) ? envMcpUrl : '';
    this.baseUrl = config?.baseUrl || absoluteEnvUrl || '/api/mcp';
    this.timeout = config?.timeout || 30000;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config?.retryConfig };
  }

  // ================================
  // CORE REQUEST METHOD WITH RETRY
  // ================================

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = this.normalizeError(error, operationName);

        // Don't retry on last attempt
        if (attempt === this.retryConfig.maxRetries) {
          break;
        }

        // Check if we should retry this error
        if (!this.retryConfig.retryCondition?.(lastError, attempt)) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
          this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt),
          this.retryConfig.maxDelay
        );

        logger.warn(`API request failed (attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}). Retrying in ${delay}ms...`, {
          operation: operationName,
          error: lastError.message,
          requestId: lastError.requestId
        });

        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private normalizeError(error: any, operation: string): ApiError {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();

    if (error instanceof Error) {
      return {
        message: error.message,
        code: error.name === 'TypeError' ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR',
        details: { operation, originalError: error.message },
        requestId,
        timestamp
      };
    }

    if (typeof error === 'object' && error !== null) {
      return {
        message: error.message || 'Unknown error occurred',
        code: error.code || 'UNKNOWN_ERROR',
        details: error.details || { operation },
        requestId: error.requestId || requestId,
        timestamp: error.timestamp || timestamp
      };
    }

    return {
      message: String(error),
      code: 'UNKNOWN_ERROR',
      details: { operation },
      requestId,
      timestamp
    };
  }

  // ================================
  // HTTP REQUEST METHODS
  // ================================

  private async makeRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: any,
    options?: {
      headers?: Record<string, string>;
      validateResponse?: boolean;
    }
  ): Promise<McpResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    const requestId = `v2_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // The login JWT is THE credential for these calls: they land on the
    // authenticated Command backend (/api/mcp/*), whose authenticateToken requires it —
    // no token, no call. (Historically this header was the interim shield for
    // direct-to-mcp-server fetches; that direct path is retired.) getValidToken() returns
    // the present, unexpired token (or null). A caller-supplied Authorization in
    // options?.headers still wins.
    const authToken = getValidToken();

    const requestOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Version': '2.0.0',
        'X-Request-ID': requestId,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...options?.headers,
      },
      signal: AbortSignal.timeout(this.timeout),
    };

    if (body && method !== 'GET') {
      requestOptions.body = JSON.stringify(body);
    }

    const startTime = Date.now();

    try {
      const response = await fetch(url, requestOptions);
      const processingTime = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        let errorData;

        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText };
        }

        const error = new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
        (error as any).code = `HTTP_${response.status}`;
        (error as any).details = errorData;
        (error as any).requestId = requestId;
        (error as any).timestamp = new Date().toISOString();
        throw error;
      }

      const responseText = await response.text();
      let responseData;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        const error = new Error('Invalid JSON response from server');
        (error as any).code = 'PARSE_ERROR';
        (error as any).details = { responseText };
        (error as any).requestId = requestId;
        (error as any).timestamp = new Date().toISOString();
        throw error;
      }

      // Validate response if requested
      if (options?.validateResponse !== false) {
        const validation = McpResponseSchema.safeParse(responseData);
        if (!validation.success) {
          logger.warn('Response validation failed:', validation.error.issues);
          // Don't throw, just log warning for backward compatibility
        }
      }

      return {
        ...responseData,
        requestId: responseData.requestId || requestId,
        processingTime: responseData.processingTime || processingTime,
      };

    } catch (error: any) {
      if (error?.name === 'AbortError') {
        const error = new Error(`Request timeout after ${this.timeout}ms`);
        (error as any).code = 'TIMEOUT';
        (error as any).details = { timeout: this.timeout, url };
        (error as any).requestId = requestId;
        (error as any).timestamp = new Date().toISOString();
        throw error;
      }
      throw error;
    }
  }

  // ================================
  // V2 MCP API METHODS
  // ================================

  async getHealth(): Promise<{ status: string; version: string; toolsAvailable: number }> {
    return this.executeWithRetry(async () => {
      // mcp-server liveness, proxied by the backend (GET /api/mcp/healthz).
      const response = await this.makeRequest<{ status: string; version: string; toolsAvailable: number }>(
        'GET',
        '/healthz',
        undefined,
        { validateResponse: false }
      );
      return (response.result || response.data || response) as any;
    }, 'getHealth');
  }

  async listTools(): Promise<{ tools: string[] }> {
    return this.executeWithRetry(async () => {
      // GET /api/mcp/tools — the backend relays the mcp-server's { success, tools: [...] }.
      const response = await this.makeRequest<{ tools: string[] }>(
        'GET',
        '/tools',
        undefined,
        { validateResponse: false }
      );
      return (response as any).tools
        ? { tools: (response as any).tools }
        : response.result || response.data || { tools: [] };
    }, 'listTools');
  }

  async callTool<T = any>(toolName: string, args: Record<string, any> = {}): Promise<T> {
    return this.executeWithRetry(async () => {
      // POST /api/mcp/tools/<tool> with the args wrapped in { arguments } (the backend
      // forwards the body verbatim; the MCP HTTP server reads requestData.arguments).
      // Response shape: { success, result } — relayed byte-for-byte by the backend.
      // Only tools on the backend's read allow-list (config/mcpReadAllowlist.ts) pass;
      // anything else is 403 (the server-side half of the reads-only invariant below).
      const response = await this.makeRequest<T>(
        'POST',
        `/tools/${toolName}`,
        { arguments: args }
      );

      // KEY ON THE PAYLOAD, NOT THE FLAG. An IN-BAND
      // tool error is HTTP 200 with a real CallToolResult under `result` and no top-level
      // `error`; throwing on `success` alone replaced the tool's own prose with a generic
      // string exactly when the user needed to read it. Testing for the payload behaves
      // identically under both envelope shapes, so the browser bundle and the mcp-server
      // can deploy in either order.
      if (response.result === undefined && response.data === undefined) {
        const error = new Error(response.error || `Tool ${toolName} failed`);
        (error as any).code = 'TOOL_ERROR';
        (error as any).details = { toolName, args, response };
        (error as any).requestId = response.requestId;
        (error as any).timestamp = new Date().toISOString();
        throw error;
      }

      // MCP server nests the tool payload under `result`; tolerate `data` too.
      return (response.result ?? response.data) as T;
    }, `callTool:${toolName}`);
  }

  // ================================
  // SPECIFIC MANDREL TOOL METHODS
  // ================================
  //
  // ⚠️ INVARIANT — THE BROWSER MAKES ONLY MCP *READS*.
  //
  // A browser is a caller that cannot present a connection identity that means anything:
  // there is no such thing as a "stable X-Connection-ID" for a tab. Per-mount = a NEW
  // process-global slot per page load; per-user = two tabs of the same user fighting over
  // one slot, i.e. the same last-writer-wins bug at smaller scale. So the browser is
  // PERMANENTLY a member of the unidentified population that
  // mcp-server/src/services/callerIdentityGuard.ts defends against, and the only correct
  // posture is to make no call that guard can reject.
  //
  // Rejectable = any op whose opRegistry `effect` is 'write' or 'scope-switch' — INCLUDING
  // any op absent from the registry, because opEffect() defaults to 'write' (fail-closed).
  // Three wrappers were removed here rather than re-headered:
  //   - switchProject  (project_switch, effect 'scope-switch') → G1. Replaced by the UI's
  //     OWN selected-project state: the per-user default project (contexts/SettingsContext
  //     `defaultProjectId`) plus each page's own `usePageProject()` selection. (This line
  //     used to point at ProjectContext.selectProjectByName, deleted by the page-scope epic.)
  //   - storeContext   (context_store,  effect 'write')        → G2. UI error telemetry
  //     belongs in services/errorReporter.ts (Sentry + /api/monitoring/errors), not in the
  //     user's context knowledge base scoped to a slot nobody owns.
  //   - assignSession  (session_assign, ABSENT from the registry → 'write')  → G2. Dead
  //     wrapper with zero call sites; session MCP tools were deleted in Phase 6.
  //
  // This invariant is ENFORCED, not just documented: mandrelApiClient.identity.test.ts
  // derives the rejectable-op set from opRegistry.ts and fails if any of them is called
  // from anywhere under frontend/src. Do not add a write wrapper here — scope the write
  // through the authenticated Command backend REST API instead.

  async ping(message?: string): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.callTool('mandrel_ping', message ? { message } : {});
  }

  async getStatus(): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.callTool('mandrel_status');
  }

  async getCurrentProject(): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.callTool('project_current');
  }

  async listProjects(includeStats = false): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.callTool('project_list', { includeStats });
  }

  // switchProject() / storeContext() REMOVED — see the INVARIANT note above.

  async searchContexts(query: string, limit?: number, type?: string): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.callTool('context_search', { query, limit, type });
  }

  async getRecentContexts(limit?: number, projectId?: string): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.callTool('context_get_recent', { limit, projectId });
  }

  async getSessionStatus(): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.callTool('session_status');
  }

  // assignSession() REMOVED — see the INVARIANT note above.

  // ================================
  // UTILITY METHODS
  // ================================

  getRequestMetrics(): {
    baseUrl: string;
    timeout: number;
    retryConfig: RetryConfig;
  } {
    return {
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      retryConfig: this.retryConfig,
    };
  }

  updateConfig(config: {
    baseUrl?: string;
    timeout?: number;
    retryConfig?: Partial<RetryConfig>;
  }): void {
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.timeout) this.timeout = config.timeout;
    if (config.retryConfig) {
      this.retryConfig = { ...this.retryConfig, ...config.retryConfig };
    }
  }
}

// ================================
// SINGLETON INSTANCE & EXPORTS
// ================================

export const mandrelApi = new MandrelApiClient();

// Deprecated exports removed - were never imported

export default mandrelApi;