#!/usr/bin/env node
/**
 * adjScore — Phase-4 adjudicator DECISION run, STAGE 2 (label/score one provider).
 *
 * Runs the CONFIGURED Stage-2 adjudicator (getAdjudicationProvider from BELIEF_ADJUDICATOR_*
 * env — same factory the live pipeline uses) over the nominated pairs.json, calling
 * provider.adjudicate + the PURE deriveBeliefOutcome for each pair. Writes a per-provider
 * label file (verdict + derived outcome + latency per pair). Used three ways from the
 * decision-run wrapper: as the ORACLE (desktop 35B), and as each CANDIDATE (Groq, Haiku).
 *
 * NO DB, NO prod writes — it only calls the provider and derives the outcome in memory.
 * NEVER crashes the whole run on one bad pair (records an error, continues).
 *
 * Env:
 *   ADJRUN_PAIRS   path to pairs.json (from adjNominate)
 *   ADJRUN_LABEL   run label (e.g. oracle35b / groq / haiku) — names the output file
 *   ADJRUN_OUT     output dir
 *   BELIEF_ADJUDICATOR_*  select+configure the provider (provider/model/endpoint/keys/...)
 */

import fs from 'fs/promises';
import path from 'path';

import {
  BELIEF_CONFIG,
  BELIEF_ADJUDICATOR_CONFIG,
  BELIEF_SUBQ_CONFIG,
  BELIEF_TIERED_CONFIG,
} from '../src/config/beliefConfig.js';
import { BELIEF_COST_CONFIG } from '../src/config/beliefCostConfig.js';
import type { EdgeNodeType } from '../src/config/edgeTypes.js';
import { getAdjudicationProvider } from '../src/services/belief/provider.js';
import { deriveBeliefOutcome } from '../src/services/belief/beliefDerivation.js';
import type { AdjudicationRecord } from '../src/services/belief/types.js';

interface PairIn {
  a: { id: string; type: EdgeNodeType; content: string; createdAt: string };
  b: { id: string; type: EdgeNodeType; content: string; createdAt: string };
  cosine: number;
}

const PAIRS = process.env.ADJRUN_PAIRS!;
const LABEL = process.env.ADJRUN_LABEL!;
const OUT = process.env.ADJRUN_OUT!;

async function main(): Promise<void> {
  const pairs = JSON.parse(await fs.readFile(PAIRS, 'utf-8')) as PairIn[];
  const provider = getAdjudicationProvider();
  console.log(
    `🧪 [${LABEL}] provider=${provider.name}/${provider.model} · ${pairs.length} pairs`
  );

  const results: any[] = [];
  let done = 0;
  for (const p of pairs) {
    const a: AdjudicationRecord = { id: p.a.id, type: p.a.type, content: p.a.content, createdAt: p.a.createdAt };
    const b: AdjudicationRecord = { id: p.b.id, type: p.b.type, content: p.b.content, createdAt: p.b.createdAt };
    const started = Date.now();
    let rec: any;
    try {
      const verdict = await provider.adjudicate({ a, b, cosine: p.cosine });
      // Whole records: the derivation reads both createdAt clocks and
      // refuses a direction that points backwards in time.
      const outcome = deriveBeliefOutcome(verdict, a, b);
      // Per-call usage (cost) + routing (tiered) + provider detail (subq probabilities), read
      // synchronously after the await — the same serial contract the pipeline relies on.
      const probe = provider as { lastRouting?: unknown; lastDetail?: unknown };
      rec = {
        aId: a.id,
        bId: b.id,
        cosine: p.cosine,
        latency_ms: Date.now() - started,
        verdict,
        outcome,
        usage: provider.lastUsage ?? [],
        routing: probe.lastRouting ?? null,
        detail: probe.lastDetail ?? null,
      };
    } catch (e) {
      rec = {
        aId: a.id,
        bId: b.id,
        cosine: p.cosine,
        latency_ms: Date.now() - started,
        error: (e as Error)?.message ?? String(e),
      };
      console.warn(`   ✗ pair ${a.id.slice(0, 8)}↔${b.id.slice(0, 8)} error: ${rec.error}`);
    }
    results.push(rec);
    if (++done % 10 === 0) console.log(`   [${LABEL}] ${done}/${pairs.length}`);
  }

  const errors = results.filter((r) => r.error).length;
  const lat = results.filter((r) => !r.error).map((r) => r.latency_ms).sort((a, b) => a - b);
  const report = {
    label: LABEL,
    provider: provider.name,
    model: provider.model,
    // config snapshot carries the api-key ENV VAR NAME only (never a value) — secret-safe.
    adjudicator_config: { ...BELIEF_ADJUDICATOR_CONFIG },
    belief_config: BELIEF_CONFIG,
    // Tier + subq knobs in effect (env NAMES only — no values of any key live on these configs).
    tiered_config: BELIEF_TIERED_CONFIG,
    subq_config: BELIEF_SUBQ_CONFIG,
    // USD/1M-token rates in effect (single source: beliefCostConfig) so a scorer prices the
    // per-pair `usage` without keeping its own copy of the price table.
    cost_rates: BELIEF_COST_CONFIG.rates,
    pairs: results.length,
    errors,
    latency_ms_median: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    results,
  };
  await fs.mkdir(OUT, { recursive: true });
  const outFile = path.join(OUT, `labels-${LABEL}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`\n[${LABEL}] done: ${results.length} pairs, ${errors} errors, median latency ${report.latency_ms_median}ms → ${outFile}`);
}

main().catch((e) => {
  console.error('adjScore failed:', e);
  process.exit(2);
});
