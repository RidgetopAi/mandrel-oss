#!/usr/bin/env node

/**
 * BACKFILL DECLARED LIMBS — CLI runner (BRANCH-1).
 *
 * Thin wrapper around src/services/backfillDeclaredLimbs.ts. The real, type-checked and
 * contract-tested logic lives in src/ (so the tests can import it); this file is only the
 * runnable entrypoint, mirroring scripts/backfill-typed-edges.ts.
 *
 * Materialises `declared_limbs` for records that already exist, using the SAME derivation
 * the write path uses. Idempotent and re-runnable.
 *
 * Usage (point DATABASE_* env at the TARGET db; NEVER run against prod from here — the coordinator
 * runs it after deploy):
 *   npx tsx scripts/backfill-declared-limbs.ts --dry-run
 *   npx tsx scripts/backfill-declared-limbs.ts --project riverbend
 *   npx tsx scripts/backfill-declared-limbs.ts --only-missing
 *   npx tsx scripts/backfill-declared-limbs.ts --created-from 2026-07-04
 */

import {
  runDeclaredLimbsBackfill,
  formatDeclaredLimbsStats,
} from '../src/services/backfillDeclaredLimbs.js';

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_MISSING = process.argv.includes('--only-missing');
const PROJECT = flagValue('--project');
const CREATED_FROM = flagValue('--created-from');

async function main(): Promise<void> {
  console.log(
    `🌿 Declared-limbs backfill — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (writing declared_limbs)'}` +
      (PROJECT ? ` · project=${PROJECT}` : '') +
      (ONLY_MISSING ? ' · only rows never derived' : '') +
      (CREATED_FROM ? ` · created >= ${CREATED_FROM}` : '')
  );
  const stats = await runDeclaredLimbsBackfill({
    dryRun: DRY_RUN,
    projectName: PROJECT,
    onlyMissing: ONLY_MISSING,
    createdAtFrom: CREATED_FROM,
  });
  console.log(formatDeclaredLimbsStats(stats, DRY_RUN));
  if (stats.errors.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      console.error('❌ Backfill failed:', error);
      process.exit(1);
    });
}
