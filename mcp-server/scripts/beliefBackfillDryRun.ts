#!/usr/bin/env node
/**
 * beliefBackfillDryRun — FULL-PIPELINE pre-prod dry-run of the belief layer (UNCOMMITTED).
 *
 * Purpose (the coordinator/the builder dry-run, the adjudicator lock): run the CURRENT committed
 * pipeline (picker fix 0.60/0.95 + auto-record filter → Groq gpt-oss-120b → reconcile/mint)
 * over the REAL riverbend corpus into a DISPOSABLE DB, and MEASURE how many supersedes edges
 * it would actually mint + whether they are right. NEVER touches prod (writes only the ci_*
 * disposable DB in DATABASE_*; corpus vectors are pulled read-only + copied verbatim).
 *
 * This is the one path the split nominate/score harness never ran: the FULL mint+reconcile
 * end-to-end on real data.
 *
 * WHERE THE RETRACT/RE-MINT EXERCISE WENT. The `ADJRUN_RECONCILE_TEST` flag
 * deleted in 6ddf00d is not coming back here: it was coupled to this paid run only because
 * it drew its sample from the run's minted edges, and reconcileBeliefEdge needs no provider.
 * It is ported to src/tests/beliefEdgeReconciliationRealRows.contract.test.ts, which runs the
 * same retract/re-mint round trip against real `links` rows on the disposable CI DB, for free
 * and on every gate run.
 *
 * Env:
 *   ADJRUN_CORPUS        path to corpus.json ([{id,type,content,created_at,emb}], verbatim gemma vecs)
 *   ADJRUN_OUT           output dir
 *   ADJRUN_CONCURRENCY   parallel adjudications (measurement box, no embedder contention). Default 6.
 *   ADJRUN_NOMINATE_ONLY '1' → stop after nomination (size the run before spending). Default 0.
 *   BELIEF_ADJUDICATOR_*  provider config (openai-compat/Groq)
 *   MANDREL_EMBEDDER=gemma so activeEmbeddingColumn()=embedding_gemma (vectors copied, embedder NOT invoked)
 */

import fs from 'fs/promises';
import path from 'path';

import { db, initializeDatabase, closeDatabase } from '../src/config/database.js';
import { activeEmbedderKey, activeEmbeddingColumn } from '../src/config/embeddingConfig.js';
import { BELIEF_CONFIG, BELIEF_ADJUDICATOR_CONFIG } from '../src/config/beliefConfig.js';
import type { EdgeNodeType } from '../src/config/edgeTypes.js';
import { findCandidates } from '../src/services/belief/candidatePairing.js';
import { adjudicatePair } from '../src/services/belief/beliefAdjudicator.js';
import { getAdjudicationProvider } from '../src/services/belief/provider.js';
import { shapeMintedReport, type MintedEdgeRow } from '../src/services/belief/dryRunReport.js';
import type { AdjudicationRecord } from '../src/services/belief/types.js';

interface CorpusRow {
  id: string;
  type: EdgeNodeType;
  content: string;
  created_at: string;
  /** metadata->>'kind' (e.g. 'tick-proposal') — REQUIRED for the picker's auto-record exclusion. */
  kind: string | null;
  emb: string;
}

const CORPUS = process.env.ADJRUN_CORPUS!;
const OUT = process.env.ADJRUN_OUT!;
const CONCURRENCY = Math.max(1, Number(process.env.ADJRUN_CONCURRENCY ?? '6'));
const NOMINATE_ONLY = process.env.ADJRUN_NOMINATE_ONLY === '1';

