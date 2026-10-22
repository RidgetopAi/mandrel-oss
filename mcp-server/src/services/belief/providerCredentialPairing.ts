/**
 * PROVIDER CREDENTIAL PAIRING — fail closed before one provider's key can reach another's host
 * (reviewer finding N4).
 *
 * The adjudicator configs share defaults (endpoint = local Ollama, key env = ANTHROPIC_API_KEY).
 * Selecting provider=subq or openai-compat without overriding them would send the Anthropic key
 * to an Ollama/other address. Rule: for each configured adjudicator, the key env name and the
 * endpoint must each be EXPLICIT (env set) or equal THAT provider's own default
 * (BELIEF_PROVIDER_CREDENTIAL_DEFAULTS). Otherwise this throws, naming provider + setting; the
 * arm gate turns the throw into a permanent DISARM, so no provider is built and no request made.
 */

import { BELIEF_PROVIDER_CREDENTIAL_DEFAULTS } from '../../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../../config/beliefConfig.js';

/**
 * @param label   where the adjudicator sits ('single mode' | 'tier 1' | 'tier 2') — for the message.
 * @param envPrefix the env prefix that configures it (e.g. MANDREL_BELIEF_TIER1) — for the message.
 */
export function assertProviderCredentialPairing(
  cfg: BeliefAdjudicatorConfig,
  label: string,
  envPrefix: string
): void {
  const own = BELIEF_PROVIDER_CREDENTIAL_DEFAULTS[cfg.provider];
  // Unknown provider: the factory's unknown-provider error is the right (and fail-closed) one.
  if (!own) return;

  const endpointEnv =
    own.endpointField === 'apiBaseUrl' ? 'MANDREL_BELIEF_ADJUDICATOR_API_BASE_URL' : `${envPrefix}_ENDPOINT`;
  const endpointValue = cfg[own.endpointField];
  if (!cfg.explicit?.[own.endpointField] && endpointValue !== own.endpoint) {
    throw new Error(
      `Belief adjudicator provider "${cfg.provider}" (${label}) would send its request to "${endpointValue}", ` +
        `which is not that provider's own host (${own.endpoint}) and was not set explicitly. ` +
        `Refusing to send a credential to a host that was only inherited. Set ${endpointEnv}.`
    );
  }

  if (own.keyEnvVar !== null && !cfg.explicit?.apiKeyEnvVar && cfg.apiKeyEnvVar !== own.keyEnvVar) {
    throw new Error(
      `Belief adjudicator provider "${cfg.provider}" (${label}) would read its API key from env var ` +
        `"${cfg.apiKeyEnvVar}", which is not that provider's own key (${own.keyEnvVar}) and was not set explicitly. ` +
        `Refusing to send another provider's key. Set ${envPrefix}_API_KEY_ENV.`
    );
  }
}

/**
 * CREDENTIAL PRESENCE — a provider that needs a key must have it BEFORE it is armed.
 * Anthropic's constructor throws on a missing key, but the openai-compat/subq constructors do not
 * (they would arm and then fail every record at call time). Keyless providers (ollama) and unknown
 * providers (the factory's own error applies) are skipped. Throws naming the missing env var.
 */
export function assertProviderCredentialPresent(
  cfg: BeliefAdjudicatorConfig,
  label: string,
  envPrefix: string
): void {
  const own = BELIEF_PROVIDER_CREDENTIAL_DEFAULTS[cfg.provider];
  if (!own || own.keyEnvVar === null) return;
  const key = process.env[cfg.apiKeyEnvVar]; // env-read: dynamic(API-key env var NAME is configurable)
  if (key === undefined || key === '') {
    throw new Error(
      `Belief adjudicator provider "${cfg.provider}" (${label}) needs an API key: env var ` +
        `"${cfg.apiKeyEnvVar}" is not set. Set ${cfg.apiKeyEnvVar} (or point ${envPrefix}_API_KEY_ENV at the env var that holds it).`
    );
  }
}
