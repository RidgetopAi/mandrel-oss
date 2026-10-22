/**
 * daySummary (Command frontend) — the single, named home for every tunable the
 * Calendar DAY-SUMMARY card + its PNG export use. The operator's standing rule:
 * configs-not-hardcoded — thresholds, geometry, and the export knobs live HERE as
 * named, env-overridable values, never as inline magic numbers in the component.
 */

/**
 * These helpers take the env VALUE, not the env NAME — call sites read
 * `import.meta.env.VITE_X` as a STATIC property access. A dynamic read
 * (`import.meta.env[name]`) defeats Vite's static replacement and inlines the
 * ENTIRE env object into the bundle, shipping every VITE_ var (including ones
 * with no reader) to every tenant. Banned by the `.eslintrc.cjs` env-access
 * rule and RED-gated by scripts/check-frontend-bundle-env.sh.
 */
function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function floatFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Strip trailing slashes so an origin concatenates cleanly with a `/r/<id8>` path. */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * THIS instance's own origin — an explicit VITE_DAY_SUMMARY_SHARE_BASE if one is set,
 * otherwise the origin the browser is actually on. There is deliberately NO hostname
 * literal in this function; the absent-window fallback is the empty string, which is
 * host-agnostic rather than someone else's host.
 */
function ownOrigin(): string {
  const explicit = import.meta.env.VITE_DAY_SUMMARY_SHARE_BASE;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return stripTrailingSlashes(explicit.trim());
  }
  if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') {
    return stripTrailingSlashes(window.location.origin);
  }
  return '';
}

/** The host part of an origin ('' when the origin is unknown or unparseable). */
function hostOf(origin: string): string {
  if (origin === '') return '';
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

export const DAY_SUMMARY_UI = {
  /** react-query stale window (ms) for a day's report — a day's history rarely moves. */
  staleTimeMs: intFromEnv(import.meta.env.VITE_DAY_SUMMARY_STALE_MS, 60_000),

  /** How many completed-task rows to list before collapsing the rest into "+N more". */
  maxTasksShown: intFromEnv(import.meta.env.VITE_DAY_SUMMARY_MAX_TASKS, 8),
  /** How many highlight (milestone/completion) cards to show. */
  maxHighlights: intFromEnv(import.meta.env.VITE_DAY_SUMMARY_MAX_HIGHLIGHTS, 5),

  /** Momentum ring geometry (SVG units). radius drives the stroke circumference. */
  ring: {
    size: intFromEnv(import.meta.env.VITE_DAY_SUMMARY_RING_SIZE, 104),
    radius: intFromEnv(import.meta.env.VITE_DAY_SUMMARY_RING_RADIUS, 44),
    stroke: intFromEnv(import.meta.env.VITE_DAY_SUMMARY_RING_STROKE, 9),
  },

  /** Activity-ribbon intensity thresholds (fraction of the day's peak hour). */
  ribbon: {
    hotFraction: floatFromEnv(import.meta.env.VITE_DAY_SUMMARY_RIBBON_HOT, 0.66),
    warmFraction: floatFromEnv(import.meta.env.VITE_DAY_SUMMARY_RIBBON_WARM, 0.33),
    /** Minimum visible bar height (%) so a non-zero hour is never invisible. */
    minBarPct: floatFromEnv(import.meta.env.VITE_DAY_SUMMARY_RIBBON_MIN_PCT, 3),
  },

  /** PNG export knobs — the shareable artifact (the operator posts it on X). */
  png: {
    /** devicePixelRatio multiplier for a crisp raster (2× = retina-sharp). */
    scale: intFromEnv(import.meta.env.VITE_DAY_SUMMARY_PNG_SCALE, 2),
    /** Solid backdrop painted behind the card (the app canvas colour). */
    background: import.meta.env.VITE_DAY_SUMMARY_PNG_BG || '#0A0C10',
    /** Download filename prefix; the day's date-key is appended. */
    filePrefix: import.meta.env.VITE_DAY_SUMMARY_PNG_PREFIX || 'mandrel-day',
  },

  /**
   * Base for the copy-link / shareable record URL (matches the /r/<id8> convention),
   * and the host shown in the exported PNG's watermark.
   *
   * NEVER a baked-in hostname. This bundle is built ONCE and served by EVERY tenant,
   * so a literal default here puts OUR Command UI into every tenant's share links and
   * every tenant's exported image — the exact customer-reported defect that
   * commandUrlConfig.ts was fixed for on the server side.
   *
   * SAME MECHANISM, not a second one. The server-side rule is "each instance emits its
   * OWN origin"; in the browser that value is already in hand — `window.location.origin`
   * IS this instance's own origin, with no build-time variable to plumb and nothing to
   * get wrong at provision time. It is the same posture apiConfig.ts already uses for
   * the API base (relative `/api`, deliberately host-agnostic).
   *
   * VITE_DAY_SUMMARY_SHARE_BASE remains as an explicit per-build override for a setup
   * whose share origin genuinely differs from the origin serving the app. Empty string
   * when there is no window (unit tests / SSR): relative, and belonging to nobody.
   */
  shareBase: ownOrigin(),
  /** Host portion of shareBase — what the PNG watermark shows. '' when unknown. */
  watermarkHost: hostOf(ownOrigin()),
} as const;

export default DAY_SUMMARY_UI;
