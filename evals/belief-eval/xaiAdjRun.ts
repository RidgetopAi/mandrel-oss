#!/usr/bin/env node
/**
 * xaiAdjRun — MEASUREMENT-ONLY adjudicator run for the grok-4.3 (xAI) bake-off
 *. Parallel to scripts/adjScore.ts: it drives the SAME
 * pairs.json through the adjudicator and derives the SAME outcome via the exact
 * production helpers (buildAdjudicationPrompt / extractJson / RawVerdictSchema /
 * normalizeVerdict / deriveBeliefOutcome — single source, no drift), so the labels
 * file it writes is score.py-compatible byte-for-byte on the scored fields.
 *
 * The ONLY thing it adds over the real OpenAICompatAdjudicator path is capturing the
 * per-call token USAGE + xAI's authoritative `cost_in_usd_ticks` (the provider discards
 * these), so we can report REAL cost. The request body is an exact mirror of
 * OpenAICompatAdjudicator (temperature/top_p/seed/max_tokens/stream/response_format,
 * conditional top_k/reasoning_effort/chat_template_kwargs) — the only variable is that
 * we read usage off the response.
 *
 * NO DB, NO prod writes. Secret discipline: the key is read from env BY NAME
 * (cfg.apiKeyEnvVar); the VALUE is never logged/serialized (only usage/verdict/cost).
 *
 * Env:
 *   ADJRUN_MODE    'pairs' (default) | 'cases'
 *   ADJRUN_PAIRS   path to pairs.json (pairs mode)
 *   ADJRUN_CASES   path to cases.json (cases mode)
 *   ADJRUN_LABEL   run label (names the output file: labels-<label>.json / cases-<label>.json)
 *   ADJRUN_OUT     output dir
 *   MANDREL_BELIEF_ADJUDICATOR_*  select+configure the provider (openai-compat / grok-4.3 / x.ai)
 */

import fs from 'fs/promises';
import path from 'path';

import { BELIEF_CONFIG, BELIEF_ADJUDICATOR_CONFIG } from '../../mcp-server/src/config/beliefConfig.js';
import type { EdgeNodeType } from '../../mcp-server/src/config/edgeTypes.js';
import {
  buildAdjudicationPrompt,
  normalizeVerdict,
  extractJson,
  RawVerdictSchema,
} from '../../mcp-server/src/services/belief/ollamaAdjudicator.js';
import { deriveBeliefOutcome } from '../../mcp-server/src/services/belief/beliefDerivation.js';
import type { AdjudicationRecord, AdjudicationRequest } from '../../mcp-server/src/services/belief/types.js';

const MODE = process.env.ADJRUN_MODE ?? 'pairs';
const LABEL = process.env.ADJRUN_LABEL!;
const OUT = process.env.ADJRUN_OUT!;
const cfg = BELIEF_ADJUDICATOR_CONFIG;
const apiKey = process.env[cfg.apiKeyEnvVar];

interface PairIn {
  a: { id: string; type: EdgeNodeType; content: string; createdAt: string };
  b: { id: string; type: EdgeNodeType; content: string; createdAt: string };
  cosine: number;
}

interface CallOut {
  verdict: ReturnType<typeof normalizeVerdict>;
  usage: any;
  cost_ticks: number | null;
  latency_ms: number;
  finish_reason: string | null;
}

/** Exact mirror of OpenAICompatAdjudicator.adjudicate body + auth, plus usage capture. */
async function call(req: AdjudicationRequest): Promise<CallOut> {
  const prompt = buildAdjudicationPrompt(req, cfg);
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: cfg.temperature,
    top_p: cfg.topP,
    seed: cfg.seed,
    max_tokens: cfg.maxTokens,
    stream: false,
  };
  if (cfg.sendTopK) body.top_k = cfg.topK;
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  if (cfg.structuredOutput) body.response_format = { type: 'json_object' };
  if (cfg.chatTemplateKwargs) {
    try {
      const parsed = JSON.parse(cfg.chatTemplateKwargs);
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        body.chat_template_kwargs = parsed;
      }
    } catch {
      /* ignore malformed */
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch(`${cfg.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`openai-compat HTTP ${resp.status} for ${cfg.model}: ${errBody.slice(0, 200)}`);
    }
    const json: any = await resp.json();
    const latency_ms = Date.now() - started;
    const rawText = json.choices?.[0]?.message?.content ?? '';
    const finish_reason = json.choices?.[0]?.finish_reason ?? null;
    const parsed = RawVerdictSchema.parse(extractJson(rawText));
    const verdict = normalizeVerdict(parsed);
    const usage = json.usage ?? null;
    const cost_ticks = usage?.cost_in_usd_ticks ?? null;
    return { verdict, usage, cost_ticks, latency_ms, finish_reason };
  } finally {
    clearTimeout(timer);
  }
}

async function runPairs(): Promise<void> {
  const pairs = JSON.parse(await fs.readFile(process.env.ADJRUN_PAIRS!, 'utf-8')) as PairIn[];
  console.log(`🧪 [${LABEL}] provider=${cfg.provider}/${cfg.model} · ${pairs.length} pairs`);
  const results: any[] = [];
  let done = 0;
  let totalTicks = 0;
  for (const p of pairs) {
    const a: AdjudicationRecord = { id: p.a.id, type: p.a.type, content: p.a.content, createdAt: p.a.createdAt };
    const b: AdjudicationRecord = { id: p.b.id, type: p.b.type, content: p.b.content, createdAt: p.b.createdAt };
    let rec: any;
    try {
      const out = await call({ a, b, cosine: p.cosine });
      // Whole records, not ids: the derivation reads both createdAt clocks
      // and refuses a direction that points backwards in time. Passing `a.id`/`b.id` here
      // still COMPILES and still RUNS — this file is outside mcp-server/tsconfig.json — and
      // silently returns `chronology_unknown` for EVERY pair, which would look like a
      // catastrophically bad model rather than a broken harness.
      const outcome = deriveBeliefOutcome(out.verdict, a, b);
      rec = { aId: a.id, bId: b.id, cosine: p.cosine, latency_ms: out.latency_ms, verdict: out.verdict, outcome, usage: out.usage, cost_ticks: out.cost_ticks, finish_reason: out.finish_reason };
      if (out.cost_ticks) totalTicks += out.cost_ticks;
    } catch (e) {
      rec = { aId: a.id, bId: b.id, cosine: p.cosine, latency_ms: 0, error: (e as Error)?.message ?? String(e) };
      console.warn(`   ✗ pair ${a.id.slice(0, 8)}↔${b.id.slice(0, 8)} error: ${rec.error}`);
    }
    results.push(rec);
    if (++done % 10 === 0) console.log(`   [${LABEL}] ${done}/${pairs.length}  (cost so far $${(totalTicks / 1e9).toFixed(4)})`);
  }
  const errors = results.filter((r) => r.error).length;
  const lat = results.filter((r) => !r.error).map((r) => r.latency_ms).sort((x, y) => x - y);
  const report = {
    label: LABEL,
    provider: cfg.provider,
    model: cfg.model,
    adjudicator_config: { ...cfg },
    belief_config: BELIEF_CONFIG,
    pairs: results.length,
    errors,
    latency_ms_median: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    total_cost_usd: totalTicks / 1e9,
    total_cost_ticks: totalTicks,
    results,
  };
  await fs.mkdir(OUT, { recursive: true });
  const outFile = path.join(OUT, `labels-${LABEL}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`\n[${LABEL}] done: ${results.length} pairs, ${errors} errors, median ${report.latency_ms_median}ms, TOTAL COST $${report.total_cost_usd.toFixed(4)} → ${outFile}`);
}

