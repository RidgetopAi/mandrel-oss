#!/usr/bin/env node
/**
 * Re-embed backfill CLI — a THIN wrapper over
 * src/services/reembedBackfill.ts (the testable core). Re-embeds every row of every table in the
 * BACKFILL REGISTRY (services/reembedBackfill.ts BACKFILL_TABLES — contexts, technical_decisions
 * and, since migration 088, tasks) in a target project (or all) through the CURRENTLY-SELECTED embedder
 * (embeddingConfig.activeEmbedder()) and writes into that embedder's column (e.g.
 * `embedding_gemma` when MANDREL_EMBEDDER=gemma). After migration 056 adds the 768-d
 * column, every legacy row has a NULL gemma vector until this runs.
 *
 *  • DRY-RUN BY DEFAULT — reports counts, writes nothing unless --apply.
 *  • IDEMPOTENT + RESUMABLE — default only touches rows WHERE <col> IS NULL; re-run resumes.
 *  • --force re-embeds ALL rows in scope (scope respected — see reembedBackfill.buildWhere).
 *  • PROD-SAFETY GATE — refuses --apply against a non-test DB name unless
 *    --i-understand-target is passed (the coordinator sets it for the gated prod/tenant rollout).
 *
 * Usage:
 *   MANDREL_EMBEDDER=gemma DATABASE_NAME=mandrel_gemma_test \
 *     npx tsx scripts/reembed-gemma.ts --project=<id|name> [--apply] [--force] [--batch-size=32]
 *   ... --all-projects   # backfill every project
 */

import { initializeDatabase, closeDatabase } from '../src/config/database.js';
import { activeEmbedder, activeEmbedderKey, activeEmbeddingColumn } from '../src/config/embeddingConfig.js';
import {
  backfillAllTables, BACKFILL_TABLES, resolveProjectId, type BackfillArgs,
} from '../src/services/reembedBackfill.js';

function parseArgs(argv: string[]): BackfillArgs {
  const a: BackfillArgs = { apply: false, force: false, batchSize: 32, allProjects: false, understandTarget: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') a.apply = true;
    else if (arg === '--force') a.force = true;
    else if (arg === '--all-projects') a.allProjects = true;
    else if (arg === '--i-understand-target') a.understandTarget = true;
    else if (arg.startsWith('--batch-size=')) a.batchSize = Math.max(1, parseInt(arg.split('=')[1], 10) || 32);
    else if (arg.startsWith('--project=')) a.project = arg.split('=')[1];
  }
  return a;
}

/** A DB name we treat as a safe disposable/dev target (no extra gate needed to --apply). */
function isObviouslyTestDb(name: string): boolean {
  return /test|dev|scratch|tmp|staging|_gemma/i.test(name);
}

async function main() {
  const args = parseArgs(process.argv);
  const dbName = process.env.DATABASE_NAME || process.env.DB_NAME || '(default)';

  console.log('════════════════════════════════════════════════════════════');
  console.log(`🔮 Re-embed backfill — embedder: ${activeEmbedder().label} [${activeEmbedderKey()}]`);
  console.log(`   backend=${activeEmbedder().backend} dim=${activeEmbedder().dimensions} column=${activeEmbeddingColumn()}`);
  console.log(`   target DB: ${dbName}   mode: ${args.apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log('════════════════════════════════════════════════════════════');

  if (args.apply && !isObviouslyTestDb(dbName) && !args.understandTarget) {
    console.error(`❌ Refusing to --apply against non-test DB "${dbName}" without --i-understand-target.`);
    console.error('   (Backup first + confirm this is the intended prod/tenant target — Coordinator drives the gated rollout.)');
    process.exit(2);
  }
  if (!args.project && !args.allProjects) {
    console.error('❌ Specify --project=<id|name> or --all-projects.');
    process.exit(2);
  }

  await initializeDatabase();

  let projectFilter: string | null = null;
  if (args.project) {
    projectFilter = await resolveProjectId(args.project);
    if (!projectFilter) { console.error(`❌ Project not found: ${args.project}`); await closeDatabase(); process.exit(2); }
    console.log(`🎯 Project: ${args.project} → ${projectFilter}`);
  } else {
    console.log('🎯 Scope: ALL projects');
  }

  // ITERATES THE REGISTRY — this CLI names no table. Whatever is in
  // BACKFILL_TABLES is backfilled and reported; nothing else is.
  const stats = await backfillAllTables(projectFilter, args);

  console.log('────────────────────────────────────────────────────────────');
  let grandTotal = 0, grandFailed = 0;
  for (const spec of BACKFILL_TABLES) {
    const st = stats[spec.key];
    grandTotal += st.total; grandFailed += st.failed;
    console.log(`✅ ${spec.label.padEnd(10)} ${st.done}/${st.total} ${args.apply ? 'embedded' : 'would embed'}${st.failed ? `, ${st.failed} failed` : ''}`);
  }
  console.log(`   TOTAL rows ${args.apply ? 'embedded' : 'needing re-embed'}: ${grandTotal}`);
  if (!args.apply) console.log('ℹ️  DRY-RUN — re-run with --apply to write. Idempotent: resumes from NULL rows.');
  console.log('────────────────────────────────────────────────────────────');

  await closeDatabase();
  process.exit(grandFailed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('❌ Backfill crashed:', e); process.exit(1); });
