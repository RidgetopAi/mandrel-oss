#!/usr/bin/env node
/**
 * beliefBackfill — EXPLICIT, GATED, COST-GATED backfill of the belief layer over EXISTING
 * records (BL-9). WRITES TO THE REAL DB (mints edges + spends real LLM $).
 *
 * ⚠️ THIS IS NOT PART OF BL-9's LIVE ACTIVATION AND IS NOT WIRED TO DEPLOY. ⚠️
 *
 * BL-9 activates belief detection FORWARD-ONLY: only NEW context_store / decision_record writes
 * trigger adjudication (via the post-store hook, services/belief/beliefHook.ts). On activation
 * we DO NOT backfill existing records — that is a separate, deliberate, cost-bearing operation
 * that a human runs on purpose. This CLI is that operation, kept SEPARATE and GATED so it can
 * never fire by accident:
 *
 *   1. EXPLICIT CONFIRMATION — refuses to do anything without BOTH:
 *        --confirm-write-to-real-db     (acknowledges it mints edges on the live DB)
 *        --i-understand-cost            (acknowledges it spends real adjudicator $)
 *      With neither, it DRY-COUNTS the eligible records and exits (safe default).
 *
 *   2. COST GATE (reuses the BL-10 cost ledger) — before running it reads the day's belief
 *      spend (rollupCosts) and REFUSES to start if today's spend already crosses the configured
 *      runaway-spend alarm (BELIEF_COST_CONFIG.alertUsdPerDay). Override the ceiling for a big
 *      intentional run with --max-usd-today=<n>.
 *
 *   3. BOUNDED — --limit=<n> caps how many records it will adjudicate in one run (default 50),
 *      so a run is always a sized, affordable batch, never "the whole corpus" by surprise.
 *
 * It reuses the SAME adjudicateNeighbourhood the live hook uses (same provider, same cost
 * ledger, same reconcile/mint), just driven over a SELECT of existing rows instead of the
 * post-store hook. SERIAL by construction (concurrency=1, embedder-priority).
 *
 * Usage (examples):
 *   # Safe: just count what WOULD be adjudicated, spend/write nothing.
 *   npx tsx scripts/beliefBackfill.ts --project=<uuid>
 *   # Real run: 20 records, real DB writes + real spend, both confirmations required.
 *   npx tsx scripts/beliefBackfill.ts --project=<uuid> --limit=20 \
 *       --confirm-write-to-real-db --i-understand-cost
 *
 * NEVER add this to a deploy script, a cron, or the fleet rollout. Forward-only is the default;
 * backfill is a human-in-the-loop decision.
 */

import { db, initializeDatabase, closeDatabase } from '../src/config/database.js';
import { activeEmbeddingColumn } from '../src/config/embeddingConfig.js';
import { BELIEF_CONFIG } from '../src/config/beliefConfig.js';
import { BELIEF_COST_CONFIG } from '../src/config/beliefCostConfig.js';
import type { EdgeNodeType } from '../src/config/edgeTypes.js';
import { adjudicateNeighbourhood } from '../src/services/belief/beliefAdjudicator.js';
import { rollupCosts } from '../src/services/belief/costLedger.js';

interface Args {
  project: string | null;
  limit: number;
  confirmWrite: boolean;
  understandCost: boolean;
  maxUsdToday: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    const eq = hit.indexOf('=');
    return eq === -1 ? '' : hit.slice(eq + 1);
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const limitRaw = get('limit');
  const maxUsdRaw = get('max-usd-today');
  return {
    project: get('project') ?? null,
    limit: limitRaw && Number.isInteger(Number(limitRaw)) && Number(limitRaw) > 0 ? Number(limitRaw) : 50,
    confirmWrite: has('confirm-write-to-real-db'),
    understandCost: has('i-understand-cost'),
    maxUsdToday: maxUsdRaw && Number.isFinite(Number(maxUsdRaw)) ? Number(maxUsdRaw) : BELIEF_COST_CONFIG.alertUsdPerDay,
  };
}

