/**
 * A CAP SKIP IS LOGGED AS A SKIP, NOT A FAILURE. With today's spend at the cap the
 * guard refuses the pair before any provider call; the neighbourhood loop must log ONE skip line
 * for that pair naming the cap and today's total, and NO line containing "failed" for it. A genuine
 * provider error must still log "failed" (the control: the fix did not silence real failures).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { adjudicateNeighbourhood } from '../services/belief/beliefAdjudicator.js';
import { __resetSpendCapWarningForTest } from '../services/belief/spendCap.js';
import { BELIEF_CONFIG } from '../config/beliefConfig.js';
import type { BeliefCostConfig } from '../config/beliefCostConfig.js';
import { logger } from '../utils/logger.js';
import type { AdjudicationProvider, AdjudicationRequest, AdjudicatorVerdict } from '../services/belief/types.js';

vi.mock('../services/belief/candidatePairing.js', async (orig) => {
  const actual = await orig<typeof import('../services/belief/candidatePairing.js')>();
  return {
    ...actual,
    findCandidates: vi.fn(async () => ({
      ok: true,
      candidates: [
        { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', type: 'context', content: 'old', createdAt: new Date('2020-01-01'), cosine: 0.9 },
      ],
    })),
  };
});

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const PAIR = 'aaaaaaaa↔cccccccc';

const COST_CFG: BeliefCostConfig = {
  rates: { 'paid-sonnet': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  alertUsdPerDay: 5,
  rollupWindowDays: 7,
  dailySpendCapUsd: 2,
};

/** Pool whose ledger says `todayUsd` was spent today; everything else is a benign no-op. */
const poolSpending = (todayUsd: number): Pool =>
  ({
    async query(sql: string) {
      if (/sum\(cost_usd\)/i.test(sql)) return { rows: [{ today_usd: String(todayUsd) }], rowCount: 1 };
      return { rows: [{ id: 'row-1' }], rowCount: 1 };
    },
  }) as unknown as Pool;

class Provider implements AdjudicationProvider {
  calls = 0;
  lastUsage = [];
  readonly name = 'anthropic';
  readonly model = 'paid-sonnet';
  constructor(private readonly boom?: Error) {}
  async adjudicate(_req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    if (this.boom) throw this.boom;
    return { verdict: 'unrelated', confidence: 0.9, rationale: 'r', subject: 's', direction: null } as unknown as AdjudicatorVerdict;
  }
}

let lines: string[] = [];
beforeEach(() => {
  __resetSpendCapWarningForTest();
  lines = [];
  const rec = (m: unknown) => void lines.push(String(m));
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation(rec as never);
  }
});
afterEach(() => vi.restoreAllMocks());

const source = { id: A, type: 'context' as const, projectId: PROJECT, content: 'new', createdAt: new Date('2026-01-01') };

describe('spend-cap skip logging', () => {
  it('logs ONE skip line for the pair naming the cap and today\'s total, and none saying "failed"', async () => {
    const provider = new Provider();
    await adjudicateNeighbourhood(source, { cfg: BELIEF_CONFIG, provider, costCfg: COST_CFG }, poolSpending(2));

    expect(provider.calls).toBe(0); // refused before any paid call
    const forPair = lines.filter((l) => l.includes(PAIR));
    expect(forPair).toHaveLength(1);
    expect(forPair[0]).toMatch(/skipped/);
    expect(forPair[0]).toMatch(/\$2\.00/); // the cap
    expect(forPair[0]).toMatch(/\$2\.0000 spent today/); // today's total
    expect(lines.filter((l) => l.includes(PAIR) && /failed/i.test(l))).toEqual([]);
  });

  it('control: a real provider error on the pair is still logged as failed', async () => {
    const provider = new Provider(new Error('provider exploded'));
    await adjudicateNeighbourhood(source, { cfg: BELIEF_CONFIG, provider, costCfg: COST_CFG }, poolSpending(0));
    expect(provider.calls).toBe(1);
    expect(lines.filter((l) => l.includes(PAIR) && /failed/i.test(l))).toHaveLength(1);
  });
});
