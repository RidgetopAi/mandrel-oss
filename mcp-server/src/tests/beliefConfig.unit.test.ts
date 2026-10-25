/**
 * beliefConfig — PURE-logic unit tests for the two-tier v1 config knobs (BL-1,  * an earlier milestone). NO DB, NO LLM.
 *
 * beliefConfig reads its knobs from env AT MODULE LOAD, so every case gets a FRESH module
 * instance (vi.resetModules + dynamic import) under a controlled env — the same pattern
 * reliableThreadingConfig.unit.test.ts / processLock.unit.test.ts use for a load-time
 * singleton. Zero DB.
 *
 * Locks the config contract:
 *   - NO HARD-MINT DIALS EXIST: `supersedeMinConfidence` and `mintMinCosine`
 *     were DELETED with the two-tier bar, and neither their keys nor their env vars may come
 *     back — a dial whose only effect is to promote a guess into an exclusion predicate is
 *     the defect, at any value,
 *   - the pairMinCosine NOMINATION floor (0.60), which is a live knob and unaffected,
 *   - the PINNED adjudicator defaults (anthropic / claude-sonnet-5 / omitTemperature true) that
 *     replaced the never-evaluated ollama/qwen2.5:1.5b default, all still env-overridable.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every env knob these tests touch — cleared before/after each test for isolation. */
const ENV_KEYS = [
  'MANDREL_BELIEF_MINT_MIN_COSINE',
  'MANDREL_BELIEF_PAIR_MIN_COSINE',
  'MANDREL_BELIEF_SUPERSEDE_MIN_CONFIDENCE',
  'MANDREL_BELIEF_ADJUDICATOR_PROVIDER',
  'MANDREL_BELIEF_ADJUDICATOR_MODEL',
  'MANDREL_BELIEF_ADJUDICATOR_OMIT_TEMPERATURE',
  'MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_TOOL_CHOICE',
  'MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING_TYPE',
  'MANDREL_BELIEF_SUBQ_SAME_SUBJECT_FROM',
  // BL-11 tiered knobs
  'MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS',
  'MANDREL_BELIEF_TIER1_PROVIDER',
  'MANDREL_BELIEF_TIER1_MODEL',
  'MANDREL_BELIEF_TIER1_ENDPOINT',
  'MANDREL_BELIEF_TIER1_API_KEY_ENV',
  'MANDREL_BELIEF_TIER1_SEND_TOP_K',
  'MANDREL_BELIEF_TIER1_OMIT_TEMPERATURE',
  'MANDREL_BELIEF_TIER2_PROVIDER',
  'MANDREL_BELIEF_TIER2_MODEL',
  'MANDREL_BELIEF_TIER2_OMIT_TEMPERATURE',
  'MANDREL_BELIEF_TIER2_ANTHROPIC_TOOL_CHOICE',
  'MANDREL_BELIEF_TIER2_ANTHROPIC_THINKING_TYPE',
  // BL-9 live-hook knobs
  'MANDREL_BELIEF_ENABLED',
  'MANDREL_BELIEF_QUEUE_MAX_DEPTH',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** Fresh module instance under the given env overrides (undefined = leave unset). */
async function freshConfig(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  clearEnv();
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  vi.resetModules();
  return import('@/config/beliefConfig');
}

beforeEach(clearEnv);
afterEach(clearEnv);

// Clearing ENV_KEYS is this file's whole point (it proves the SHIPPED DEFAULTS), but the
// clear must not outlive the file: process.env is shared by every test file in the run
// (vitest.config pins the suite to ONE fork). vitest.setup.ts deliberately pins
// MANDREL_BELIEF_ENABLED='false' to DISARM the live belief hook, whose default provider is a
// REAL Anthropic/Groq call the suite must never make — and beliefConfig.ts defaults
// beliefEnabled to TRUE when the var is unset. So leaving it deleted re-ARMS the hook for
// any file that runs afterwards without re-running setup. Snapshot at the file boundary and
// restore, so the intra-file semantics above are unchanged and nothing escapes.
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    const prior = ENV_SNAPSHOT[k];
    if (prior === undefined) delete process.env[k];
    else process.env[k] = prior;
  }
});

