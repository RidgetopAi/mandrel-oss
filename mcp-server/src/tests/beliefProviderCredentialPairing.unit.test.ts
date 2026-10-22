/**
 * PROVIDER CREDENTIAL PAIRING — the belief layer refuses to send one provider's key to another
 * provider's host (reviewer finding N4). NO DB, NO network (fetch is a stub that
 * must never be called on the refusal paths).
 *
 * Asserted per refusal: the arm gate DISARMS, nothing is enqueued, fetch is never called, and the
 * ONE error names the provider and the setting to fix. Plus the CONTROL: a correctly configured
 * tiered setup (tier 1 subq explicit, tier 2 anthropic at defaults) arms.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BeliefAdjudicationQueue,
  triggerBeliefAdjudication,
  __resetBeliefArmStateForTest,
  __getBeliefArmStateForTest,
} from '../services/belief/beliefHook.js';
import { resolveArmableAdjudicationProvider } from '../services/belief/provider.js';
import {
  BELIEF_ADJUDICATOR_CONFIG,
  BELIEF_CONFIG,
  BELIEF_TIERED_CONFIG,
} from '../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig, BeliefTieredConfig } from '../config/beliefConfig.js';
import { logger } from '../utils/logger.js';

const NONE = { endpoint: false, apiBaseUrl: false, apiKeyEnvVar: false };
const single = (o: Partial<BeliefAdjudicatorConfig>): BeliefAdjudicatorConfig => ({
  ...BELIEF_ADJUDICATOR_CONFIG,
  explicit: NONE,
  ...o,
});
const tiered = (t1: Partial<BeliefAdjudicatorConfig>, t2: Partial<BeliefAdjudicatorConfig> = {}): BeliefTieredConfig => ({
  ...BELIEF_TIERED_CONFIG,
  tier1: { ...BELIEF_TIERED_CONFIG.tier1, explicit: NONE, ...t1 },
  tier2: { ...BELIEF_TIERED_CONFIG.tier2, explicit: NONE, ...t2 },
});

const source = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'context' as const,
  projectId: null,
  content: 'a record that wants adjudicating',
};
const enabled = { ...BELIEF_CONFIG, beliefEnabled: true };

function inertQueue(): BeliefAdjudicationQueue {
  return new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate: async () => undefined, defer: () => {} });
}

describe('belief provider credential pairing', () => {
  const fetchStub = vi.fn();
  const savedEnv = { ...process.env };

  beforeEach(() => {
    __resetBeliefArmStateForTest();
    fetchStub.mockReset();
    vi.stubGlobal('fetch', fetchStub);
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    process.env.SUBQ_API_KEY = 'test-subq';
    process.env.GROQ_API_KEY = 'test-groq';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  /** Run the real arm gate with the real resolver over the given config; return what happened. */
  function arm(cfg: BeliefAdjudicatorConfig, tiers: BeliefTieredConfig = BELIEF_TIERED_CONFIG) {
    const queue = inertQueue();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      triggerBeliefAdjudication(source, {
        cfg: enabled,
        queue,
        resolveProvider: () => resolveArmableAdjudicationProvider(cfg, tiers),
      });
      const logs = errorSpy.mock.calls.filter((c) => String(c[0]).includes('DISARMED'));
      return {
        state: __getBeliefArmStateForTest(),
        size: queue.size,
        logs,
        message: String((logs[0]?.[2] as { metadata?: { error?: string } } | undefined)?.metadata?.error),
      };
    } finally {
      errorSpy.mockRestore();
    }
  }

  function expectRefused(r: ReturnType<typeof arm>, provider: string, setting: string) {
    expect(r.state).toBe('disarmed');
    expect(r.size).toBe(0);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(r.logs.length, 'one error').toBe(1);
    expect(r.message).toContain(`"${provider}"`);
    expect(r.message).toContain(setting);
  }

  test('single mode: subq with no endpoint or key-env override is refused', () => {
    const r = arm(single({ provider: 'subq' }));
    expectRefused(r, 'subq', 'MANDREL_BELIEF_ADJUDICATOR_ENDPOINT');
  });

  test('single mode: subq with endpoint set but key-env left at the anthropic default is refused', () => {
    const r = arm(single({ provider: 'subq', endpoint: 'https://api.subq.ai', explicit: { ...NONE, endpoint: true } }));
    expectRefused(r, 'subq', 'MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV');
  });

  test('single mode: openai-compat with the key-env left at the anthropic default is refused', () => {
    const r = arm(
      single({
        provider: 'openai-compat',
        endpoint: 'https://api.groq.com/openai',
        explicit: { ...NONE, endpoint: true },
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      })
    );
    expectRefused(r, 'openai-compat', 'MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV');
  });

  test('tier 1 openai-compat with the tier-2 anthropic endpoint inherited is refused', () => {
    const r = arm(
      single({ provider: 'tiered' }),
      tiered({ provider: 'openai-compat', endpoint: 'https://api.anthropic.com' })
    );
    expectRefused(r, 'openai-compat', 'MANDREL_BELIEF_TIER1_ENDPOINT');
    expect(r.message).toContain('tier 1');
  });

  test('tier 2 anthropic with a foreign key-env it did not choose is refused', () => {
    const r = arm(single({ provider: 'tiered' }), tiered({}, { apiKeyEnvVar: 'GROQ_API_KEY' }));
    expectRefused(r, 'anthropic', 'MANDREL_BELIEF_TIER2_API_KEY_ENV');
  });

  test('CONTROL: tier 1 subq explicit + tier 2 anthropic at defaults arms', () => {
    const r = arm(
      single({ provider: 'tiered' }),
      tiered(
        {
          provider: 'subq',
          endpoint: 'https://api.subq.ai',
          apiKeyEnvVar: 'SUBQ_API_KEY',
          explicit: { endpoint: true, apiBaseUrl: false, apiKeyEnvVar: true },
        },
        {
          provider: 'anthropic',
          apiBaseUrl: 'https://api.anthropic.com',
          apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        }
      )
    );
    expect(r.state).toBe('armed');
    expect(r.size).toBe(1);
    expect(r.logs.length).toBe(0);
  });

  test('CONTROL: the shipped defaults (single anthropic; tiered groq+anthropic) still arm', () => {
    expect(arm(single({ provider: 'anthropic' })).state).toBe('armed');
    __resetBeliefArmStateForTest();
    expect(arm(single({ provider: 'tiered' }), tiered({}, {})).state).toBe('armed');
  });
});
