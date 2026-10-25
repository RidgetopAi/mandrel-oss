/**
 * scopeConfig — the ONE merge between a page's per-request scope and a domain method's
 * own request config (page-scope epic §A1).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
 * A scoped page calls `api.<domain>.<method>(args, project.scope())`. `scope()` returns an
 * `AxiosRequestConfig` whose only job is to pin `X-Project-ID` for THAT request
 * (api/http/projectScope.ts). The domain method separately builds the query params the
 * endpoint needs. Both have to survive: dropping the caller's config loses the scope —
 * the exact silent-misplacement bug the foundation exists to close — and dropping the
 * built params loses the request.
 *
 * A plain `{ ...config, params }` looks correct and quietly discards any `params` the
 * caller put in the config. That is the shape of bug that reads fine in review, so the
 * merge lives in ONE place rather than being re-typed at each call site.
 *
 * The DOMAIN's params win on a key collision: the domain owns the endpoint's contract
 * (e.g. `project_id` is derived from the same selection `scope()` used), and a caller
 * silently overriding it is not a case any current call site has or should have.
 *
 * ── TWO FUNCTIONS, ONE IMPLEMENTATION ────────────────────────────────────────────────
 * `withParams` is the common case (nine call sites) and is kept as its own name because
 * that is what a domain method almost always needs. `withConfig` is the general form, for
 * the handful of methods that carry more than params — `contexts.export` (`responseType:
 * 'blob'`). `withParams`
 * delegates to it, so there is exactly ONE definition of the precedence rules and a
 * change to one cannot leave the other behind.
 *
 * This file was written by the timeviews stream and the foundation stream independently
 * and in parallel; this is the surviving copy, chosen because nine call sites already
 * used its signature. The foundation's `withRequestConfig` in api/request.ts was deleted
 * rather than kept alongside — two merge helpers with slightly different precedence is
 * precisely the drift a shared primitive exists to prevent.
 */
import type { AxiosRequestConfig } from 'axios';

/**
 * Merge a domain method's OWN config into the caller's scope config.
 *
 * Precedence, deliberate and asymmetric:
 *   • HEADERS  — merged, DOMAIN wins a collision. A domain header is that method's
 *     considered opinion about its own endpoint; a generic `scope()` must not override it.
 *     A caller header on a key the domain does not set survives untouched.
 *   • PARAMS and EVERYTHING ELSE (`responseType`, `timeout`, `signal`, …) — DOMAIN wins,
 *     same reason: the domain owns the wire contract.
 *
 * Returns `undefined` when there is nothing to send, so an unscoped call stays
 * byte-identical to what it was before the passthrough existed.
 */
export function withConfig(
  caller: AxiosRequestConfig | undefined,
  own: AxiosRequestConfig | undefined
): AxiosRequestConfig | undefined {
  if (!caller) {
    return own;
  }
  if (!own) {
    return caller;
  }
  const merged: AxiosRequestConfig = { ...caller, ...own };
  if (caller.headers || own.headers) {
    merged.headers = { ...(caller.headers ?? {}), ...(own.headers ?? {}) };
  }
  return merged;
}

/** The common case: fold a domain method's query params into the caller's scope config. */
export function withParams(
  config: AxiosRequestConfig | undefined,
  params: Record<string, unknown>
): AxiosRequestConfig {
  return {
    ...config,
    params: { ...((config?.params as Record<string, unknown>) ?? {}), ...params },
  };
}
