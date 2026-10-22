/**
 * Deep-link helpers (frontend) — Feature A: per-record deep-link routes.
 *
 * The record detail routes (`/decisions/:id`, `/contexts/:id`, `/tasks/:id`)
 * share three concerns, centralized here so every detail page behaves
 * identically and the logic is unit-testable without React render infra
 * (the repo has none — see SessionDetail.uuid.test.tsx):
 *
 *  1. Whether to FETCH the record for a given `:id` (only real UUIDs — the
 *     backend by-id routes 400 on a non-UUID, matching isValidUuid gating used
 *     by ProjectDetail / SessionDetail).
 *  2. Whether the current state is NOT-FOUND (malformed id, load error, or a
 *     resolved-but-empty response) so the page can render a clean not-found
 *     state instead of a crash/blank.
 *  3. Parsing the optional `?q=<term>` highlight query, and building canonical
 *     in-app paths to these routes (for tab-reusing client-side navigation).
 */
import { isValidUuid } from './uuid';

/** The record kinds that have a dedicated deep-link detail route. */
export type RecordKind = 'decision' | 'context' | 'task';

/** Route base for each record kind (mirrors App.tsx route definitions). */
const RECORD_BASE: Record<RecordKind, string> = {
  decision: '/decisions',
  context: '/contexts',
  task: '/tasks',
};

/**
 * True only when `:id` is a real UUID the backend by-id route will accept.
 * A malformed/absent id must NOT fire a request guaranteed to 400/404.
 */
export function shouldFetchRecord(id: string | undefined): boolean {
  return isValidUuid(id);
}

/**
 * Centralized not-found predicate for a record detail page. Returns true when:
 *  - the id is malformed/absent (never fetched), OR
 *  - the fetch resolved with an error, OR
 *  - the fetch resolved with no record.
 * While a valid id is still loading it returns false (show a spinner, not
 * not-found).
 */
export function isRecordNotFound(opts: {
  id: string | undefined;
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
}): boolean {
  const { id, isLoading, isError, hasData } = opts;
  if (!shouldFetchRecord(id)) return true; // malformed / missing id
  if (isLoading) return false; // still resolving — not (yet) not-found
  return isError || !hasData; // resolved: error or empty => not found
}

/**
 * Parse the optional `?q=<term>` highlight query. Accepts either a raw search
 * string (`"?q=foo"` / `"q=foo"`) or a URLSearchParams (what react-router's
 * useSearchParams yields). Returns the trimmed term, or undefined when the
 * param is absent or blank — so a bare `?q=` never threads an empty string.
 */
export function getHighlightQuery(
  search: string | URLSearchParams
): string | undefined {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = params.get('q');
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the canonical in-app path to a record's detail route, optionally
 * carrying a `?q=` highlight term. Use with react-router client-side navigation
 * (Link / navigate) so opening a record REUSES the current tab rather than
 * spawning a new one.
 */
export function recordPath(kind: RecordKind, id: string, q?: string): string {
  const base = `${RECORD_BASE[kind]}/${id}`;
  const trimmed = q?.trim();
  return trimmed ? `${base}?q=${encodeURIComponent(trimmed)}` : base;
}