async function runCases(): Promise<void> {
  const doc = JSON.parse(await fs.readFile(process.env.ADJRUN_CASES!, 'utf-8'));
  const recs: Record<string, any> = doc.records;
  console.log(`🧪 [${LABEL}] 6-case scorecard · provider=${cfg.provider}/${cfg.model}`);
  const results: any[] = [];
  let totalTicks = 0;
  for (const c of doc.cases) {
    if (!c.b) {
      results.push({ name: c.name, axis: c.axis, expect: c.expect, skipped: 'axis-3 (expiry) deferred to Increment 3 — no b record' });
      continue;
    }
    const ra = recs[c.a];
    const rb = recs[c.b];
    const a: AdjudicationRecord = { id: ra.id_ref, type: ra.type, content: ra.content, createdAt: ra.created_at };
    const b: AdjudicationRecord = { id: rb.id_ref, type: rb.type, content: rb.content, createdAt: rb.created_at };
    let rec: any;
    try {
      const out = await call({ a, b, cosine: 0.9 });
      // Whole records, not ids: the derivation reads both createdAt clocks
      // and refuses a direction that points backwards in time. Passing `a.id`/`b.id` here
      // still COMPILES and still RUNS — this file is outside mcp-server/tsconfig.json — and
      // silently returns `chronology_unknown` for EVERY pair, which would look like a
      // catastrophically bad model rather than a broken harness.
      const outcome = deriveBeliefOutcome(out.verdict, a, b);
      // Map derived outcome back to record refs for a human-readable pass/fail.
      const idToRef: Record<string, string> = { [ra.id_ref]: c.a, [rb.id_ref]: c.b };
      let gotAction = outcome.action;
      let gotFrom: string | null = null;
      let gotMode: string | null = null;
      if (outcome.action === 'soft_possibly_superseded') {
        gotFrom = idToRef[outcome.fromId] ?? outcome.fromId;
        gotMode = outcome.mode;
      }
      // PASS logic per axis.
      let pass = false;
      if (c.expect.action === 'soft_possibly_superseded') {
        pass = outcome.action === 'soft_possibly_superseded' && gotFrom === c.expect.from && gotMode === c.expect.mode;
      } else if (c.expect.action === 'none') {
        pass = outcome.action === 'none';
      }
      rec = {
        name: c.name, axis: c.axis, expect: c.expect,
        got: { action: gotAction, from: gotFrom, mode: gotMode, reason: (outcome as any).reason ?? null },
        verdict: out.verdict, pass, latency_ms: out.latency_ms, cost_ticks: out.cost_ticks,
      };
      if (out.cost_ticks) totalTicks += out.cost_ticks;
    } catch (e) {
      rec = { name: c.name, axis: c.axis, expect: c.expect, error: (e as Error)?.message ?? String(e), pass: false };
    }
    results.push(rec);
    const mark = rec.pass ? '✓' : rec.skipped ? '·' : '✗';
    console.log(`   ${mark} [axis ${c.axis}] ${c.name}`);
  }
  const report = { label: LABEL, provider: cfg.provider, model: cfg.model, total_cost_usd: totalTicks / 1e9, results };
  await fs.mkdir(OUT, { recursive: true });
  const outFile = path.join(OUT, `cases-${LABEL}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));
  const scored = results.filter((r) => !r.skipped);
  const passed = scored.filter((r) => r.pass).length;
  console.log(`\n[${LABEL}] 6-case: ${passed}/${scored.length} scored cases pass (axis-3 deferred). cost $${report.total_cost_usd.toFixed(4)} → ${outFile}`);
}

async function main(): Promise<void> {
  if (MODE === 'cases') await runCases();
  else await runPairs();
}

main().catch((e) => {
  console.error('xaiAdjRun failed:', e);
  process.exit(2);
});
