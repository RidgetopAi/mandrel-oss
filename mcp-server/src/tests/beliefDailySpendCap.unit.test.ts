/**
 * BELIEF DAILY SPEND CAP. NO real DB, NO LLM, NO network.
 *
 * The pool is a FAKE that holds a seeded cost ledger and EMULATES the one cost-sum query by its
 * SQL shape (a UTC-day-boundary predicate ⇒ today only; no such predicate ⇒ all-time), so a
 * mutation that drops the day filter changes the answer. It records attempt-ledger inserts. The
 * provider is a RECORDING FAKE: `calls` is the count of paid calls that would have been made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { adjudicatePair, adjudicateNeighbourhood } from '../services/belief/beliefAdjudicator.js';
import {
  BELIEF_SPEND_CAP_ERROR_CLASS,
  BeliefSpendCapError,
  __resetSpendCapWarningForTest,
} from '../services/belief/spendCap.js';
import { rollupCosts } from '../services/belief/costLedger.js';
import { TieredAdjudicator } from '../services/belief/tieredAdjudicator.js';
import { BeliefAdjudicationQueue } from '../services/belief/beliefHook.js';
import { BELIEF_CONFIG } from '../config/beliefConfig.js';
import type { BeliefCostConfig } from '../config/beliefCostConfig.js';
import { logger } from '../utils/logger.js';
import type {
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
} from '../services/belief/types.js';

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
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROJECT = 'pppppppp-pppp-pppp-pppp-pppppppppppp';

const COST_CFG = (cap: number): BeliefCostConfig => ({
  rates: {
    'paid-sonnet': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    'paid-snap': { input: 0.05, output: 0, cacheRead: 0, cacheWrite: 0 },
    'free-local': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  alertUsdPerDay: 5,
  rollupWindowDays: 7,
  dailySpendCapUsd: cap,
});

interface LedgerRow {
  createdAt: Date;
  costUsd: number;
}
const utcMidnight = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const todayRow = (costUsd: number): LedgerRow => ({ createdAt: new Date(utcMidnight() + 1000), costUsd });
const yesterdayRow = (costUsd: number): LedgerRow => ({ createdAt: new Date(utcMidnight() - 3600_000), costUsd });

class FakePool {
  attempts: unknown[][] = [];
  contexts: string[] = [];
  constructor(public ledger: LedgerRow[]) {}
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    if (/FROM\s+belief_adjudication_costs/i.test(sql) && /sum\(cost_usd\)/i.test(sql) && !/GROUP BY/i.test(sql)) {
      const todayOnly = /WHERE\s+created_at\s*>=\s*date_trunc\('day'/i.test(sql);
      const rows = todayOnly ? this.ledger.filter((r) => r.createdAt.getTime() >= utcMidnight()) : this.ledger;
      return { rows: [{ today_usd: String(rows.reduce((s, r) => s + r.costUsd, 0)) }], rowCount: 1 };
    }
    if (/INSERT INTO belief_adjudication_attempts/i.test(sql)) {
      this.attempts.push(params);
      return { rows: [{ id: String(this.attempts.length) }], rowCount: 1 };
    }
    if (/INSERT INTO contexts/i.test(sql)) {
      this.contexts.push(String(params[0]));
      return { rows: [{ id: 'ctx-1' }], rowCount: 1 };
    }
    if (/FROM\s+belief_adjudication_costs/i.test(sql)) {
      // rollupCosts: fine-grained rows (GROUP BY day,provider,model) / by-project.
      if (/LEFT JOIN projects/i.test(sql)) return { rows: [], rowCount: 0 };
      const t = this.ledger.filter((r) => r.createdAt.getTime() >= utcMidnight());
      const sum = t.reduce((s, r) => s + r.costUsd, 0);
      return {
        rows: t.length
          ? [{ day: new Date().toISOString().slice(0, 10), provider: 'anthropic', model: 'paid-sonnet', calls: t.length,
               input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: sum }]
          : [],
        rowCount: 1,
      };
    }
    // Anything else (edge reconcile / verdict store after a real call): benign empty result.
    return { rows: [{ id: 'row-1' }], rowCount: 0 };
  }
}
const asPool = (p: FakePool) => p as unknown as Pool;

class RecordingProvider implements AdjudicationProvider {
  calls = 0;
  lastUsage = [];
  constructor(public readonly name: string, public readonly model: string) {}
  async adjudicate(_req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    return { verdict: 'unrelated', confidence: 0.9, rationale: 'r', subject: 's', direction: null } as unknown as AdjudicatorVerdict;
  }
}

const recA = { id: A, type: 'context' as const, content: 'a', createdAt: new Date('2026-01-01') };
const recB = { id: B, type: 'context' as const, content: 'b', createdAt: new Date('2020-01-01') };

/** Run one pair; swallow ONLY the cap error so call counts can be asserted either way. */
async function run(provider: AdjudicationProvider, pool: FakePool, cap: number) {
  try {
    await adjudicatePair(recA, recB, { projectId: PROJECT, provider, costCfg: COST_CFG(cap) }, asPool(pool));
    return 'adjudicated';
  } catch (e) {
    if (e instanceof BeliefSpendCapError) return 'capped';
    throw e;
  }
}

