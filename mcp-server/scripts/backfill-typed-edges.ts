#!/usr/bin/env node

/**
 * BACKFILL TYPED EDGES — CLI runner (Mandrel Core Redesign T2a).
 *
 * Thin wrapper around src/services/backfillTypedEdges.ts runBackfill(). The real,
 * type-checked + unit-tested logic lives in src/ (so the contract test can import it);
 * this file is only the runnable entrypoint, mirroring scripts/migrate.ts.
 *
 * Mints typed edges for EXISTING records from their threading tags + decision evidence
 * + decision.superseded_by, so the graph is populated from real data for T2b/T3.
 * IDEMPOTENT (UNIQUE dedup): re-run = no dupes. PROJECT-SCOPED + ROBUST.
 *
 * Usage (point DATABASE_* env at the TARGET db; NEVER run against prod from here — the coordinator
 * runs it after deploy. Build+test against the disposable CI DB):
 *   npx tsx scripts/backfill-typed-edges.ts --dry-run   # report only, mint nothing
 *   npx tsx scripts/backfill-typed-edges.ts             # mint edges
 */

import { runBackfill, formatBackfillStats } from '../src/services/backfillTypedEdges.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  console.log(`🔗 Typed-edge backfill — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (writing edges)'}`);
  const stats = await runBackfill({ dryRun: DRY_RUN });
  if (DRY_RUN) console.log('↩️  DRY RUN — transaction rolled back; no edges persisted.');
  else console.log('✅ Committed.');
  console.log(formatBackfillStats(stats, DRY_RUN));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ Backfill failed:', error);
      process.exit(1);
    });
}
