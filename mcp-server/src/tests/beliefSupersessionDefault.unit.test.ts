/**
 * SUPERSESSION IS QUIETLY OFF WITHOUT A KEY, ON WITH ONE.
 *
 * A stranger following the README quick start runs the server with no MANDREL_BELIEF_ENABLED and
 * usually no adjudicator key. The old code default was ON, so the first store logged a
 * "DISARMED" ERROR on a fresh install. The contract pinned here:
 *   1. flag UNSET + no credential  → off, ONE startup info line naming the enabling env var, no ERROR.
 *   2. flag UNSET + ANTHROPIC_API_KEY (provider unset) → arms with the single-tier anthropic provider.
 *   3. flag =true + no credential  → the single DISARMED error, later stores are no-ops; =false stays off.
 *   4. provider=tiered, ANTHROPIC_API_KEY only → disarms once at startup naming the tier-1 key env
 *      var, and no provider request is made.
 *
 * Config is read at module load, so each case resets modules and re-imports under a controlled env
 * (independent of the invoking environment's ANTHROPIC_API_KEY).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_NAMES = [
  'MANDREL_BELIEF_ENABLED',
  'MANDREL_BELIEF_ADJUDICATOR_PROVIDER',
  'MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV',
  'MANDREL_BELIEF_TIER1_API_KEY_ENV',
  'MANDREL_BELIEF_TIER2_API_KEY_ENV',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'SUBQ_API_KEY',
];

const source = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'context' as const,
  projectId: null,
  content: 'a record that wants adjudicating',
};

let saved: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const n of ENV_NAMES) delete process.env[n];
  fetchSpy = vi.fn(async () => {
    throw new Error('no provider request may be attempted in this test');
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
});

afterEach(() => {
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fresh module graph under the env the test just set. */
async function load() {
  const hook = await import('../services/belief/beliefHook.js');
  const cfgMod = await import('../config/beliefConfig.js');
  const provider = await import('../services/belief/provider.js');
  const { logger } = await import('../utils/logger.js');
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const queue = new hook.BeliefAdjudicationQueue({
    maxDepth: 10,
    concurrency: 1,
    adjudicate: async () => undefined,
    defer: () => undefined,
  });
  const resolveProvider = vi.fn(() => provider.resolveArmableAdjudicationProvider());
  const store = () => hook.triggerBeliefAdjudication(source, { cfg: cfgMod.BELIEF_CONFIG, queue, resolveProvider });
  return { hook, cfg: cfgMod.BELIEF_CONFIG, errorSpy, infoSpy, queue, resolveProvider, store };
}

describe('supersession default: off without a key, on with one', () => {
  test('(1) flag unset + no credential: no adjudication, no ERROR, exactly one startup info line naming the env var', async () => {
    const t = await load();
    expect(t.cfg.beliefEnabled).toBe(false);
    t.hook.logBeliefStartupPosture(t.cfg);
    t.store();
    t.store();
    expect(t.resolveProvider, 'no provider is even constructed').not.toHaveBeenCalled();
    expect(t.queue.size, 'nothing adjudicated').toBe(0);
    expect(t.errorSpy).not.toHaveBeenCalled();
    expect(t.infoSpy).toHaveBeenCalledTimes(1);
    expect(String(t.infoSpy.mock.calls[0][0])).toContain('ANTHROPIC_API_KEY');
    expect(String(t.infoSpy.mock.calls[0][0])).toContain('MANDREL_BELIEF_ENABLED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('(2) flag unset + provider unset + ANTHROPIC_API_KEY: arms with the single-tier anthropic provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
    const t = await load();
    expect(t.cfg.beliefEnabled).toBe(true);
    t.hook.logBeliefStartupPosture(t.cfg, t.resolveProvider);
    t.store();
    expect(t.hook.__getBeliefArmStateForTest()).toBe('armed');
    expect(t.queue.size, 'the record reaches the queue').toBe(1);
    const built = t.resolveProvider.mock.results[0].value as { name: string };
    expect(built.name, 'single-tier anthropic, not tiered').toBe('anthropic');
    expect(t.errorSpy).not.toHaveBeenCalled();
    expect(t.infoSpy, 'exactly the one mode line').toHaveBeenCalledTimes(1);
    expect(String(t.infoSpy.mock.calls[0][0])).toContain('mode: anthropic');
  });

  test('(3a) explicit true + no credential: DISARMED error once, later stores are no-ops', async () => {
    process.env.MANDREL_BELIEF_ENABLED = 'true';
    const t = await load();
    expect(t.cfg.beliefEnabled).toBe(true);
    for (let i = 0; i < 4; i++) t.store();
    const disarm = t.errorSpy.mock.calls.filter((c) => String(c[0]).includes('DISARMED'));
    expect(disarm.length).toBe(1);
    expect(t.hook.__getBeliefArmStateForTest()).toBe('disarmed');
    expect(t.queue.size).toBe(0);
    expect(t.resolveProvider).toHaveBeenCalledTimes(1);
  });

  test('(3b) explicit false + ANTHROPIC_API_KEY set: stays off, silently', async () => {
    process.env.MANDREL_BELIEF_ENABLED = 'false';
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
    const t = await load();
    expect(t.cfg.beliefEnabled).toBe(false);
    t.hook.logBeliefStartupPosture(t.cfg);
    t.store();
    expect(t.resolveProvider).not.toHaveBeenCalled();
    expect(t.queue.size).toBe(0);
    expect(t.errorSpy).not.toHaveBeenCalled();
    expect(t.infoSpy).not.toHaveBeenCalled();
  });

  test('(4) provider=tiered + ANTHROPIC_API_KEY but no tier-1 key: disarms once at startup naming SUBQ_API_KEY, no request', async () => {
    process.env.MANDREL_BELIEF_ADJUDICATOR_PROVIDER = 'tiered';
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
    const t = await load();
    expect(t.cfg.beliefEnabled, 'a present tier credential turns the unset default on').toBe(true);
    t.hook.logBeliefStartupPosture(t.cfg, t.resolveProvider);
    expect(t.hook.__getBeliefArmStateForTest()).toBe('disarmed');
    for (let i = 0; i < 3; i++) t.store();
    const disarm = t.errorSpy.mock.calls.filter((c) => String(c[0]).includes('DISARMED'));
    expect(disarm.length, 'once, at startup — not per record').toBe(1);
    const text = JSON.stringify(disarm[0]);
    expect(text).toContain('SUBQ_API_KEY');
    expect(t.resolveProvider).toHaveBeenCalledTimes(1);
    expect(t.queue.size).toBe(0);
    expect(fetchSpy, 'no provider request attempted').not.toHaveBeenCalled();
  });
});