async function seedProject(): Promise<string> {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1,$2) RETURNING id::text AS id`,
    ['belief-backfill-dryrun', 'Full-pipeline dry-run — real riverbend corpus']
  );
  return r.rows[0].id;
}

async function seedRow(projectId: string, row: CorpusRow): Promise<void> {
  // Preserve metadata->>'kind' verbatim so the picker's auto-record exclusion fires identically
  // to prod (drop tick-proposal/dispatch-proof endpoints). NULL kind → empty metadata.
  const meta = row.kind ? JSON.stringify({ kind: row.kind }) : '{}';
  if (row.type === 'context') {
    await db.query(
      `INSERT INTO contexts (id, project_id, context_type, content, metadata, ${activeEmbeddingColumn()}, created_at)
       VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6::vector,$7)`,
      [row.id, projectId, 'completion', row.content, meta, row.emb, row.created_at]
    );
  } else {
    await db.query(
      `INSERT INTO technical_decisions
         (id, project_id, decision_type, title, description, rationale, metadata, ${activeEmbeddingColumn()}, decision_date)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::vector,$9)`,
      [row.id, projectId, 'architecture', row.content.slice(0, 60), row.content, row.content, meta, row.emb, row.created_at]
    );
  }
}

interface NomPair {
  aId: string;
  bId: string;
  aType: EdgeNodeType;
  bType: EdgeNodeType;
  cosine: number;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  await initializeDatabase();
  if (activeEmbedderKey() !== 'gemma') {
    throw new Error(`Active embedder is "${activeEmbedderKey()}", need gemma. Set MANDREL_EMBEDDER=gemma.`);
  }
  const corpus = JSON.parse(await fs.readFile(CORPUS, 'utf-8')) as CorpusRow[];
  const byId = new Map<string, CorpusRow>();
  for (const r of corpus) byId.set(r.id, r);

  console.log(`🌱 Seeding ${corpus.length} real records (column=${activeEmbeddingColumn()})…`);
  const projectId = await seedProject();
  let n = 0;
  for (const row of corpus) {
    await seedRow(projectId, row);
    if (++n % 200 === 0) console.log(`   seeded ${n}/${corpus.length}`);
  }

  // Stage-1 nomination over EVERY record with the CURRENT committed config (deduped pairs).
  console.log(
    `🔎 findCandidates: pairMinCosine=${BELIEF_CONFIG.pairMinCosine} pairMaxCosine=${BELIEF_CONFIG.pairMaxCosine} ` +
      `topK=${BELIEF_CONFIG.pairTopK} exclude=${JSON.stringify(BELIEF_CONFIG.pairExcludeAutoRecordKinds)}`
  );
  const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const pairs = new Map<string, NomPair>();
  let sources = 0;
  // See adjNominate: a fail-open pairing query yields no candidate, so an uncounted failure
  // would silently understate the nomination.
  let pairingFailures = 0;
  let firstPairingFailure = '';
  for (const row of corpus) {
    const pairing = await findCandidates({ id: row.id, type: row.type, projectId }, BELIEF_CONFIG);
    if (!pairing.ok) {
      pairingFailures += 1;
      firstPairingFailure =
        firstPairingFailure || `${pairing.reason.stage} (${pairing.reason.subject}): ${pairing.reason.message}`;
    }
    // The failure arm names its list `partial`, so this read cannot skip the `.ok` test above.
    for (const c of (pairing.ok ? pairing.candidates : pairing.partial)) {
      if (c.id === row.id) continue;
      const k = pairKey(row.id, c.id);
      const prev = pairs.get(k);
      if (!prev || c.cosine > prev.cosine) {
        pairs.set(k, { aId: row.id, bId: c.id, aType: row.type, bType: c.type, cosine: c.cosine });
      }
    }
    if (++sources % 200 === 0) console.log(`   nominated over ${sources}/${corpus.length} sources`);
  }
  if (pairingFailures > 0) {
    console.warn(
      `⚠️  ${pairingFailures}/${corpus.length} sources had a FAILED pairing query — this dry run is INCOMPLETE. First: ${firstPairingFailure}`
    );
  }
  const allPairs = [...pairs.values()].sort((a, b) => b.cosine - a.cosine);
  console.log(`\n=== NOMINATION ===\nunique nominated pairs: ${allPairs.length} (from ${corpus.length} records)`);

  if (NOMINATE_ONLY) {
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(
      path.join(OUT, 'dryrun-nomination.json'),
      JSON.stringify({ config: BELIEF_CONFIG, seeded: corpus.length, nominated_pairs: allPairs.length }, null, 2)
    );
    console.log('NOMINATE_ONLY — stopping before adjudication.');
    await closeDatabase();
    return;
  }

  // Optional representative CAP (ADJRUN_MAX_PAIRS): sample evenly-spaced across the
  // cosine-sorted list so the subset spans the WHOLE band (not just high-cosine near-dupes).
  // Deterministic (no RNG) → reproducible. 0/unset = run every nominated pair.
  const MAX_PAIRS = Number(process.env.ADJRUN_MAX_PAIRS ?? '0');
  let runPairs = allPairs;
  if (MAX_PAIRS > 0 && allPairs.length > MAX_PAIRS) {
    const step = allPairs.length / MAX_PAIRS;
    runPairs = Array.from({ length: MAX_PAIRS }, (_, i) => allPairs[Math.floor(i * step)]);
    console.log(`   ADJRUN_MAX_PAIRS=${MAX_PAIRS} → sampling ${runPairs.length} of ${allPairs.length} pairs (evenly across cosine).`);
  }

  // Stage-2 + derive + reconcile/mint, bounded-concurrency. adjudicatePair writes to DB.
  const provider = getAdjudicationProvider();
  console.log(`\n🧪 Adjudicating ${runPairs.length} pairs with ${provider.name}/${provider.model} (concurrency=${CONCURRENCY})…`);
  const results: any[] = [];
  let done = 0;
  let idx = 0;
  const adjT0 = Date.now();
  async function worker(): Promise<void> {
    while (idx < runPairs.length) {
      const myi = idx++;
      const p = runPairs[myi];
      const aRow = byId.get(p.aId)!;
      const bRow = byId.get(p.bId)!;
      const a: AdjudicationRecord = { id: p.aId, type: p.aType, content: aRow.content, createdAt: aRow.created_at };
      const b: AdjudicationRecord = { id: p.bId, type: p.bType, content: bRow.content, createdAt: bRow.created_at };
      const started = Date.now();
      let attempt = 0;
      let retries = 0;
      // Retry on Groq 429 TPM limits with backoff (honour the "try again in Ns" hint). The
      // provider throws BEFORE any DB write on a 429, so retrying the whole adjudicatePair is
      // safe/idempotent. This self-throttles the run under Groq's ~250K TPM on-demand ceiling.
      for (;;) {
        try {
          const res = await adjudicatePair(a, b, { cosine: p.cosine, projectId, provider }, db);
          results.push({
            aId: p.aId, bId: p.bId, aType: p.aType, bType: p.bType, cosine: p.cosine,
            latency_ms: Date.now() - started, retries,
            verdict: res.verdict, outcome: res.outcome,
            mintedEdgeId: res.mintedEdgeId, edgeCreated: res.edgeCreated,
          });
          break;
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          const is429 = msg.includes('429');
          if (is429 && attempt < 40) {
            attempt++; retries++;
            const m = msg.match(/try again in ([\d.]+)s/i);
            const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 250 : Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          results.push({ aId: p.aId, bId: p.bId, cosine: p.cosine, latency_ms: Date.now() - started, retries, error: msg });
          break;
        }
      }
      if (++done % 25 === 0) console.log(`   ${done}/${runPairs.length} (mints so far: ${results.filter(r => r.edgeCreated).length})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const adjMs = Date.now() - adjT0;

  // Ground truth: what actually landed in the links table.
  const mintedEdges = await db.query(
    `SELECT from_id::text AS from_id, to_id::text AS to_id, edge_type,
            metadata->>'mode' AS mode, metadata->>'confidence' AS confidence,
            metadata->>'cosine' AS cosine, metadata->>'rationale' AS rationale
       FROM links WHERE created_by = 'auto:belief-adjudicator' ORDER BY created_at`
  );

  // Enrich minted edges with both records' content.
  const tierReport = shapeMintedReport(
    mintedEdges.rows as MintedEdgeRow[],
    (id) => byId.get(id)?.content,
  );
  const mintedDetail = tierReport.minted_detail;

  const errors = results.filter((r) => r.error);
  const nominated = allPairs.length;
  const minted = tierReport.minted_edges;
  const verdictBreakdown: Record<string, number> = {};
  const noEdgeReasons: Record<string, number> = {};
  for (const r of results) {
    if (r.error) continue;
    verdictBreakdown[r.verdict.verdict] = (verdictBreakdown[r.verdict.verdict] ?? 0) + 1;
    if (r.outcome.action === 'none') noEdgeReasons[r.outcome.reason] = (noEdgeReasons[r.outcome.reason] ?? 0) + 1;
  }
  const lat = results.filter((r) => !r.error).map((r) => r.latency_ms).sort((a, b) => a - b);

  const report = {
    timestamp: new Date().toISOString(),
    corpus_records: corpus.length,
    nominated_pairs: nominated,
    sampled_pairs: runPairs.length,
    adjudicated: results.length - errors.length,
    errors: errors.length,
    minted_edges: minted,
    mint_rate_of_sampled: runPairs.length ? (minted / runPairs.length) : 0,
    mint_rate_of_nominated: nominated ? (minted / nominated) : 0,
    verdict_breakdown: verdictBreakdown,
    no_edge_reasons: noEdgeReasons,
    wall_time_total_ms: Date.now() - t0,
    adjudication_wall_ms: adjMs,
    adjudication_median_latency_ms: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    concurrency: CONCURRENCY,
    config: { belief: BELIEF_CONFIG, adjudicator: { ...BELIEF_ADJUDICATOR_CONFIG } },
    minted_detail: mintedDetail,
    errors_detail: errors,
    all_results: results,
  };
  await fs.mkdir(OUT, { recursive: true });
  const outFile = path.join(OUT, `dryrun-result-${Date.now()}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));

  console.log(`\n===== BELIEF BACKFILL DRY-RUN =====`);
  console.log(`corpus records:      ${corpus.length}`);
  console.log(`nominated pairs:     ${nominated}`);
  console.log(`adjudicated:         ${results.length - errors.length}  (errors: ${errors.length})`);
  console.log(`MINTED:              ${minted}   (mint rate of nominated: ${(100 * minted / Math.max(1, nominated)).toFixed(2)}%)`);
  console.log(`verdicts:            ${JSON.stringify(verdictBreakdown)}`);
  console.log(`no-edge reasons:     ${JSON.stringify(noEdgeReasons)}`);
  console.log(`adj wall / median:   ${(adjMs / 1000).toFixed(1)}s / ${report.adjudication_median_latency_ms}ms`);
  console.log(`report:              ${outFile}`);

  await closeDatabase();
}

main().catch(async (e) => {
  console.error('beliefBackfillDryRun failed:', e);
  try { await closeDatabase(); } catch { /* ignore */ }
  process.exit(2);
});
