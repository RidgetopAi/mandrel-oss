/**
 * Tasks search: detecting an id-SHAPED query so it can do a SERVER-SIDE direct
 * lookup.
 *
 * THE GAP THIS CLOSES: `matchesSearch` (in Tasks.tsx) is a CLIENT-side substring
 * filter over only the already-fetched page — pasting a task id8 into the search box
 * only "finds" the task if it happens to be on screen already (same project scope,
 * within the page cap). The "paste an id → jump to any task" workflow (the whole
 * clickable `/r/<id8>` convention) needs a real server round-trip.
 *
 * SINGLE SOURCE OF ID RESOLUTION (a past incident — fix the class, don't drift N copies):
 * the server lookup reuses the EXISTING navigation resolver — `api.resolve.record`
 * → `GET /api/resolve/:id` → backend `resolveNavId()` — the SAME resolver the
 * `/r/<id8>` permalink 302 route uses. We do NOT invent a parallel task-by-id path.
 *
 * This module owns only the CLIENT-side DETECTION: "is this query id-shaped enough to
 * be worth a server resolve?". It MIRRORS the backend's `isResolvableNavId` shape rule
 * (utils/idResolver.ts) so the frontend never fires a request the backend would reject
 * with a guaranteed 400:
 *   - a full 8-4-4-4-12 UUID, OR
 *   - a pure-hex run (dashes allowed, as in a pasted dashed partial) whose length,
 *     once dashes are stripped, is at least the configured short-id floor (8).
 *
 * The floor lives in `navLinksConfig.shortIdMinLength` (config, env-overridable — the
 * same value the backend resolver uses), NOT a hardcoded 8 here. The floor is what the
 * task calls out: the server path needs the id8 floor to avoid unbounded prefix
 * matches, WITHOUT forcing an 8-char floor onto the ordinary prose/tag substring
 * filter (which stays exactly as it was — see `matchesSearch`).
 */
import { navLinksConfig } from '../../config/navLinks';

/** Full canonical UUID (8-4-4-4-12 hex). Mirrors the backend `isFullUuid`. */
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A run of hex with dashes allowed (a pasted full or dashed-partial id). */
const HEX_WITH_DASHES = /^[0-9a-f-]+$/i;

/**
 * Strip dashes + lowercase — mirrors the backend resolver's `normalizeShortId`, so the
 * id sent to `/api/resolve/:id` is the canonical dash-stripped form (the backend
 * re-normalizes anyway; normalizing here keeps the react-query key stable across the
 * dashed/undashed forms of the same id).
 */
export function normalizeSearchId(query: string): string {
  return query.trim().replace(/-/g, '').toLowerCase();
}

/**
 * Is this search query worth a SERVER-SIDE resolve? True only for an id-shaped query
 * the backend resolver would actually attempt (full UUID, or pure-hex ≥ the short-id
 * floor once dashes are stripped). Everything else (prose, tags, a short hex run) is
 * left to the existing client-side substring filter and never triggers a request.
 */
export function isServerResolvableId(query: string): boolean {
  if (typeof query !== 'string') return false;
  const q = query.trim();
  if (!q) return false;
  if (FULL_UUID.test(q)) return true;
  if (!HEX_WITH_DASHES.test(q)) return false;
  return normalizeSearchId(q).length >= navLinksConfig.shortIdMinLength;
}
