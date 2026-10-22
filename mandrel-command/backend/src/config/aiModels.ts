/**
 * aiModels (Command backend) — server-side AI-model NORMALIZATION for the session
 * write boundary (PUT /sessions/:id).
 *
 * SINGLE SOURCE OF TRUTH for the model LIST lives in the mcp-server config
 * (`mcp-server/src/config/aiModels.ts`) and is served to the frontend via the
 * `/api/v2/meta/ai-models` meta endpoint — the two modals fetch it, nothing is
 * hardcoded. This file intentionally holds ONLY the normalization RULE (a pure
 * function), NOT a second copy of the model list: the Command backend and the
 * mcp-server are separate services with no shared package, and normalization must run
 * at THIS write boundary too (the auditor review C4) so 'amp smart' can never diverge from
 * 'amp-smart' via the Command-UI edit path. Keep this rule byte-identical to
 * mcp-server's `normalizeAiModel`.
 */

/**
 * Normalize a user-supplied AI model string: trim → lowercase → whitespace runs to a
 * single hyphen → collapse repeated hyphens → strip edge hyphens. Empty/blank/undefined
 * → null (no model). Idempotent.
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
