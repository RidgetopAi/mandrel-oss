/**
 * Frontend client for the navigation JSON resolve endpoint (GET /api/resolve/:id).
 *
 * Reuses the shared axios `apiClient` (bearer token + baseURL `/api` are applied by
 * its interceptors), so this file only maps the endpoint's four outcomes to a
 * discriminated union the /r landing route can switch on WITHOUT throwing:
 *   200            → { status: 'unique', record }
 *   409 ambiguous  → { status: 'ambiguous', candidates }   (never a silent pick)
 *   400 malformed  → { status: 'invalid', message }
 *   404 / other    → { status: 'notfound', message }       (fail-closed)
 *
 * The failure members CARRY the backend's `message`. The backend explains
 * exactly what happened — which shape rule was broken, or which record types were searched
 * and whether a project scope narrowed the search — and that explanation is useless if the
 * client throws it away and renders its own hardcoded sentence, which is what it used to do
 * (and that sentence had gone stale: it still named three types). `message` is optional so a
 * transport-level failure with no body still maps cleanly.
 *
 * The endpoint is the SAME resolveNavId as the /r/:id 302 route on the backend; the
 * only reason we call the JSON shape is that a 302 cannot be cleanly read by fetch.
 */

import apiClient, { type ApiError } from '../services/api';
import { globalReadConfig } from './http/projectScope';

/**
 * The record types /r/:id can resolve. Mirrors the backend's RESOLVABLE_TYPES
 * (backend/src/utils/idResolver.ts) — session/project added by an earlier task. This is a
 * TYPE-ONLY mirror: it never drives a query, it only names what can come back, so a stale
 * entry here degrades to a TS error at the call site rather than a wrong resolution.
 */
export type ResolvableType = 'decision' | 'task' | 'context' | 'session' | 'project';

export interface ResolvedNavRecord {
  type: ResolvableType;
  id: string;
  title: string;
  /** The typed detail-page path (e.g. /decisions/<uuid>) to navigate to. */
  url: string;
}

export interface NavCandidate {
  type: ResolvableType;
  id: string;
  title: string;
  url: string;
}

export type ResolveResult =
  | { status: 'unique'; record: ResolvedNavRecord }
  | { status: 'ambiguous'; candidates: NavCandidate[] }
  | { status: 'invalid'; message?: string }
  | { status: 'notfound'; message?: string };

interface ResolveSuccessBody {
  success: true;
  type: ResolvableType;
  id: string;
  title: string;
  url: string;
}

interface ResolveErrorBody {
  success?: false;
  error?: string;
  /** Human explanation of the failure, authored by the backend. Rendered verbatim. */
  message?: string;
  /** Which shape rule an invalid id broke: 'empty' | 'not-hex' | 'too-short'. */
  reason?: string;
  /** Which record types a not-found search covered. */
  searchedTypes?: string[];
  /** Whether a project scope narrowed that search. */
  projectScoped?: boolean;
  ambiguous?: boolean;
  candidates?: NavCandidate[];
}

/**
 * Resolve a bare id (short id or full UUID) to a navigation outcome. Never throws:
 * every failure maps to a fail-closed union member so the caller can render a clean
 * state (disambiguation / not-found) instead of crashing.
 */
export async function resolveNavRecord(id: string): Promise<ResolveResult> {
  try {
    // A GLOBAL READ (the reviewer B4, spec §A4). The backend resolves a short id inside a
    // `resolveListScope`, so with the ambient header pinned to the user's default this
    // search narrows to that ONE project and a short link to a record ANYWHERE ELSE 404s
    // — with the global switcher deleted, the user has no control left to unwedge it.
    // The explicit `project_id=all` sentinel makes the search "every project I may see"
    // (admin → all, everyone else → their grants) instead of "my default project". It
    // widens the FILTER, never the authorization: a record in a project the caller holds
    // no grant on is still a scoped MISS, which is the F-04 behaviour an earlier task built.
    const body = await apiClient.get<ResolveSuccessBody>(
      `/resolve/${encodeURIComponent(id)}`,
      globalReadConfig(),
    );
    return {
      status: 'unique',
      record: { type: body.type, id: body.id, title: body.title, url: body.url },
    };
  } catch (err) {
    const details = (err as ApiError | undefined)?.details as ResolveErrorBody | undefined;
    if (details?.ambiguous && Array.isArray(details.candidates)) {
      return { status: 'ambiguous', candidates: details.candidates };
    }
    if (details?.error === 'Invalid id') {
      return { status: 'invalid', message: details.message };
    }
    // 404, or any unexpected error → clean not-found (never a guessed jump). `message`
    // is undefined when there was no JSON body at all (network/transport failure); the
    // caller falls back to its own copy in that case rather than rendering "undefined".
    return { status: 'notfound', message: details?.message };
  }
}
