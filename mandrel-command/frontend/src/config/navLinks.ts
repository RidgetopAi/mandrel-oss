/**
 * In-UI interlinking configuration (Feature C) — named tunables, no magic numbers.
 *
 * Governs how id-shaped tokens inside rendered record content become clickable
 * links to the navigation landing route (/r/<id>), which resolves the bare id to
 * its record and drops the user into the typed detail page.
 *
 * All values are env-overridable (standing rule: tunables live in organized named
 * config, never hardcoded). The short-id length floor MIRRORS the backend resolver
 * (config/resolve.ts RESOLVE_SHORT_ID_MIN_LENGTH = 8): the frontend only linkifies
 * tokens the backend would actually attempt to resolve, so a link never lands on a
 * guaranteed 400.
 */

/**
 * Takes the env VALUE (a static `import.meta.env.VITE_X` read at the call site),
 * never the env NAME — a dynamic `import.meta.env[name]` read defeats Vite's
 * static replacement and inlines the ENTIRE env object into the bundle.
 * Banned by the `.eslintrc.cjs` env-access rule and RED-gated by
 * scripts/check-frontend-bundle-env.sh.
 */
function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const navLinksConfig = {
  /**
   * The client-side route that resolves a bare id → record. In-text id links and
   * short-id chips point here; ResolveRedirectPage handles it (calls the JSON
   * resolve endpoint, then client-side navigates to the typed detail page).
   */
  resolveRouteBase: import.meta.env.VITE_NAV_RESOLVE_BASE || '/r',

  /**
   * Minimum length (hex chars, dashes stripped) of a BARE short id we will linkify
   * inside prose. Below this a hex run is treated as ordinary text, never a link.
   * Mirrors the backend resolver's floor (8 = the short-id form every Mandrel
   * task/decision/context reference uses).
   */
  shortIdMinLength: intFromEnv(import.meta.env.VITE_NAV_SHORT_ID_MIN_LENGTH, 8),

  /**
   * Maximum length (hex chars) of a bare hex run we will linkify. A full undashed
   * UUID is 32 hex; anything longer (e.g. a 40-char sha1 / 64-char sha256 digest)
   * is NOT an id and must stay plain text — the upper bound is what prevents those
   * false positives.
   */
  shortIdMaxLength: intFromEnv(import.meta.env.VITE_NAV_SHORT_ID_MAX_LENGTH, 32),
} as const;

export default navLinksConfig;