describe('beliefConfig — THE HARD-MINT DIALS ARE GONE', () => {
  // WHAT THIS REPLACED. The deleted tests asserted the two dials' defaults (0.9 / 0.75),
  // their env overrides, their garbage-value fallback, and that mintMinCosine sat above
  // pairMinCosine. That coverage is not weakened, it is void: the knobs do not exist. These
  // assertions guard the thing that actually matters now — that they cannot come back
  // silently, including via env, which is how a "temporary" re-enable would arrive.
  it('BELIEF_CONFIG carries NO supersedeMinConfidence / mintMinCosine key', async () => {
    const c = await freshConfig();
    expect(c.BELIEF_CONFIG).not.toHaveProperty('supersedeMinConfidence');
    expect(c.BELIEF_CONFIG).not.toHaveProperty('mintMinCosine');
  });

  it('setting the old env vars has NO effect — no key appears, nothing is read', async () => {
    const c = await freshConfig({
      MANDREL_BELIEF_SUPERSEDE_MIN_CONFIDENCE: '0.5',
      MANDREL_BELIEF_MINT_MIN_COSINE: '0.1',
    });
    expect(c.BELIEF_CONFIG).not.toHaveProperty('supersedeMinConfidence');
    expect(c.BELIEF_CONFIG).not.toHaveProperty('mintMinCosine');
  });

  it('the pairMinCosine NOMINATION floor is untouched (0.60, still env-overridable)', async () => {
    // Control: this asserts the two tests above are measuring an absent key rather than a
    // broken module — a config that failed to load would also "not have" the dials.
    const c = await freshConfig();
    expect(c.BELIEF_CONFIG.pairMinCosine).toBe(0.6);
    const overridden = await freshConfig({ MANDREL_BELIEF_PAIR_MIN_COSINE: '0.5' });
    expect(overridden.BELIEF_CONFIG.pairMinCosine).toBe(0.5);
  });
});

describe('beliefConfig — pinned adjudicator defaults (BL-1)', () => {
  it('pins the evaluated operating point (anthropic / claude-sonnet-5 / omitTemperature true)', async () => {
    const c = await freshConfig();
    expect(c.BELIEF_ADJUDICATOR_CONFIG.provider).toBe('anthropic');
    expect(c.BELIEF_ADJUDICATOR_CONFIG.model).toBe('claude-sonnet-5');
    expect(c.BELIEF_ADJUDICATOR_CONFIG.omitTemperature).toBe(true);
    // The request shape prod's Sonnet-5 path sends: FORCED record_verdict tool and
    // no thinking field. 'auto' / a thinking type are Sonnet-5.5 opt-ins by env, never the default.
    expect(c.BELIEF_ADJUDICATOR_CONFIG.anthropicToolChoice).toBe('tool');
    expect(c.BELIEF_ADJUDICATOR_CONFIG.anthropicThinkingType).toBe('');
  });

  it('keeps every pinned default env-overridable (ollama still reachable by env)', async () => {
    const c = await freshConfig({
      MANDREL_BELIEF_ADJUDICATOR_PROVIDER: 'ollama',
      MANDREL_BELIEF_ADJUDICATOR_MODEL: 'qwen2.5:1.5b',
      MANDREL_BELIEF_ADJUDICATOR_OMIT_TEMPERATURE: 'false',
    });
    expect(c.BELIEF_ADJUDICATOR_CONFIG.provider).toBe('ollama');
    expect(c.BELIEF_ADJUDICATOR_CONFIG.model).toBe('qwen2.5:1.5b');
    expect(c.BELIEF_ADJUDICATOR_CONFIG.omitTemperature).toBe(false);
  });
});

