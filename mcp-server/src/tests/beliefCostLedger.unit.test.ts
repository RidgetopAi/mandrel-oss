/**
 * BELIEF COST LEDGER — PURE + fail-safe unit tests (BL-10). NO DB, NO LLM, NO net.
 *
 * Locks the cost-monitor contract in isolation:
 *   - cost math: tokens × per-model rate INCLUDING cache read/write rates;
 *   - unknown model → cost 0 + a ONE-TIME warning (never a wrong number, never a throw);
 *   - shouldAlert: fires AT/above the threshold, silent below;
 *   - the tiered provider reports BOTH tier calls (tier-1 always + tier-2 on escalation), so both
 *     cost events are captured — one per real API call;
 *   - recordProviderCallCostsSafe writes one ledger row per usage entry (correct row shape) AND
 *     is FAIL-SAFE: a DB error is swallowed, the adjudication path is never broken.
 *   - a MUTATION check pins the cache-rate term (dropping it would change the computed cost).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  computeCostUsd,
  shouldAlert,
  recordAdjudicationCost,
  recordProviderCallCostsSafe,
} from '../services/belief/costLedger.js';
import type { BeliefCostConfig } from '../config/beliefCostConfig.js';
import { TieredAdjudicator } from '../services/belief/tieredAdjudicator.js';
import { logger } from '../utils/logger.js';
import type {
  AdjudicationCallUsage,
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
  BeliefVerdict,
} from '../services/belief/types.js';

// A small, self-contained rate table so the math is checkable by hand (independent of shipped
// defaults). Sonnet-like numbers.
const CFG: BeliefCostConfig = {
  rates: {
    'test-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'test-groq': { input: 0.15, output: 0.75, cacheRead: 0.075, cacheWrite: 0 },
  },
  alertUsdPerDay: 10,
  dailySpendCapUsd: 0,
  rollupWindowDays: 7,
};

describe('computeCostUsd — tokens × rate incl. cache rates', () => {
  it('prices input + output + cacheRead + cacheWrite each at its own rate', () => {
    // 1,000,000 of each class → the cost is exactly the sum of the four rates.
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    };
    const { costUsd, priced } = computeCostUsd('test-sonnet', usage, CFG);
    expect(priced).toBe(true);
    expect(costUsd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10); // 22.05
  });

  it('scales linearly with sub-million token counts', () => {
    const usage = {
      inputTokens: 200_000, // 0.2M × 3   = 0.60
      outputTokens: 50_000, // 0.05M × 15  = 0.75
      cacheReadTokens: 100_000, // 0.1M × 0.3 = 0.03
      cacheCreationTokens: 0,
    };
    const { costUsd } = computeCostUsd('test-sonnet', usage, CFG);
    expect(costUsd).toBeCloseTo(0.6 + 0.75 + 0.03, 10); // 1.38
  });

  it('MUTATION guard: the cache-read term is really in the cost (not dropped)', () => {
    const withCache = computeCostUsd(
      'test-sonnet',
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 },
      CFG
    ).costUsd;
    // If the implementation ignored cacheReadTokens, this would be 0 — pin it non-zero + exact.
    expect(withCache).toBeCloseTo(0.3, 10);
  });
});

describe('computeCostUsd — unknown model', () => {
  it('returns 0 + priced=false and warns exactly ONCE per model', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const u = { inputTokens: 5_000_000, outputTokens: 5_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const r1 = computeCostUsd('totally-unknown-model-xyz', u, CFG);
    const r2 = computeCostUsd('totally-unknown-model-xyz', u, CFG);
    expect(r1).toEqual({ costUsd: 0, priced: false });
    expect(r2.costUsd).toBe(0);
    // De-duped: warned once for this model despite two calls.
    const warnsForModel = warn.mock.calls.filter((c) =>
      String(c[0]).includes('totally-unknown-model-xyz')
    );
    expect(warnsForModel.length).toBe(1);
    warn.mockRestore();
  });
});

describe('shouldAlert — runaway-spend threshold', () => {
  it('fires AT and above the threshold, silent below', () => {
    expect(shouldAlert(9.99, CFG)).toBe(false);
    expect(shouldAlert(10, CFG)).toBe(true); // exactly at threshold fires
    expect(shouldAlert(10.01, CFG)).toBe(true);
    expect(shouldAlert(0, CFG)).toBe(false);
    expect(shouldAlert(NaN, CFG)).toBe(false); // fail-safe on garbage
  });
});

// ── Fakes for the tiered + ledger-write tests ────────────────────────────────────────────────

function verdict(v: BeliefVerdict): AdjudicatorVerdict {
  return {
    sameSubject: v !== 'unrelated',
    subject: 's',
    verdict: v,
    direction: v === 'supersedes' ? 'a_supersedes_b' : 'none',
    mode: v === 'supersedes' ? 'replaced' : 'none',
    confidence: 0.95,
    rationale: `reply:${v}`,
  };
}

/** A fake provider that ALSO reports per-call usage (as tier='single', like the real ones). */
class UsageFake implements AdjudicationProvider {
  public lastUsage: AdjudicationCallUsage[] = [];
  public calls = 0;
  constructor(
    public readonly name: string,
    public readonly model: string,
    private readonly reply: AdjudicatorVerdict,
    private readonly tokens: { input: number; output: number }
  ) {}
  async adjudicate(_req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    this.lastUsage = [
      {
        tier: 'single',
        provider: this.name,
        model: this.model,
        inputTokens: this.tokens.input,
        outputTokens: this.tokens.output,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    return { ...this.reply };
  }
}

const REQ: AdjudicationRequest = {
  a: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'context', content: 'a' },
  b: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', type: 'context', content: 'b' },
  cosine: 0.9,
};

describe('TieredAdjudicator — reports BOTH tier calls to the cost ledger (BL-10)', () => {
  it('non-escalated verdict → ONE usage entry (tier-1 only)', async () => {
    const t1 = new UsageFake('openai-compat', 'test-groq', verdict('unrelated'), { input: 100, output: 5 });
    const t2 = new UsageFake('anthropic', 'test-sonnet', verdict('supersedes'), { input: 200, output: 10 });
    const tiered = new TieredAdjudicator(t1, t2, ['supersedes', 'contests']);
    await tiered.adjudicate(REQ);
    expect(t2.calls).toBe(0); // never escalated
    expect(tiered.lastUsage).toHaveLength(1);
    expect(tiered.lastUsage[0]).toMatchObject({ tier: 'tier1', provider: 'openai-compat', model: 'test-groq' });
  });

  it('escalated verdict → TWO usage entries (tier-1 prescreen + tier-2 confirm)', async () => {
    const t1 = new UsageFake('openai-compat', 'test-groq', verdict('supersedes'), { input: 100, output: 5 });
    const t2 = new UsageFake('anthropic', 'test-sonnet', verdict('supersedes'), { input: 200, output: 10 });
    const tiered = new TieredAdjudicator(t1, t2, ['supersedes', 'contests']);
    await tiered.adjudicate(REQ);
    expect(t1.calls).toBe(1);
    expect(t2.calls).toBe(1);
    expect(tiered.lastUsage).toHaveLength(2);
    expect(tiered.lastUsage.map((u) => u.tier)).toEqual(['tier1', 'tier2']);
    // Re-tagged from each sub-provider (which reported tier='single').
    expect(tiered.lastUsage[0]).toMatchObject({ tier: 'tier1', model: 'test-groq', inputTokens: 100 });
    expect(tiered.lastUsage[1]).toMatchObject({ tier: 'tier2', model: 'test-sonnet', inputTokens: 200 });
  });

  it('a fresh call RESETS usage (no stale entries carried across calls)', async () => {
    const t1 = new UsageFake('openai-compat', 'test-groq', verdict('supersedes'), { input: 100, output: 5 });
    const t2 = new UsageFake('anthropic', 'test-sonnet', verdict('supersedes'), { input: 200, output: 10 });
    const tiered = new TieredAdjudicator(t1, t2, ['supersedes', 'contests']);
    await tiered.adjudicate(REQ); // escalates → 2 entries
    expect(tiered.lastUsage).toHaveLength(2);
    // Now a non-escalating reply → must reset to a single tier-1 entry.
    const t1b = new UsageFake('openai-compat', 'test-groq', verdict('restates'), { input: 100, output: 5 });
    const tiered2 = new TieredAdjudicator(t1b, t2, ['supersedes', 'contests']);
    await tiered2.adjudicate(REQ);
    expect(tiered2.lastUsage).toHaveLength(1);
  });
});

// A fake pg Pool capturing INSERTs (row-shape) or throwing (fail-safe).
function capturePool(): { pool: Pool; rows: Array<{ sql: string; params: unknown[] }> } {
  const rows: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      rows.push({ sql, params });
      return { rows: [{ id: '00000000-0000-0000-0000-000000000001' }] };
    },
  } as unknown as Pool;
  return { pool, rows };
}

