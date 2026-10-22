#!/usr/bin/env node

/**
 * Backfill Decision Embeddings
 *
 * Generates semantic embeddings for technical_decisions rows that currently have a
 * NULL embedding (i.e. every decision created before migration 045 added the
 * embedding column, on prod and every tenant). Without this, those legacy decisions
 * are findable only via the trgm/text fallback — the backfill makes them fully
 * semantically searchable, matching how context_search treats backfilled contexts.
 *
 * Embedding text mirrors decision_record exactly (buildDecisionEmbeddingText:
 * type + tags + title + description + rationale + problem/success). Uses the SAME
 * local embedder (FREE — $0, no paid API) and 1536 dimensions.
 *
 * Idempotent + safe to re-run: only touches rows WHERE embedding IS NULL, never the
 * already-embedded ones. Per-row best-effort — a single failure is logged and the
 * run continues.
 *
 * Usage (point DATABASE_* env at the target DB — prod or a tenant):
 *   npx tsx scripts/backfill-decision-embeddings.ts --dry-run   # report only
 *   npx tsx scripts/backfill-decision-embeddings.ts             # write embeddings
 *   npx tsx scripts/backfill-decision-embeddings.ts --batch-size=20
 */

import { db, initializeDatabase } from '../src/config/database.js';
import { embeddingService } from '../src/services/embedding.js';
import { buildDecisionEmbeddingText } from '../src/handlers/decisions.js';

interface DecisionRow {
  id: string;
  decision_type: string | null;
  title: string | null;
  description: string | null;
  rationale: string | null;
  problem_statement: string | null;
  success_criteria: string | null;
  tags: string[] | null;
}

interface Stats {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

async function getDecisionsNeedingEmbeddings(): Promise<DecisionRow[]> {
  console.log('🔍 Finding decisions that need embeddings...');
  const result = await db.query<DecisionRow>(`
    SELECT id, decision_type, title, description, rationale,
           problem_statement, success_criteria, tags
    FROM technical_decisions
    WHERE embedding IS NULL
    ORDER BY decision_date ASC
  `);
  console.log(`📊 Found ${result.rows.length} decisions needing embeddings`);
  return result.rows;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const batchArg = args.find(a => a.startsWith('--batch-size='));
  const batchSize = Math.max(1, Math.min(50, batchArg ? parseInt(batchArg.split('=')[1], 10) || 10 : 10));

  console.log('🚀 Backfilling decision embeddings...');
  if (dryRun) console.log('🔍 DRY RUN — no writes will be made');
  console.log(`📦 Batch size: ${batchSize}`);

  await initializeDatabase();
  console.log('✅ Database connection established');

  const decisions = await getDecisionsNeedingEmbeddings();
  const stats: Stats = { total: decisions.length, processed: 0, successful: 0, failed: 0, errors: [] };

  if (decisions.length === 0) {
    console.log('🎉 All decisions already have embeddings — nothing to do.');
    return;
  }

  for (let i = 0; i < decisions.length; i += batchSize) {
    const batch = decisions.slice(i, i + batchSize);
    console.log(`\n📦 Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(decisions.length / batchSize)}`);

    for (const d of batch) {
      stats.processed++;
      try {
        const text = buildDecisionEmbeddingText({
          decisionType: d.decision_type,
          title: d.title,
          description: d.description,
          rationale: d.rationale,
          problemStatement: d.problem_statement,
          successCriteria: d.success_criteria,
          tags: d.tags,
        });
        if (!text.trim()) {
          throw new Error('empty embedding text');
        }
        const { embedding, dimensions } = await embeddingService.generateEmbedding({ text });
        if (!embedding || dimensions !== 1536) {
          throw new Error(`bad embedding dimensions: ${dimensions}`);
        }
        if (!dryRun) {
          await db.query(
            `UPDATE technical_decisions SET embedding = $1::vector WHERE id = $2`,
            [`[${embedding.join(',')}]`, d.id]
          );
        }
        stats.successful++;
        console.log(`✅ ${dryRun ? '[dry-run] ' : ''}embedded ${d.id} — "${(d.title || '').substring(0, 50)}"`);
      } catch (err) {
        stats.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        stats.errors.push({ id: d.id, error: msg });
        console.error(`❌ failed ${d.id}: ${msg}`);
      }
      console.log(`📊 ${stats.processed}/${stats.total} — ✅ ${stats.successful} / ❌ ${stats.failed}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`📊 BACKFILL ${dryRun ? '(DRY RUN) ' : ''}RESULTS`);
  console.log(`Total: ${stats.total} | ✅ ${stats.successful} | ❌ ${stats.failed}`);
  if (stats.errors.length > 0) {
    console.log(`\nErrors:`);
    stats.errors.forEach((e, idx) => console.log(`  ${idx + 1}. ${e.id}: ${e.error}`));
  }
  console.log('='.repeat(60));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(() => process.exit(0))
    .catch(err => { console.error('❌ Backfill failed:', err); process.exit(1); });
}

export { run };
