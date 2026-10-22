/**
 * SUPERSESSION MODE FOLLOWS THE KEYS YOU SET.
 *
 * With MANDREL_BELIEF_ADJUDICATOR_PROVIDER unset: SUBQ+ANTHROPIC keys → tiered (tier 1 Snap),
 * SUBQ only → subq, ANTHROPIC only → anthropic, neither → off. An explicit provider always wins
 * over the keys; MANDREL_BELIEF_TIER1_PROVIDER overrides the Snap tier-1 default. The startup line
 * names the mode and key variable NAMES, never a value.
 *
 * Config is read at module load ⇒ each case resets modules and re-imports under a controlled env.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_NAMES = [
  'MANDREL_BELIEF_ENABLED',
  'MANDREL_BELIEF_ADJUDICATOR_PROVIDER',
  'MANDREL_BELIEF_ADJUDICATOR_ENDPOINT',
  'MANDREL_BELIEF_ADJUDICATOR_MODEL',
  'MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV',
  'MANDREL_BELIEF_TIER1_PROVIDER',
  'MANDREL_BELIEF_TIER1_MODEL',
  'MANDREL_BELIEF_TIER1_ENDPOINT',
  'MANDREL_BELIEF_TIER1_API_KEY_ENV',
  'SUBQ_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
];

const SUBQ_VALUE = 'sk-subq-SECRET-VALUE-0001';
const ANTHROPIC_VALUE = 'sk-ant-SECRET-VALUE-0002';

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const n of ENV_NAMES) delete process.env[n];
  vi.resetModules();
});

afterEach(() => {
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  vi.restoreAllMocks();
});

async function load() {
  return import('../config/beliefConfig.js');
}

describe('mode follows the keys when the provider is unset', () => {
  test.each([
    { name: 'both keys', subq: true, anthropic: true, mode: 'tiered' },
    { name: 'SubQ only', subq: true, anthropic: false, mode: 'subq' },
    { name: 'Anthropic only', subq: false, anthropic: true, mode: 'anthropic' },
    { name: 'no keys', subq: false, anthropic: false, mode: 'off' },
  ])('$name → $mode', async ({ subq, anthropic, mode }) => {
    if (subq) process.env.SUBQ_API_KEY = SUBQ_VALUE;
    if (anthropic) process.env.ANTHROPIC_API_KEY = ANTHROPIC_VALUE;
    const c = await load();
    expect(c.SUPERSESSION_MODE.mode).toBe(mode);
    expect(c.SUPERSESSION_MODE.source).toBe('keys');
    expect(c.BELIEF_CONFIG.beliefEnabled).toBe(mode !== 'off');
    if (mode !== 'off') expect(c.BELIEF_ADJUDICATOR_CONFIG.provider).toBe(mode);
  });

  test('tiered: tier 1 is subq / subq-snap-preview / SUBQ_API_KEY on the SubQ host; tier 2 is Sonnet', async () => {
    process.env.SUBQ_API_KEY = SUBQ_VALUE;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_VALUE;
    const c = await load();
    const { tier1, tier2 } = c.BELIEF_TIERED_CONFIG;
    expect(tier1.provider).toBe('subq');
    expect(tier1.model).toBe('subq-snap-preview');
    expect(tier1.apiKeyEnvVar).toBe('SUBQ_API_KEY');
    expect(tier1.endpoint).toBe(c.BELIEF_PROVIDER_CREDENTIAL_DEFAULTS.subq.endpoint);
    expect(tier2.provider).toBe('anthropic');
    expect(tier2.model).toBe('claude-sonnet-5');
    expect(tier2.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
  });

  test('subq single-tier runs Snap on its own host with its own key (passes the credential pairing guard)', async () => {
    process.env.SUBQ_API_KEY = SUBQ_VALUE;
    const c = await load();
    const a = c.BELIEF_ADJUDICATOR_CONFIG;
    expect([a.provider, a.model, a.endpoint, a.apiKeyEnvVar]).toEqual([
      'subq',
      'subq-snap-preview',
      'https://api.subq.ai',
      'SUBQ_API_KEY',
    ]);
    const { resolveArmableAdjudicationProvider } = await import('../services/belief/provider.js');
    expect(resolveArmableAdjudicationProvider().name).toBe('subq');
  });

  test('both keys: the arm gate builds the tiered provider', async () => {
    process.env.SUBQ_API_KEY = SUBQ_VALUE;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_VALUE;
    const { resolveArmableAdjudicationProvider } = await import('../services/belief/provider.js');
    const p = resolveArmableAdjudicationProvider() as unknown as { tiers: { tier1: { name: string }; tier2: { name: string } } };
    expect([p.tiers.tier1.name, p.tiers.tier2.name]).toEqual(['subq', 'anthropic']);
  });
});

describe('explicit settings beat the key-derived mode', () => {
  test('provider=ollama + both keys → ollama', async () => {
    process.env.MANDREL_BELIEF_ADJUDICATOR_PROVIDER = 'ollama';
    process.env.SUBQ_API_KEY = SUBQ_VALUE;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_VALUE;
    const c = await load();
    expect(c.SUPERSESSION_MODE).toMatchObject({ mode: 'ollama', source: 'explicit' });
    expect(c.BELIEF_ADJUDICATOR_CONFIG.provider).toBe('ollama');
  });

  test('provider=openai-compat with its endpoint + both keys → openai-compat', async () => {
    process.env.MANDREL_BELIEF_ADJUDICATOR_PROVIDER = 'openai-compat';
    process.env.MANDREL_BELIEF_ADJUDICATOR_ENDPOINT = 'http://127.0.0.1:8080';
    process.env.SUBQ_API_KEY = SUBQ_VALUE;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_VALUE;
    const c = await load();
    expect(c.SUPERSESSION_MODE).toMatchObject({ mode: 'openai-compat', source: 'explicit' });
    expect(c.BELIEF_ADJUDICATOR_CONFIG.provider).toBe('openai-compat');
    expect(c.BELIEF_ADJUDICATOR_CONFIG.endpoint).toBe('http://127.0.0.1:8080');
  });

  test('MANDREL_BELIEF_TIER1_PROVIDER=openai-compat overrides the Snap tier-1 default', async () => {
    process.env.SUBQ_API_KEY = SUBQ_VALUE;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_VALUE;
    process.env.MANDREL_BELIEF_TIER1_PROVIDER = 'openai-compat';
    const c = await load();
    expect(c.SUPERSESSION_MODE.mode).toBe('tiered');
    const t1 = c.BELIEF_TIERED_CONFIG.tier1;
    expect(t1.provider).toBe('openai-compat');
    expect(t1.model).toBe('openai/gpt-oss-120b');
    expect(t1.apiKeyEnvVar).toBe('GROQ_API_KEY');
  });
});

describe('startup mode line', () => {
  test('names the mode and key variable names; contains no key value', async () => {
    process.env.SUBQ_API_KEY = SUBQ_VALUE;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_VALUE;
    process.env.GROQ_API_KEY = 'gsk-SECRET-VALUE-0003';
    const c = await load();
    const hook = await import('../services/belief/beliefHook.js');
    const { logger } = await import('../utils/logger.js');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    hook.logBeliefStartupPosture(c.BELIEF_CONFIG, () => ({}));
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toContain('mode: tiered');
    expect(line).toContain('SUBQ_API_KEY');
    expect(line).toContain('ANTHROPIC_API_KEY');
    for (const secret of [SUBQ_VALUE, ANTHROPIC_VALUE, 'gsk-SECRET-VALUE-0003', 'SECRET-VALUE']) {
      expect(line).not.toContain(secret);
    }
  });

  test('off mode line names the mode and the unset key variables', async () => {
    const c = await load();
    const line = c.describeSupersessionMode();
    expect(line).toContain('mode: off');
    expect(line).toContain('SUBQ_API_KEY');
    expect(line).toContain('ANTHROPIC_API_KEY');
  });
});
