/**
 * request — the ONE typed transport the unified `api` domain modules ride.
 *
 * It is a thin, typed facade over the single shared axios instance (services/api
 * `apiClient`), which already carries: the bearer token, the X-Project-ID
 * self-heal header, the X-Correlation-ID, the DISCRIMINATING 401 force-logout
 * interceptor, Sentry breadcrumbs, and the relative `/api` base
 * (host-agnostic). Domain modules NEVER call axios/fetch directly — they call
 * `http.get/post/...`, so there is exactly one place that talks to the network.
 *
 * The backend-ownership split (`/api/*` Command backend vs `/api/v2/*` mcp-server)
 * is expressed ONLY as the path a domain method passes here; the caller of
 * `api.sessions.list()` vs `api.sessions.start()` cannot tell which backend serves
 * it. `/api/v2` is NOT versioning — it is an ownership boundary hidden at this layer.
 */
import { apiClient, type ApiError } from '../services/api';
import type { AxiosRequestConfig } from 'axios';

export type { ApiError };

/**
 * THE ONE WAY TO TURN A CAUGHT REJECTION INTO A SENTENCE FOR A HUMAN.
 *
 * ── THE BUG THIS EXISTS TO KILL ────────────────────────────────────────────────────────
 * Every error UI in this app was written as:
 *
 *     {err instanceof Error ? err.message : 'Something failed.'}
 *
 * which reads as "use the server's message when we have one". It never did. The shared
 * axios interceptor (services/api.ts) rejects with a PLAIN OBJECT LITERAL —
 * `Promise.reject({ message, code, status, details } as ApiError)` — and an object literal
 * is not an `Error`. So `instanceof Error` was FALSE for every single API failure, and all
 * 48 of those call sites always rendered their generic fallback. The server's message was
 * fetched, parsed, carried across the network and then thrown away at the last hop.
 *
 * MEASURED at the adapter seam, driving the real `projectsApi.remove` through the real
 * interceptor (see request.apiErrorMessage.test.ts):
 *     typeof: object | instanceof Error: false | .message: <the real server sentence>
 * The user saw: "Delete failed."
 *
 * That mattered most on the project-delete gate, whose entire purpose is
 * to tell a user what deleting a project would destroy: the backend measured 24 cascading
 * tables, composed the sentence, and the UI replaced it with "Delete failed."
 *
 * ── WHY A HELPER AND NOT A FIXED INTERCEPTOR ───────────────────────────────────────────
 * NOT because the interceptor cannot throw a real `Error`. It can: an `Error` SUBCLASS
 * carrying `.status`/`.code`/`.details` satisfies `instanceof Error` AND the callers that
 * read those fields off the rejection (useAuth.ts branches on `error.status === 401`), and
 * it would have fixed all 48 sites with a zero-line sweep. An earlier version of this
 * comment claimed those "are not `Error` fields" — that is false, and a stated obstacle
 * that isn't the real obstacle is the same over-wide sentence this whole change set exists
 * to correct. The three real reasons:
 *
 * 1. `instanceof Error` IS THE WRONG ANCHOR NO MATTER WHAT THE INTERCEPTOR THROWS. TWO
 *    shapes genuinely reach these call sites: the interceptor's object, and a real `Error`
 *    thrown by {@link unwrapData} on a `success:false` 2xx envelope. Fixing the interceptor
 *    would leave all 48 sites anchored on a CLASS that merely happens to be right today —
 *    verbatim the past incident tell, a guard and a product that agree until one moves. The
 *    helper anchors on `message`, the field every real rejection actually carries, so a
 *    third shape arriving tomorrow is handled rather than silently mis-read.
 *
 * 2. FLIPPING A SHARED RUNTIME CONTRACT FROM A FEATURE BRANCH IS THE past incident SHAPE.
 *    The rejection shape is depended on by 48 render sites plus an unknown number of
 *    `toEqual` assertions. A 42-file explicit diff is reviewable; a one-line change to what
 *    every failed request rejects with is not — it is exactly the kind of shared default
 *    that is green on its own branch and breaks something else on merge.
 *
 * 3. IT IS REVERSIBLE. If we later decide the interceptor should throw an `Error` subclass,
 *    this helper is still correct for it — case 1 above already covers real `Error`s. The
 *    two changes compose; this one does not foreclose that one.
 *
 * DUCK-TYPED ON `message`, NOT ON THE CLASS. That is the entire point: the previous code
 * anchored on the CLASS (`instanceof`), which is exactly the property that differs between
 * the two shapes while the thing it wanted — a human-readable `message` — is present on
 * both. Anchor on the field every real rejection actually carries.
 *
 * A blank/whitespace message is treated as ABSENT, so a server that answers `{message:''}`
 * yields the caller's fallback rather than an empty red box that says nothing.
 *
 * @param err      whatever landed in `catch` / `mutation.error` / `query.error`
 * @param fallback what to say when the rejection carries no usable message
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string') {
    return err.trim() !== '' ? err : fallback;
  }
  if (err !== null && typeof err === 'object') {
    // Covers BOTH a real `Error` (message on the prototype chain) and the interceptor's
    // plain `ApiError` literal. Never `instanceof` — see above.
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
  }
  return fallback;
}

/**
 * The Command backend + mcp-server both answer with this envelope. `data` carries
 * the typed payload; `success:false` (or an `error`) means a domain-level failure
 * even on a 2xx. Some endpoints (a few generated ones) return the payload raw —
 * {@link unwrapData} tolerates both.
 */
export interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: { message?: string; code?: string };
  message?: string;
}

/**
 * Unwrap the standard `{ success, data }` envelope to its typed payload. Throws a
 * plain Error (with the server's message when present) on `success:false`. A body
 * that is NOT an envelope (raw payload) is returned as-is.
 */
export function unwrapData<T>(body: ApiEnvelope<T> | T, failureMessage: string): T {
  if (body && typeof body === 'object' && 'success' in (body as object)) {
    const env = body as ApiEnvelope<T>;
    if (env.success === false) {
      throw new Error(env.error?.message || env.message || failureMessage);
    }
    return env.data as T;
  }
  return body as T;
}

/**
 * Typed HTTP verbs over the shared instance. Kept as an object (not destructured
 * functions) so tests can `vi.spyOn(http, 'get')` and domain methods pick it up.
 */
export const http = {
  get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return apiClient.get<T>(url, config);
  },
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return apiClient.post<T>(url, data, config);
  },
  put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return apiClient.put<T>(url, data, config);
  },
  patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return apiClient.patch<T>(url, data, config);
  },
  del<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return apiClient.delete<T>(url, config);
  },
};

export type Http = typeof http;
