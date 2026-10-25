/**
 * ADJUDICATION PROVIDER FACTORY (the belief-layer design §3/§9a).
 *
 * Selects the Stage-2 adjudicator implementation from config (BELIEF_ADJUDICATOR_CONFIG.
 * provider) — local-vs-API is a config flip, not a code change. Registers the single-providers
 * (`ollama`, `openai-compat`, `anthropic`) plus the COMPOSITE `tiered` provider (BL-11): a
 * Groq tier-1 prescreen that escalates the edge-producing verdicts to a Sonnet tier-2 confirm.
 *
 * The tiered provider COMPOSES the single-providers via `buildSingleProvider` (the switch below,
 * minus the `tiered` case) — so a tier accidentally configured as `provider:'tiered'` fails
 * closed with the unknown-provider error instead of recursing. Adding a new API provider later
 * is a new case in buildSingleProvider + a new class; the rest of the pipeline is untouched (it
 * depends on the AdjudicationProvider interface, not the impl).
 */

import { BELIEF_ADJUDICATOR_CONFIG, BELIEF_TIERED_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../../config/beliefConfig.js';
import { OllamaAdjudicator } from './ollamaAdjudicator.js';
import { OpenAICompatAdjudicator } from './openaiAdjudicator.js';
import { AnthropicAdjudicator } from './anthropicAdjudicator.js';
import { SubqAdjudicator } from './subqAdjudicator.js';
import { assertProviderCredentialPairing, assertProviderCredentialPresent } from './providerCredentialPairing.js';
import { createTieredAdjudicator } from './tieredAdjudicator.js';
import type { AdjudicationProvider } from './types.js';

/** Build a SINGLE (non-composite) adjudication provider. Has NO `tiered` case — it is what the
 *  tiered provider composes, so a tier of `provider:'tiered'` fails closed here (no recursion). */
function buildSingleProvider(cfg: BeliefAdjudicatorConfig): AdjudicationProvider {
  switch (cfg.provider) {
    case 'ollama':
      return new OllamaAdjudicator(cfg);
    case 'openai-compat':
      return new OpenAICompatAdjudicator(cfg);
    case 'anthropic':
      return new AnthropicAdjudicator(cfg);
    case 'subq':
      return new SubqAdjudicator(cfg);
    default:
      throw new Error(
        `Unknown belief adjudicator provider "${cfg.provider}". Known: ollama, openai-compat, anthropic, subq. ` +
          `(The composite 'tiered' provider is selected at the top level, not as a tier.) ` +
          `Set MANDREL_BELIEF_ADJUDICATOR_PROVIDER to a registered provider.`
      );
  }
}

/** Resolve the configured adjudication provider. Throws on an unknown provider key
 *  (fail-closed: better to stop the belief job than silently adjudicate with the wrong model). */
export function getAdjudicationProvider(
  cfg: BeliefAdjudicatorConfig = BELIEF_ADJUDICATOR_CONFIG
): AdjudicationProvider {
  if (cfg.provider === 'tiered') {
    // Composite: compose the two tier configs (BELIEF_TIERED_CONFIG) via the single-provider
    // path. Groq tier-1 prescreen → Sonnet tier-2 confirm on the escalate-family verdicts.
    return createTieredAdjudicator(buildSingleProvider, BELIEF_TIERED_CONFIG);
  }
  return buildSingleProvider(cfg);
}

/** The ARM-GATE resolver: refuse a mis-paired credential/host BEFORE any provider is built (and so
 *  before any request can be made), then resolve the provider. Throws ⇒ the belief layer disarms. */
export function resolveArmableAdjudicationProvider(
  cfg: BeliefAdjudicatorConfig = BELIEF_ADJUDICATOR_CONFIG,
  tiered = BELIEF_TIERED_CONFIG
): AdjudicationProvider {
  if (cfg.provider === 'tiered') {
    assertProviderCredentialPairing(tiered.tier1, 'tier 1', 'MANDREL_BELIEF_TIER1');
    assertProviderCredentialPairing(tiered.tier2, 'tier 2', 'MANDREL_BELIEF_TIER2');
    assertProviderCredentialPresent(tiered.tier1, 'tier 1', 'MANDREL_BELIEF_TIER1');
    assertProviderCredentialPresent(tiered.tier2, 'tier 2', 'MANDREL_BELIEF_TIER2');
  } else {
    assertProviderCredentialPairing(cfg, 'single mode', 'MANDREL_BELIEF_ADJUDICATOR');
    assertProviderCredentialPresent(cfg, 'single mode', 'MANDREL_BELIEF_ADJUDICATOR');
  }
  return getAdjudicationProvider(cfg);
}