/** Eligible = embedded records (contexts + technical_decisions), optionally project-scoped. */
async function selectEligible(project: string | null, limit: number): Promise<Array<{ id: string; type: EdgeNodeType; content: string; createdAt: Date | null; projectId: string | null }>> {
  const specs: Array<{ table: string; type: EdgeNodeType; contentCol: string; createdCol: string }> = [
    { table: 'contexts', type: 'context', contentCol: 'content', createdCol: 'created_at' },
    { table: 'technical_decisions', type: 'decision', contentCol: 'rationale', createdCol: 'decision_date' },
  ];
  const out: Array<{ id: string; type: EdgeNodeType; content: string; createdAt: Date | null; projectId: string | null }> = [];
  for (const spec of specs) {
    const params: unknown[] = [];
    let where = `WHERE ${activeEmbeddingColumn()} IS NOT NULL`;
    if (project) {
      params.push(project);
      where += ` AND project_id = $${params.length}::uuid`;
    }
    params.push(limit);
    const r = await db.query(
      `SELECT id::text AS id, ${spec.contentCol} AS content, ${spec.createdCol} AS created_at, project_id::text AS project_id
         FROM ${spec.table} ${where} ORDER BY ${spec.createdCol} DESC LIMIT $${params.length}`,
      params
    );
    for (const row of r.rows) {
      out.push({ id: row.id, type: spec.type, content: row.content ?? '', createdAt: row.created_at ?? null, projectId: row.project_id ?? null });
    }
  }
  return out.slice(0, limit);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initializeDatabase();
  try {
    const eligible = await selectEligible(args.project, args.limit);
    console.log(`[beliefBackfill] eligible (embedded) records to adjudicate this run: ${eligible.length} (limit ${args.limit}${args.project ? `, project ${args.project}` : ', ALL projects'})`);

    // DRY default: without BOTH confirmations, count-and-exit. Nothing written, nothing spent.
    if (!args.confirmWrite || !args.understandCost) {
      console.log('[beliefBackfill] DRY MODE (no --confirm-write-to-real-db and/or no --i-understand-cost).');
      console.log('[beliefBackfill] Would adjudicate the above records against the live provider. Re-run with BOTH flags to execute.');
      return;
    }

    // COST GATE: refuse if today's belief spend already crosses the ceiling (reuse BL-10 ledger).
    const rollup = await rollupCosts(db, 1);
    const todayUsd = rollup.todayUsd ?? 0;
    if (todayUsd >= args.maxUsdToday) {
      console.error(`[beliefBackfill] COST GATE: today's belief spend $${todayUsd.toFixed(4)} >= ceiling $${args.maxUsdToday.toFixed(2)} — REFUSING to start. Raise with --max-usd-today or wait for the UTC day to roll over.`);
      process.exitCode = 2;
      return;
    }
    console.log(`[beliefBackfill] COST GATE ok: today's spend $${todayUsd.toFixed(4)} < ceiling $${args.maxUsdToday.toFixed(2)}. Proceeding with REAL writes + REAL spend.`);

    // SERIAL run (concurrency locked at 1, embedder-priority) — the SAME adjudicator the live hook uses.
    let done = 0;
    for (const rec of eligible) {
      try {
        await adjudicateNeighbourhood({ id: rec.id, type: rec.type, projectId: rec.projectId, content: rec.content, createdAt: rec.createdAt });
        done++;
      } catch (e) {
        console.warn(`[beliefBackfill] ${rec.type} ${rec.id.slice(0, 8)} failed — skipping: ${(e as Error)?.message}`);
      }
    }
    void BELIEF_CONFIG; // config-driven; concurrency + thresholds read inside the adjudicator.
    console.log(`[beliefBackfill] done. adjudicated ${done}/${eligible.length} records.`);
  } finally {
    await closeDatabase();
  }
}

main().catch((e) => {
  console.error('[beliefBackfill] fatal:', e);
  process.exitCode = 1;
});