beforeEach(() => {
  __resetSpendCapWarningForTest();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

describe('daily spend cap — the guard', () => {
  it('spend at the cap ⇒ ZERO provider calls, pair booked with the spend-cap reason, write succeeds', async () => {
    const pool = new FakePool([todayRow(2)]);
    const provider = new RecordingProvider('anthropic', 'paid-sonnet');

    // The triggering write: store the record, then fire belief adjudication (post-store, async).
    await pool.query('INSERT INTO contexts (content) VALUES ($1)', ['the new record']);
    const queue = new BeliefAdjudicationQueue({
      maxDepth: 10,
      concurrency: 1,
      defer: (fn) => queueMicrotask(fn),
      adjudicate: (s) =>
        adjudicateNeighbourhood(
          { id: A, type: 'context', projectId: PROJECT, content: s.content, createdAt: new Date('2026-01-01') },
          { cfg: BELIEF_CONFIG, provider, costCfg: COST_CFG(2) },
          asPool(pool)
        ),
    });
    queue.enqueue({ id: A, type: 'context', projectId: PROJECT, content: 'the new record' });
    await queue.whenIdle();

    expect(provider.calls).toBe(0); // no paid call
    expect(pool.contexts).toEqual(['the new record']); // record persisted, nothing thrown
    // attempt ledger: the pair row (scope pair, failed) carries the spend-cap reason.
    const pairRow = pool.attempts.find((p) => p[1] === 'pair');
    expect(pairRow).toBeDefined();
    expect(pairRow![2]).toBe('failed');
    expect(String(pairRow![3])).toContain('cccccccc'); // pair_key names the capped pair
    expect(pairRow![11]).toBe(BELIEF_SPEND_CAP_ERROR_CLASS);
    expect(String(pairRow![13])).toMatch(/spend cap reached/);
    // and the neighbourhood itself completed (the job did not die).
    expect(pool.attempts.some((p) => p[1] === 'neighbourhood' && p[2] === 'completed')).toBe(true);
  });

  it('spend over the cap ⇒ zero calls too (>=, not ==)', async () => {
    const provider = new RecordingProvider('anthropic', 'paid-sonnet');
    expect(await run(provider, new FakePool([todayRow(7.5)]), 2)).toBe('capped');
    expect(provider.calls).toBe(0);
  });

  it('spend below the cap ⇒ the provider IS called', async () => {
    const provider = new RecordingProvider('anthropic', 'paid-sonnet');
    expect(await run(provider, new FakePool([todayRow(1.99)]), 2)).toBe('adjudicated');
    expect(provider.calls).toBe(1);
  });

  it('over the cap but ALL of it dated the previous UTC day ⇒ the provider IS called', async () => {
    const provider = new RecordingProvider('anthropic', 'paid-sonnet');
    expect(await run(provider, new FakePool([yesterdayRow(50), yesterdayRow(50)]), 2)).toBe('adjudicated');
    expect(provider.calls).toBe(1);
  });

  it('cap 0 ⇒ called regardless of spend', async () => {
    const provider = new RecordingProvider('anthropic', 'paid-sonnet');
    expect(await run(provider, new FakePool([todayRow(1000)]), 0)).toBe('adjudicated');
    expect(provider.calls).toBe(1);
  });

  it('a free (zero-price) model is never capped', async () => {
    const provider = new RecordingProvider('ollama', 'free-local');
    expect(await run(provider, new FakePool([todayRow(1000)]), 2)).toBe('adjudicated');
    expect(provider.calls).toBe(1);
  });

  it('tiered mode with spend at the cap ⇒ NEITHER tier is called', async () => {
    const t1 = new RecordingProvider('subq', 'paid-snap');
    const t2 = new RecordingProvider('anthropic', 'paid-sonnet');
    const tiered = new TieredAdjudicator(t1, t2, ['supersedes']);
    expect(await run(tiered, new FakePool([todayRow(2)]), 2)).toBe('capped');
    expect(t1.calls).toBe(0);
    expect(t2.calls).toBe(0);
  });

  it('tiered mode with a free tier-1 and paid tier-2 is still capped (either tier priced)', async () => {
    const t1 = new RecordingProvider('ollama', 'free-local');
    const t2 = new RecordingProvider('anthropic', 'paid-sonnet');
    expect(await run(new TieredAdjudicator(t1, t2, ['supersedes']), new FakePool([todayRow(2)]), 2)).toBe('capped');
    expect(t1.calls + t2.calls).toBe(0);
  });

  it('warns ONCE per UTC day, naming the cap and today\'s total', async () => {
    const pool = new FakePool([todayRow(3)]);
    const provider = new RecordingProvider('anthropic', 'paid-sonnet');
    await run(provider, pool, 2);
    await run(provider, pool, 2);
    await run(provider, pool, 2);
    const capWarnings = (logger.warn as any).mock.calls.filter((c: unknown[]) => String(c[0]).includes('spend cap'));
    expect(capWarnings).toHaveLength(1);
    expect(String(capWarnings[0][0])).toMatch(/\$3\.0000/);
    expect(String(capWarnings[0][0])).toMatch(/\$2\.00 daily cap/);
  });
});

describe('daily spend cap — config + cost rollup', () => {
  const KEY = 'MANDREL_BELIEF_DAILY_SPEND_CAP_USD';
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    vi.resetModules();
  });

  it('defaults to 2 when unset; honours 0 and a custom value; garbage/negative fall back to 2', async () => {
    const load = async () => (await import('../config/beliefCostConfig.js')).BELIEF_COST_CONFIG.dailySpendCapUsd;
    delete process.env[KEY];
    vi.resetModules();
    expect(await load()).toBe(2);
    process.env[KEY] = '0';
    vi.resetModules();
    expect(await load()).toBe(0);
    process.env[KEY] = '7.5';
    vi.resetModules();
    expect(await load()).toBe(7.5);
    process.env[KEY] = '-1';
    vi.resetModules();
    expect(await load()).toBe(2);
    process.env[KEY] = 'abc';
    vi.resetModules();
    expect(await load()).toBe(2);
  });

  it('the cost rollup reports today\'s spend and the cap (and whether it is capped)', async () => {
    const capped = await rollupCosts(asPool(new FakePool([todayRow(2.5)])), 7, COST_CFG(2));
    expect(capped.todayUsd).toBeCloseTo(2.5);
    expect(capped.dailySpendCapUsd).toBe(2);
    expect(capped.capReached).toBe(true);
    const under = await rollupCosts(asPool(new FakePool([todayRow(0.5)])), 7, COST_CFG(2));
    expect(under.capReached).toBe(false);
    const uncapped = await rollupCosts(asPool(new FakePool([todayRow(99)])), 7, COST_CFG(0));
    expect(uncapped.dailySpendCapUsd).toBe(0);
    expect(uncapped.capReached).toBe(false);
  });
});
