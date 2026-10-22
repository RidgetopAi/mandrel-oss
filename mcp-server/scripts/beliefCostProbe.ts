#!/usr/bin/env node
/**
 * beliefCostProbe (UNCOMMITTED) — measure REAL Groq token usage/pair for the dry-run cost number.
 * Rebuilds the EXACT adjudication prompt (buildAdjudicationPrompt) for a sample of the run's pairs,
 * calls Groq with the locked config, and sums usage.{prompt,completion}_tokens. Prints per-pair
 * averages so the full-backfill cost can be extrapolated. Reads GROQ_API_KEY by name (never printed).
 */
import fs from 'fs/promises';
import { BELIEF_ADJUDICATOR_CONFIG } from '../src/config/beliefConfig.js';
import { buildAdjudicationPrompt } from '../src/services/belief/ollamaAdjudicator.js';

const SAMPLE = Number(process.env.PROBE_SAMPLE ?? '15');
async function main() {
  const dir = '../evals/belief-eval/out';
  const files = (await fs.readdir(dir)).filter((x) => x.startsWith('dryrun-result-') && x.endsWith('.json')).sort();
  const f = dir + '/' + files.at(-1)!;
  const d = JSON.parse(await fs.readFile(f, 'utf-8'));
  const res = (d.all_results as any[]).filter((r) => !r.error);
  // Even spread across the list (cosine-sorted) so the sample is representative of prompt sizes.
  const step = Math.max(1, Math.floor(res.length / SAMPLE));
  const pick = res.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const cfg = BELIEF_ADJUDICATOR_CONFIG;
  const key = process.env[cfg.apiKeyEnvVar];
  if (!key) throw new Error('no key');
  let pin = 0, pout = 0, n = 0;
  for (const r of pick) {
    // Reconstruct records from the minted_detail/all_results — we only have ids+cosine here, so
    // rebuild a representative prompt from the corpus contents.
    const corpus = JSON.parse(await fs.readFile('../evals/belief-eval/out/corpus.json', 'utf-8'));
    const byId: Record<string, any> = Object.fromEntries(corpus.map((c: any) => [c.id, c]));
    const a = byId[r.aId], b = byId[r.bId];
    if (!a || !b) continue;
    const prompt = buildAdjudicationPrompt(
      { a: { id: a.id, type: a.type, content: a.content, createdAt: a.created_at },
        b: { id: b.id, type: b.type, content: b.content, createdAt: b.created_at }, cosine: r.cosine }, cfg);
    const body: any = { model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0, top_p: 1, seed: 0, max_tokens: cfg.maxTokens, stream: false, reasoning_effort: 'low', response_format: { type: 'json_object' } };
    const resp = await fetch(`${cfg.endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const j: any = await resp.json();
    if (j.usage) { pin += j.usage.prompt_tokens; pout += j.usage.completion_tokens; n++; }
  }
  console.log(`sampled ${n} pairs`);
  console.log(`avg prompt(in) tokens/pair:     ${(pin / n).toFixed(0)}`);
  console.log(`avg completion(out) tokens/pair: ${(pout / n).toFixed(0)}  (includes low reasoning)`);
  // Groq gpt-oss-120b list price (2026): $0.15/M input, $0.75/M output.
  const IN = 0.15, OUT = 0.75, PAIRS = d.adjudicated;
  const cin = (pin / n) * PAIRS / 1e6 * IN, cout = (pout / n) * PAIRS / 1e6 * OUT;
  console.log(`\nfull run = ${PAIRS} adjudicated pairs`);
  console.log(`est input cost:  $${cin.toFixed(3)}`);
  console.log(`est output cost: $${cout.toFixed(3)}`);
  console.log(`EST TOTAL:       $${(cin + cout).toFixed(3)}  (~$${((cin + cout) / PAIRS * 1000).toFixed(3)}/1000 pairs)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
