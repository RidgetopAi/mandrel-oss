/**
 * BELIEF COST ROLLUP — real-DB contract test (BL-10).
 *
 * Proves migration 060 (belief_adjudication_costs) + the rollup SQL against a REAL migrated
 * Postgres (the disposable ci_* DB the CI gate provisions). Locks:
 *   - LEDGER ROW SHAPE: recordAdjudicationCost inserts a row with the computed cost + all token
 *     columns, readable back;
 *   - WINDOW: rows older than the window are excluded; rows inside are summed;
 *   - AGGREGATION by day, by provider (Groq vs Sonnet), and by project/tenant;
 *   - TODAY total + the runaway alarm boolean.
 *
 * Append-only: every insert is its own row (no dedup) — the money-correct source.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import {
  recordAdjudicationCost,
  rollupCosts,
} from '../services/belief/costLedger.js';
import type { BeliefCostConfig } from '../config/beliefCostConfig.js';
import type { AdjudicationCallUsage } from '../services/belief/types.js';

const CFG: BeliefCostConfig = {
  rates: {
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'openai/gpt-oss-120b': { input: 0.15, output: 0.75, cacheRead: 0.075, cacheWrite: 0 },
  },
  alertUsdPerDay: 10,
  dailySpendCapUsd: 0,
  rollupWindowDays: 7,
};

const usage = (
  tier: AdjudicationCallUsage['tier'],
  provider: string,
  model: string,
  input: number,
  output: number
): AdjudicationCallUsage => ({
  tier,
  provider,
  model,
  inputTokens: input,
  outputTokens: output,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

describe('belief cost ledger — real DB rollup', () => {
  let projA: string;
  let projB: string;

  beforeAll(async () => {
    projA = (
      await db.query(`INSERT INTO projects (name, description) VALUES ('bl10-cost-A','') RETURNING id`)
    ).rows[0].id;
    projB = (
      await db.query(`INSERT INTO projects (name, description) VALUES ('bl10-cost-B','') RETURNING id`)
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM belief_adjudication_costs WHERE project_id = ANY($1)', [[projA, projB]]);
      await db.query('DELETE FROM projects WHERE id = ANY($1)', [[projA, projB]]);
    } catch { /* ignore */ }
    await db.end();
  });

  test('recordAdjudicationCost persists the computed cost + token columns (row shape)', async () => {
    const { id, costUsd } = await recordAdjudicationCost(
      { projectId: projA, pairKey: 'shape|test', usage: usage('single', 'anthropic', 'claude-sonnet-5', 1_000_000, 0) },
      db,
      CFG
    );
    expect(costUsd).toBeCloseTo(3, 6); // 1M input × $3/M
    const row = (await db.query('SELECT * FROM belief_adjudication_costs WHERE id = $1', [id])).rows[0];
    expect(row.tier).toBe('single');
    expect(row.provider).toBe('anthropic');
    expect(row.model).toBe('claude-sonnet-5');
    expect(Number(row.input_tokens)).toBe(1_000_000);
    expect(Number(row.output_tokens)).toBe(0);
    expect(Number(row.cost_usd)).toBeCloseTo(3, 6);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  test('rollup: window filter + aggregation by day/provider/project + today alarm', async () => {
    // Clean the shape-test row so counts are deterministic for THIS test.
    await db.query('DELETE FROM belief_adjudication_costs WHERE project_id = ANY($1)', [[projA, projB]]);

    // Insert a controlled set with explicit created_at + explicit cost_usd so sums are exact.
    // (Direct INSERT lets us backdate created_at; recordAdjudicationCost always uses now().)
    const ins = async (project: string, tier: string, provider: string, model: string, cost: number, ageDays: number) => {
      await db.query(
        `INSERT INTO belief_adjudication_costs
           (project_id, pair_key, tier, provider, model, input_tokens, output_tokens, cost_usd, created_at)
         VALUES ($1, 'k', $2, $3, $4, 0, 0, $5, now() - make_interval(days => $6::int))`,
        [project, tier, provider, model, cost, ageDays]
      );
    };
    // TODAY (age 0): 2 anthropic (proj A) + 1 groq (proj A)
    await ins(projA, 'tier2', 'anthropic', 'claude-sonnet-5', 2.0, 0);
    await ins(projA, 'tier2', 'anthropic', 'claude-sonnet-5', 1.0, 0);
    await ins(projA, 'tier1', 'openai-compat', 'openai/gpt-oss-120b', 0.5, 0);
    // YESTERDAY (age 1): 1 anthropic (proj B)
    await ins(projB, 'single', 'anthropic', 'claude-sonnet-5', 4.0, 1);
    // OUTSIDE the 7d window (age 10): must be EXCLUDED
    await ins(projA, 'tier2', 'anthropic', 'claude-sonnet-5', 99.0, 10);

    const r = await rollupCosts(db, 7, CFG);

    // Window excludes the 10-day-old row → 4 calls, $7.50 total ($3 today anthropic + $0.5 today
    // groq + $4 yesterday anthropic).
    expect(r.totalCalls).toBe(4);
    expect(r.totalCostUsd).toBeCloseTo(7.5, 6);

    // Today: 3 calls, $3.5. Alarm fires only if todayUsd >= 10 → false here.
    expect(r.todayCalls).toBe(3);
    expect(r.todayUsd).toBeCloseTo(3.5, 6);
    expect(r.alertThresholdUsd).toBe(10);
    expect(r.alert).toBe(false);

    // By provider: anthropic = 3 calls / $7 ; openai-compat = 1 call / $0.5.
    const prov = Object.fromEntries(r.byProvider.map((p) => [p.provider, p]));
    expect(prov['anthropic'].calls).toBe(3);
    expect(prov['anthropic'].costUsd).toBeCloseTo(7, 6);
    expect(prov['openai-compat'].calls).toBe(1);
    expect(prov['openai-compat'].costUsd).toBeCloseTo(0.5, 6);

    // By project: A = 3 calls / $3.5 ; B = 1 call / $4.
    const byProj = Object.fromEntries(r.byProject.map((p) => [p.projectId, p]));
    expect(byProj[projA].calls).toBe(3);
    expect(byProj[projA].costUsd).toBeCloseTo(3.5, 6);
    expect(byProj[projB].calls).toBe(1);
    expect(byProj[projB].costUsd).toBeCloseTo(4, 6);
    // Project name is joined for the digest.
    expect(byProj[projA].projectName).toBe('bl10-cost-A');

    // By day: today present with the today totals.
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = r.byDay.find((d) => d.day === today);
    expect(todayRow?.calls).toBe(3);
    expect(todayRow?.costUsd).toBeCloseTo(3.5, 6);
  });

  test('alarm fires when today crosses the threshold', async () => {
    await db.query('DELETE FROM belief_adjudication_costs WHERE project_id = ANY($1)', [[projA, projB]]);
    await db.query(
      `INSERT INTO belief_adjudication_costs
         (project_id, pair_key, tier, provider, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ($1, 'k', 'tier2', 'anthropic', 'claude-sonnet-5', 0, 0, 12.5, now())`,
      [projA]
    );
    const r = await rollupCosts(db, 7, CFG);
    expect(r.todayUsd).toBeCloseTo(12.5, 6);
    expect(r.alert).toBe(true); // 12.5 >= 10
  });
});
