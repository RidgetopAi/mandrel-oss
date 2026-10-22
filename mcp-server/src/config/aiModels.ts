/**
 * aiModels — the SINGLE SOURCE OF TRUTH for the session "AI model" picker + the
 * server-side normalization applied at every write boundary.
 *
 * WHY (the auditor review C4 / §4.4): the model list was hardcoded
 * TWICE in the frontend (StartSessionModal + SessionEditModal) and NO write path
 * normalized it, so prod drifted — both `amp-smart` AND `amp smart`, both `amp-free`
 * AND `amp free`. This module is the ONE list (served to the frontend via the
 * `/api/v2/meta/ai-models` meta endpoint so both modals fetch it instead of hardcoding),
 * and `normalizeAiModel` is applied server-side at the REST `/start` and Command-backend
 * PUT boundaries so a value can never drift on whitespace/case again.
 *
 * DESIGN (per the operator + the auditor): PROVIDER + MODEL grain (not provider-only — the learning
 * loop wants model-grain analytics). The DB column stays TEXT; THIS config is the enum.
 * Env-extendable (configs-not-hardcoded): MANDREL_AI_MODELS_EXTRA lets ops add models
 * without a code change — comma-separated `value:label:provider` triples, e.g.
 *   MANDREL_AI_MODELS_EXTRA="claude-example-5:Claude Example 5:anthropic,grok-4:Grok 4:xai"
 */

export interface AiModelOption {
  /** The canonical, already-normalized value persisted to sessions.ai_model. */
  value: string;
  /** Human-facing label for the picker. */
  label: string;
  /** Provider family (for model-grain analytics + grouping). */
  provider: string;
}

/** The built-in models. Values here are ALREADY normalized (normalizeAiModel is idempotent on them). */
const BUILTIN_AI_MODELS: AiModelOption[] = [
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic' },
  { value: 'claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'anthropic' },
  { value: 'claude-opus-4', label: 'Claude Opus 4', provider: 'anthropic' },
  { value: 'claude-code', label: 'Claude Code', provider: 'anthropic' },
  { value: 'amp-free', label: 'Amp Free', provider: 'amp' },
  { value: 'amp-smart', label: 'Amp Smart', provider: 'amp' },
  { value: 'other', label: 'Other', provider: 'other' },
];

/**
 * Normalize a user-supplied AI model string so equivalent values collapse to one
 * canonical form: trim → lowercase → whitespace runs to a single hyphen → collapse
 * repeated hyphens → strip edge hyphens. Empty/blank/undefined → null (no model).
 * Idempotent. This is the whole fix for the 'amp smart' vs 'amp-smart' drift.
 */
export function normalizeAiModel(input?: string | null): string | null {
  if (input === undefined || input === null) return null;
  const normalized = String(input)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized === '' ? null : normalized;
}

/** Parse MANDREL_AI_MODELS_EXTRA ("value:label:provider,...") into options (best-effort). */
function parseExtraModels(raw: string | undefined): AiModelOption[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [value, label, provider] = entry.split(':').map((s) => s?.trim());
      const normValue = normalizeAiModel(value);
      if (!normValue) return null;
      return {
        value: normValue,
        label: label && label !== '' ? label : value,
        provider: provider && provider !== '' ? provider : 'other',
      } as AiModelOption;
    })
    .filter((m): m is AiModelOption => m !== null);
}

/**
 * The live model list = builtins + any env extras, de-duplicated by value (env extras
 * never override a builtin value). Read once at module load.
 */
export const AI_MODELS: AiModelOption[] = (() => {
  const byValue = new Map<string, AiModelOption>();
  for (const m of BUILTIN_AI_MODELS) byValue.set(m.value, m);
  for (const m of parseExtraModels(process.env.MANDREL_AI_MODELS_EXTRA)) {
    if (!byValue.has(m.value)) byValue.set(m.value, m);
  }
  return Array.from(byValue.values());
})();

/** True if the normalized value matches a known model in the config. */
export function isKnownAiModel(normalizedValue: string): boolean {
  return AI_MODELS.some((m) => m.value === normalizedValue);
}
