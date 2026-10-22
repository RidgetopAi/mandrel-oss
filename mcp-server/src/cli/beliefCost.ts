/**
 * beliefCost — the BL-10 belief-adjudicator cost report ($/day, live), as COMPILED library code.
 *
 * Lives under src/ so `tsc` ships it as plain JavaScript in dist/ — the container has no tsx/npx,
 * so the documented `scripts/belief-cost.sh` runs `node dist/cli/beliefCostMain.js` inside it.
 * Reads the APPEND-ONLY cost ledger (belief_adjudication_costs, migration 060): $/day, calls/day,
 * tokens/day by provider and project/tenant, plus today's spend, the hard daily cap and whether the
 * cap is reached. READ-ONLY. The --json output carries todayUsd / alertThresholdUsd / alert /
 * dailySpendCapUsd / capReached (the daily notifier, a host-side daily notifier, consumes it).
 */

import type { Pool } from 'pg';
import { rollupCosts } from '../services/belief/costLedger.js';
import { BELIEF_COST_CONFIG, type BeliefCostConfig } from '../config/beliefCostConfig.js';

export function parseArgs(argv: string[]): { days: number; json: boolean } {
  let days = BELIEF_COST_CONFIG.rollupWindowDays;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--days') {
      const v = Number(argv[++i]);
      if (Number.isInteger(v) && v > 0) days = v;
    } else if (a.startsWith('--days=')) {
      const v = Number(a.slice('--days='.length));
      if (Number.isInteger(v) && v > 0) days = v;
    }
  }
  return { days, json };
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const num = (n: number): string => n.toLocaleString('en-US');

/** Render the rollup for `argv` (--json | --days N) from `pool` and hand it to `write`. */
export async function runBeliefCost(
  argv: string[],
  pool: Pool,
  write: (text: string) => void,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG
): Promise<void> {
  const { days, json } = parseArgs(argv);
  const r = await rollupCosts(pool, days, cfg);

  if (json) {
    write(JSON.stringify(r, null, 2) + '\n');
    return;
  }

  const lines: string[] = [];
  lines.push(`\n=== Belief adjudicator cost — last ${r.windowDays}d (since ${r.since}, UTC) ===`);
  lines.push(`  Total: ${usd(r.totalCostUsd)}  over ${num(r.totalCalls)} calls`);
  lines.push(
    `  Today: ${usd(r.todayUsd)}  (${num(r.todayCalls)} calls)  ` +
      `alarm@${usd(r.alertThresholdUsd)} → ${r.alert ? '🔴 OVER' : '🟢 ok'}`
  );
  lines.push(
    r.dailySpendCapUsd > 0
      ? `  Spend cap: ${usd(r.todayUsd)} of ${usd(r.dailySpendCapUsd)} today → ` +
          `${r.capReached ? '⛔ CAPPED (paid adjudication paused until next UTC day)' : '🟢 under cap'}  ` +
          `[capReached=${r.capReached}]`
      : `  Spend cap: none (MANDREL_BELIEF_DAILY_SPEND_CAP_USD=0)`
  );

  lines.push(`\n  By provider:`);
  if (r.byProvider.length === 0) lines.push(`    (no calls in window)`);
  for (const p of r.byProvider) {
    lines.push(`    ${p.provider.padEnd(16)} ${usd(p.costUsd).padStart(12)}  ${num(p.calls)} calls`);
  }

  lines.push(`\n  By project/tenant:`);
  if (r.byProject.length === 0) lines.push(`    (none)`);
  for (const p of r.byProject) {
    const label = p.projectName ?? (p.projectId ? p.projectId.slice(0, 8) : '(no project)');
    lines.push(`    ${label.padEnd(24)} ${usd(p.costUsd).padStart(12)}  ${num(p.calls)} calls`);
  }

  lines.push(`\n  By day:`);
  if (r.byDay.length === 0) lines.push(`    (none)`);
  for (const d of r.byDay) {
    lines.push(`    ${d.day}  ${usd(d.costUsd).padStart(12)}  ${num(d.calls)} calls`);
  }

  lines.push(`\n  By day × provider × model:`);
  for (const row of r.byDayProviderModel) {
    lines.push(
      `    ${row.day}  ${row.provider}/${row.model}  ${usd(row.costUsd)}  ` +
        `in=${num(row.inputTokens)} out=${num(row.outputTokens)} ` +
        `cacheR=${num(row.cacheReadTokens)} cacheW=${num(row.cacheCreationTokens)}  ${num(row.calls)} calls`
    );
  }
  lines.push('');
  write(lines.join('\n') + '\n');
}
