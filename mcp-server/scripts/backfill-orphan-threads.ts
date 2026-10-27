#!/usr/bin/env node

/**
 * ONE-TIME ORPHAN BACKFILL — CLI entrypoint (reliable-auto-threading ST-6)
 * (branch:mandrel-reliability, task ST-6 an earlier change, spec
 * docs/specs/reliable-auto-threading.md §C1/C2/C3, §X4).
 *
 * Thin npx-tsx wrapper (mirrors scripts/migrate.ts's invocation style) around the testable
 * core in src/services/orphanBackfill.ts. It parses flags, opens/closes the DB, resolves the
 * project, runs the backfill, and prints a human summary. All logic + the safe-by-default
 * posture live in the core module (single source; the contract test exercises it directly).
 *
 * SAFETY (spec §X4): DRY-RUN IS THE DEFAULT — a live write requires an explicit `--apply`.
 * Do NOT run against the prod / `riverbend` DB from a dev build; that real-corpus run is
 * gated by Coordinator/Operator after Reviewer APPROVE.
 *
 * USAGE:  npx tsx scripts/backfill-orphan-threads.ts --project <name|id> [--dry-run | --apply] [--threshold <n>]
 *         npx tsx scripts/backfill-orphan-threads.ts --help
 */

// Import ONLY the db-free CLI surface statically. The DB-heavy modules (database.ts throws
// at load without DATABASE_NAME) are imported DYNAMICALLY inside main(), AFTER the help/parse
// check, so `--help` and arg errors work without any DB env.
import { parseArgs, usageText, type BackfillCliOptions } from '../src/services/orphanBackfill.cli.js';
import { unrescuableBreakdown, type BackfillSummary } from '../src/services/orphanBackfill.js';

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

function printSummary(s: BackfillSummary): void {
  const mode = s.dryRun ? 'DRY-RUN (no writes)' : 'LIVE (--apply)';
  console.log('');
  console.log('==============================================================');
  console.log(`  Orphan backfill summary — ${mode}`);
  console.log('==============================================================');
  console.log(`  Project            : ${s.projectName} (${s.projectId})`);
  console.log(`  Threshold (cosine) : ${s.threshold}`);
  console.log(`  Total contexts     : ${s.totalContexts} (active, non-archived)`);
  console.log(`  Orphans before     : ${s.orphansBefore} (${pct(s.orphansBefore, s.totalContexts)})`);
  console.log(`  Rescuable          : ${s.rescuable}`);
  console.log(`    ${s.dryRun ? 'would mint   ' : 'newly minted '}    : ${s.dryRun ? s.rescuable : s.minted}`);
  console.log(`  Un-rescuable       : ${s.unrescuable}`);
  // Derived from the summary in ONE place (services/orphanBackfill.unrescuableBreakdown), which
  // also RECONCILES the parts against the total — so this report cannot silently print a subset
  // of the causes the way it did when the bucket list lived here.
  for (const part of unrescuableBreakdown(s)) {
    console.log(`    ${part.label.padEnd(26)}: ${part.count}`);
  }
  console.log(
    `  Orphans after      : ${s.orphansAfter} (${pct(s.orphansAfter, s.totalContexts)})${s.dryRun ? ' [projected]' : ''}`
  );
  console.log('--------------------------------------------------------------');
  if (s.unrescuableIds.length > 0) {
    // No silent truncation — the full list of un-rescued orphan ids is reported.
    console.log(`  Un-rescued orphan ids (${s.unrescuableIds.length}):`);
    for (const id of s.unrescuableIds) console.log(`    - ${id}`);
  } else {
    console.log('  Every orphan was rescuable at this threshold.');
  }
  console.log('==============================================================');
  console.log('');
}

async function main(): Promise<void> {
  let options: BackfillCliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}\n`);
    console.log(usageText());
    process.exit(2);
    return;
  }

  if (options.help) {
    console.log(usageText());
    process.exit(0);
    return;
  }

  // DB-heavy modules loaded here (not at top) so --help / parse errors need no DB env.
  const { db, initializeDatabase, closeDatabase } = await import('../src/config/database.js');
  const { resolveProjectRef, backfillOrphanThreads } = await import('../src/services/orphanBackfill.js');

  await initializeDatabase();
  try {
    const project = await resolveProjectRef(options.project);
    if (!options.dryRun) {
      console.log(`WARNING: LIVE MODE (--apply): minting related_to edges in project "${project.name}".`);
    } else {
      console.log(`DRY-RUN (default): projecting rescue in project "${project.name}" — nothing will be written.`);
    }
    const summary = await backfillOrphanThreads(
      { projectId: project.id, projectName: project.name, dryRun: options.dryRun, threshold: options.threshold },
      db
    );
    printSummary(summary);
  } finally {
    await closeDatabase();
  }
}

// Run only when executed directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Backfill failed:', error);
      process.exit(1);
    });
}
