/// <reference types="vite/client" />

/**
 * Client-exposed env vars. Vite only inlines vars prefixed `VITE_` (the old CRA
 * prefix was `REACT_APP_`, renamed 1:1 in the P0.1 Vite migration). Access via
 * `import.meta.env.VITE_*`. Anything NOT prefixed `VITE_` stays server-side.
 */
interface ImportMetaEnv {
  // API / transport
  readonly VITE_API_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_MCP_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_ERROR_ENDPOINT?: string;

  // Navigation / resolve
  readonly VITE_NAV_RESOLVE_BASE?: string;
  readonly VITE_NAV_SHORT_ID_MIN_LENGTH?: string;
  readonly VITE_NAV_SHORT_ID_MAX_LENGTH?: string;

  // Search highlight
  readonly VITE_HIGHLIGHT_MARK_CLASS?: string;
  readonly VITE_HIGHLIGHT_SCROLL_BEHAVIOR?: string;
  readonly VITE_HIGHLIGHT_SCROLL_BLOCK?: string;

  // Calendar day-summary card (see pages/calendar/daySummaryConfig.ts)
  readonly VITE_DAY_SUMMARY_STALE_MS?: string;
  readonly VITE_DAY_SUMMARY_MAX_TASKS?: string;
  readonly VITE_DAY_SUMMARY_MAX_HIGHLIGHTS?: string;
  readonly VITE_DAY_SUMMARY_RING_SIZE?: string;
  readonly VITE_DAY_SUMMARY_RING_RADIUS?: string;
  readonly VITE_DAY_SUMMARY_RING_STROKE?: string;
  readonly VITE_DAY_SUMMARY_RIBBON_HOT?: string;
  readonly VITE_DAY_SUMMARY_RIBBON_WARM?: string;
  readonly VITE_DAY_SUMMARY_RIBBON_MIN_PCT?: string;
  readonly VITE_DAY_SUMMARY_PNG_SCALE?: string;
  readonly VITE_DAY_SUMMARY_PNG_BG?: string;
  readonly VITE_DAY_SUMMARY_PNG_PREFIX?: string;
  readonly VITE_DAY_SUMMARY_SHARE_BASE?: string;

  // Punch board (see pages/punch/config.ts riskGateLabel)
  readonly VITE_PUNCH_RISK_GATE_LABEL?: string;

  // Behavioural tunables
  readonly VITE_AUTH_CLOCK_SKEW_MS?: string;
  readonly VITE_SEARCH_DEBOUNCE_MS?: string;
  readonly VITE_SEARCH_MIN_QUERY_LENGTH?: string;
  readonly VITE_SSE_INVALIDATION_DEBOUNCE_MS?: string;

  // Sentry
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENABLED?: string;
  readonly VITE_VERSION?: string;
  readonly VITE_BUILD_NUMBER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
