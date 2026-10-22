/**
 * Decisions configuration — the single, named home for every Decisions-screen tunable
 * (house rule configs-not-hardcoded). The list page size, query staleness, the
 * type/impact/outcome vocabularies, the type facets, and the outcome-filter options all
 * live here so the parts stay declarative.
 *
 * The typed-edge label + endpoint-dot vocabulary is REUSED from the shared
 * `config/graphEdges` module (not re-copied) and re-exported for the ThreadBox.
 */
import type { BadgeVariant } from '../../components/ui';

export { edgeLabel, kindDotVar, EDGE_LABELS, KIND_DOT_VAR } from '../../config/graphEdges';

export const DECISIONS_CONFIG = {
  /**
   * Max rows pulled per list read. The MCP `decision_search` does NOT accept a
   * `decision_type` filter (strict-mode reject, verified), so the type/impact/outcome
   * facets filter CLIENT-SIDE over this loaded window; `query`/`status`/dates are
   * server-side. A generous window keeps client-side facets useful; facet COUNTS come
   * from the real full-corpus stats (never fabricated, never windowed).
   *
   * Capped at 100 to match the MCP `decision_search` tool's max `limit`. The backend
   * also clamps to this cap, but the FE window is set honestly to the tool max rather
   * than relying on the clamp — a >100 request previously 500'd the whole page.
   */
  listLimit: 100,
  /** react-query staleTime for the Decisions reads. */
  staleTimeMs: 1000 * 60 * 2,
} as const;

/**
 * decision_type → { label, Badge tint, dot CSS var }. Keys are the real Mandrel
 * `decision_type` values. Anything unmapped falls back to a neutral tint / muted dot via
 * the resolver helpers.
 */
export const TYPE_META: Record<string, { label: string; tone: BadgeVariant; dotVar: string }> = {
  architecture: { label: 'architecture', tone: 'blue', dotVar: '--blue' },
  ui_ux: { label: 'ui/ux', tone: 'violet', dotVar: '--violet' },
  deployment: { label: 'deployment', tone: 'teal', dotVar: '--teal' },
  pattern: { label: 'pattern', tone: 'amber', dotVar: '--amber' },
  process: { label: 'process', tone: 'neutral', dotVar: '--tx-3' },
  testing: { label: 'testing', tone: 'green', dotVar: '--green' },
  tooling: { label: 'tooling', tone: 'teal', dotVar: '--teal' },
  api_design: { label: 'api design', tone: 'blue', dotVar: '--blue' },
  database: { label: 'database', tone: 'blue', dotVar: '--blue' },
  performance: { label: 'performance', tone: 'amber', dotVar: '--amber' },
  security: { label: 'security', tone: 'rose', dotVar: '--rose' },
  library: { label: 'library', tone: 'neutral', dotVar: '--tx-3' },
  naming_convention: { label: 'naming', tone: 'neutral', dotVar: '--tx-3' },
} as const;

export function typeLabel(type: string | undefined | null): string {
  if (!type) return 'decision';
  return TYPE_META[type]?.label ?? type.replace(/_/g, ' ');
}
export function typeTone(type: string | undefined | null): BadgeVariant {
  if (!type) return 'neutral';
  return TYPE_META[type]?.tone ?? 'neutral';
}
export function typeDotVar(type: string | undefined | null): string {
  if (!type) return '--tx-3';
  return TYPE_META[type]?.dotVar ?? '--tx-3';
}

/**
 * impact_level → { label, Badge tint, dot CSS var }. Mirrors the mock (medium=amber,
 * high=rose, low=muted) and extends it with critical (rose, most severe).
 */
export const IMPACT_META: Record<string, { label: string; tone: BadgeVariant; dotVar: string }> = {
  critical: { label: 'critical', tone: 'crit', dotVar: '--rose' },
  high: { label: 'high', tone: 'rose', dotVar: '--rose' },
  medium: { label: 'medium', tone: 'amber', dotVar: '--amber' },
  low: { label: 'low', tone: 'neutral', dotVar: '--tx-4' },
} as const;

export function impactLabel(impact: string | undefined | null): string {
  if (!impact) return '—';
  return IMPACT_META[impact]?.label ?? impact;
}
export function impactTone(impact: string | undefined | null): BadgeVariant {
  if (!impact) return 'neutral';
  return IMPACT_META[impact]?.tone ?? 'neutral';
}
export function impactDotVar(impact: string | undefined | null): string {
  if (!impact) return '--tx-4';
  return IMPACT_META[impact]?.dotVar ?? '--tx-4';
}

/**
 * outcomeStatus → { label, dot CSS var }. The learning-loop verdict shown as the list's
 * outcome chip + the reader's outcome pill. Humanized labels (never a raw slug).
 */
export const OUTCOME_META: Record<string, { label: string; dotVar: string }> = {
  successful: { label: 'successful', dotVar: '--green' },
  too_early: { label: 'too early', dotVar: '--blue' },
  mixed: { label: 'mixed', dotVar: '--amber' },
  failed: { label: 'failed', dotVar: '--rose' },
  unknown: { label: 'unknown', dotVar: '--tx-3' },
} as const;

export function outcomeLabel(outcome: string | undefined | null): string {
  if (!outcome) return 'unknown';
  return OUTCOME_META[outcome]?.label ?? outcome.replace(/_/g, ' ');
}
export function outcomeDotVar(outcome: string | undefined | null): string {
  if (!outcome) return '--tx-3';
  return OUTCOME_META[outcome]?.dotVar ?? '--tx-3';
}

/**
 * The decision_type facets shown in the filter bar (the mock's chips). Ordered by real
 * full-corpus prevalence. Counts are wired from `api.decisions.stats()` (by_type) — never
 * fabricated. Filtering is client-side over the loaded window (see listLimit note).
 */
export const TYPE_FACETS = [
  { value: 'process', label: 'process' },
  { value: 'architecture', label: 'architecture' },
  { value: 'deployment', label: 'deployment' },
  { value: 'ui_ux', label: 'ui/ux' },
  { value: 'pattern', label: 'pattern' },
] as const;

/** The outcome-filter dropdown options (the mock's "Outcome" select). */
export const OUTCOME_FILTER_OPTIONS = [
  { value: 'all', label: 'All outcomes' },
  { value: 'successful', label: 'Successful' },
  { value: 'too_early', label: 'Too early' },
  { value: 'mixed', label: 'Mixed' },
  { value: 'failed', label: 'Failed' },
  { value: 'unknown', label: 'Unknown' },
] as const;

export type OutcomeFilterValue = (typeof OUTCOME_FILTER_OPTIONS)[number]['value'];
