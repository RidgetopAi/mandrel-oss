/**
 * apiConfig — the single, named home for HTTP-client tunables (configs-not-
 * hardcoded). Every knob the unified API client reads lives HERE, env-overridable,
 * instead of as magic literals scattered through the transport/domain code.
 *
 * The base URL is deliberately RELATIVE (`/api`) so the client is host-agnostic:
 * the same bundle works on command.example.com, a per-tenant host, or a local
 * Vite dev proxy — nginx/Vite routes `/api/*` to whichever backend owns the path.
 * `/api/v2/*` is NOT a version bump — it is a backend-ownership boundary
 * (mcp-server vs the Command backend) that the domain layer hides from callers.
 */

/** Parse a positive integer from an env string, falling back on any bad value. */
const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Base URL for the unified client. Relative `/api` by default (host-agnostic).
 * Overridable via VITE_API_URL / VITE_API_BASE_URL for non-proxied setups.
 * Kept in the SAME precedence order the legacy clients used so nothing shifts.
 */
const resolveBaseUrl = (): string =>
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  '/api';

export const apiConfig = {
  /** Relative API base — see resolveBaseUrl(). */
  baseUrl: resolveBaseUrl(),
  /** Per-request timeout (ms). Override with VITE_API_TIMEOUT_MS. */
  timeoutMs: parsePositiveInt(import.meta.env.VITE_API_TIMEOUT_MS, 10_000),
  /**
   * Client-level retry budget for transient/network failures. Note: react-query
   * is the primary retry layer for query hooks; this is the transport-level
   * fallback for direct callers. Override with VITE_API_MAX_RETRIES.
   */
  maxRetries: parsePositiveInt(import.meta.env.VITE_API_MAX_RETRIES, 0),
  /** Correlation header name attached to every request for cross-service tracing. */
  correlationHeader: 'X-Correlation-ID',
  /** Project-scope header name (per-tenant / active-project routing). */
  projectHeader: 'X-Project-ID',
} as const;

export type ApiConfig = typeof apiConfig;