describe('beliefConfig — tiered config (BL-11: Groq prescreen → Sonnet confirm)', () => {
  it('defaults the escalation set to the edge-producing family {supersedes,contests}', async () => {
    const c = await freshConfig();
    expect(c.BELIEF_TIERED_CONFIG.escalateVerdicts).toEqual(['supersedes', 'contests']);
  });

  it('reads the escalation set from env (widen recall vs cost) + present-empty = never escalate', async () => {
    const widened = await freshConfig({
      MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS: 'supersedes,contests,restates',
    });
    expect(widened.BELIEF_TIERED_CONFIG.escalateVerdicts).toEqual([
      'supersedes',
      'contests',
      'restates',
    ]);
    // envStrList: a present-but-empty value is the explicit "off" (pure tier-1, never escalate).
    const empty = await freshConfig({ MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS: '' });
    expect(empty.BELIEF_TIERED_CONFIG.escalateVerdicts).toEqual([]);
  });

  it('tier-1 defaults to SubQ Snap; openai-compat brings back the Groq operating point (temp on, top_k off)', async () => {
    const c = await freshConfig();
    const t1 = c.BELIEF_TIERED_CONFIG.tier1;
    expect(t1.provider).toBe('subq');
    expect(t1.model).toBe('subq-snap-preview');
    expect(t1.endpoint).toBe('https://api.subq.ai');
    expect(t1.apiKeyEnvVar).toBe('SUBQ_API_KEY');
    const g = (await freshConfig({ MANDREL_BELIEF_TIER1_PROVIDER: 'openai-compat' })).BELIEF_TIERED_CONFIG.tier1;
    expect(g.provider).toBe('openai-compat');
    expect(g.model).toBe('openai/gpt-oss-120b');
    expect(g.endpoint).toBe('https://api.groq.com/openai');
    expect(g.apiKeyEnvVar).toBe('GROQ_API_KEY');
    expect(g.sendTopK).toBe(false); // Groq rejects top_k
    expect(g.omitTemperature).toBe(false); // Groq accepts temperature
  });

  it("the subq provider's same-subject source defaults to the verdict (held-out confirmed)", async () => {
    const c = await freshConfig();
    expect(c.BELIEF_SUBQ_CONFIG.sameSubjectFrom).toBe('verdict');
  });

  it('tier-2 defaults to the Sonnet 5 anthropic operating point (omitTemperature true)', async () => {
    const c = await freshConfig();
    const t2 = c.BELIEF_TIERED_CONFIG.tier2;
    expect(t2.provider).toBe('anthropic');
    expect(t2.model).toBe('claude-sonnet-5');
    expect(t2.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
    expect(t2.omitTemperature).toBe(true);
    // Prod's tier-2 request shape: forced tool, no thinking field.
    expect(t2.anthropicToolChoice).toBe('tool');
    expect(t2.anthropicThinkingType).toBe('');
  });

  it('both tiers inherit the SHARED determinism/prompt knobs from the base config', async () => {
    const c = await freshConfig();
    const base = c.BELIEF_ADJUDICATOR_CONFIG;
    for (const t of [c.BELIEF_TIERED_CONFIG.tier1, c.BELIEF_TIERED_CONFIG.tier2]) {
      expect(t.temperature).toBe(base.temperature);
      expect(t.seed).toBe(base.seed);
      expect(t.structuredOutput).toBe(base.structuredOutput);
      expect(t.maxContentChars).toBe(base.maxContentChars);
    }
  });

  it('every tier knob is env-overridable (A/B the tier models without a code edit)', async () => {
    const c = await freshConfig({
      MANDREL_BELIEF_TIER1_PROVIDER: 'ollama',
      MANDREL_BELIEF_TIER1_MODEL: 'qwen2.5:7b',
      MANDREL_BELIEF_TIER1_SEND_TOP_K: 'true',
      MANDREL_BELIEF_TIER2_MODEL: 'claude-opus-4-8',
    });
    expect(c.BELIEF_TIERED_CONFIG.tier1.provider).toBe('ollama');
    expect(c.BELIEF_TIERED_CONFIG.tier1.model).toBe('qwen2.5:7b');
    expect(c.BELIEF_TIERED_CONFIG.tier1.sendTopK).toBe(true);
    expect(c.BELIEF_TIERED_CONFIG.tier2.model).toBe('claude-opus-4-8');
  });
});

describe('beliefConfig — BL-9 live-hook knobs (beliefEnabled + queue depth)', () => {
  it('beliefEnabled, when UNSET, follows the adjudicator credential: on with a key, off without', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      expect((await freshConfig()).BELIEF_CONFIG.beliefEnabled).toBe(false);
      process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
      const c = await freshConfig();
      expect(c.BELIEF_CONFIG.beliefEnabled).toBe(true);
      expect(c.BELIEF_CONFIG.beliefEnabledExplicit).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('beliefEnabled is env-overridable OFF (the free-tier / kill-switch path)', async () => {
    for (const off of ['false', '0', 'no', 'off']) {
      const c = await freshConfig({ MANDREL_BELIEF_ENABLED: off });
      expect(c.BELIEF_CONFIG.beliefEnabled).toBe(false);
    }
    // and explicitly ON is honoured too
    const on = await freshConfig({ MANDREL_BELIEF_ENABLED: 'true' });
    expect(on.BELIEF_CONFIG.beliefEnabled).toBe(true);
  });

  it('a garbage MANDREL_BELIEF_ENABLED falls back to the credential-derived default — no crash', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
      expect((await freshConfig({ MANDREL_BELIEF_ENABLED: 'banana' })).BELIEF_CONFIG.beliefEnabled).toBe(true);
      delete process.env.ANTHROPIC_API_KEY;
      expect((await freshConfig({ MANDREL_BELIEF_ENABLED: 'banana' })).BELIEF_CONFIG.beliefEnabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('beliefQueueMaxDepth defaults to 1000 and reads a positive-int env override', async () => {
    const def = await freshConfig();
    expect(def.BELIEF_CONFIG.beliefQueueMaxDepth).toBe(1000);
    const over = await freshConfig({ MANDREL_BELIEF_QUEUE_MAX_DEPTH: '250' });
    expect(over.BELIEF_CONFIG.beliefQueueMaxDepth).toBe(250);
    // envInt idiom: garbage / non-positive falls back to the default.
    const bad = await freshConfig({ MANDREL_BELIEF_QUEUE_MAX_DEPTH: '-5' });
    expect(bad.BELIEF_CONFIG.beliefQueueMaxDepth).toBe(1000);
  });
});