describe('recordProviderCallCostsSafe — writes one row per real call, correct shape', () => {
  it('single provider → 1 ledger row with computed cost + tokens + tier', async () => {
    const p = new UsageFake('anthropic', 'test-sonnet', verdict('supersedes'), { input: 0, output: 0 });
    p.lastUsage = [
      { tier: 'single', provider: 'anthropic', model: 'test-sonnet', inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ];
    const { pool, rows } = capturePool();
    const n = await recordProviderCallCostsSafe(p, { projectId: 'proj-1', pairKey: 'a|b' }, pool, CFG);
    expect(n).toBe(1);
    expect(rows).toHaveLength(1);
    const params = rows[0].params;
    // [project_id, pair_key, tier, provider, model, in, out, cacheCreate, cacheRead, cost_usd]
    expect(params[0]).toBe('proj-1');
    expect(params[1]).toBe('a|b');
    expect(params[2]).toBe('single');
    expect(params[3]).toBe('anthropic');
    expect(params[4]).toBe('test-sonnet');
    expect(params[5]).toBe(1_000_000);
    expect(params[9]).toBeCloseTo(3, 10); // 1M input × $3/M
  });

  it('tiered escalation → 2 ledger rows (tier1 + tier2)', async () => {
    const t1 = new UsageFake('openai-compat', 'test-groq', verdict('supersedes'), { input: 1_000_000, output: 0 });
    const t2 = new UsageFake('anthropic', 'test-sonnet', verdict('supersedes'), { input: 1_000_000, output: 0 });
    const tiered = new TieredAdjudicator(t1, t2, ['supersedes', 'contests']);
    await tiered.adjudicate(REQ);
    const { pool, rows } = capturePool();
    const n = await recordProviderCallCostsSafe(tiered, { projectId: null, pairKey: 'a|b' }, pool, CFG);
    expect(n).toBe(2);
    expect(rows.map((r) => r.params[2])).toEqual(['tier1', 'tier2']);
    expect(rows[0].params[9]).toBeCloseTo(0.15, 10); // groq input
    expect(rows[1].params[9]).toBeCloseTo(3, 10); // sonnet input
  });
});

describe('recordProviderCallCostsSafe — FAIL-SAFE (a ledger error never breaks adjudication)', () => {
  it('a throwing pool is swallowed → returns 0, logs a warning, does NOT throw', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const throwingPool = {
      query: async () => {
        throw new Error('DB is down');
      },
    } as unknown as Pool;
    const p = new UsageFake('anthropic', 'test-sonnet', verdict('supersedes'), { input: 10, output: 1 });
    p.lastUsage = [
      { tier: 'single', provider: 'anthropic', model: 'test-sonnet', inputTokens: 10, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ];
    const n = await recordProviderCallCostsSafe(p, { projectId: null, pairKey: null }, throwingPool, CFG);
    expect(n).toBe(0); // nothing written, but resolved cleanly
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a provider with no usage → 0 rows, no error', async () => {
    const p = new UsageFake('anthropic', 'test-sonnet', verdict('unrelated'), { input: 0, output: 0 });
    p.lastUsage = [];
    const { pool, rows } = capturePool();
    const n = await recordProviderCallCostsSafe(p, { projectId: null, pairKey: null }, pool, CFG);
    expect(n).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describe('recordAdjudicationCost — computes + persists cost from usage', () => {
  it('inserts the computed cost for a single usage row', async () => {
    const { pool, rows } = capturePool();
    const usage: AdjudicationCallUsage = {
      tier: 'tier2',
      provider: 'anthropic',
      model: 'test-sonnet',
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    const { costUsd } = await recordAdjudicationCost({ projectId: 'p', pairKey: 'k', usage }, pool, CFG);
    expect(costUsd).toBeCloseTo(15, 10); // 1M output × $15/M
    expect(rows[0].params[9]).toBeCloseTo(15, 10);
  });
});
