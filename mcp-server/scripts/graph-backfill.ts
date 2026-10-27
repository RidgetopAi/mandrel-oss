#!/usr/bin/env node

/**
 * SCHEDULED GRAPH BACKFILL — CLI entrypoint (PHASE 3).
 *
 * Thin wrapper around services/graphBackfill.ts (logic-in-src, thin-executable-in-scripts —
 * the repo pattern, and what lets the contract test import the core under `rootDir: src`).
 *
 * THIS IS THE FILE A SCHEDULED RUN INVOKES, with `--apply` and WITHOUT `--include-declared`,
 * so an unattended run performs
 * the guessed + repair legs only. The CN2-gated declared leg needs a human to type the flag.
 *
 * SAFE BY DEFAULT: no `--apply` means dry run, exactly like every other backfill here.
 *
 * EXIT CODES — a scheduled job's exit code is the only thing the scheduler records, so the
 * three states are kept distinct (C1: "could not measure" never shares a value with "no"):
 *   0  ran (or was disabled by the master switch, and said so)
 *   1  the run FAILED — the job threw
 *   2  bad arguments (nothing was attempted)
 */

// The flag grammar + usage text live in src/ so the contract test can import them under
// `rootDir: src` (see that module's header — this mirrors orphanBackfill.cli.ts).
import { parseArgs, usage, type CliOptions } from '../src/services/graphBackfill.cli.js';

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    console.log(usage());
    process.exit(2);
    return;
  }
  if (opts.help) {
    console.log(usage());
    process.exit(0);
    return;
  }

  // DB-heavy modules imported here so --help and arg errors need no DB env.
  const { db, initializeDatabase, closeDatabase } = await import('../src/config/database.js');
  const { runGraphBackfill, ORPHAN_COUNT_SQL } = await import('../src/services/graphBackfill.js');
  const { GRAPH_BACKFILL_ENABLED } = await import('../src/config/graphBackfillConfig.js');

  if (!GRAPH_BACKFILL_ENABLED) {
    // Disabled is a legitimate, successful outcome — but it must SAY so, never look like a
    // run that found nothing to do.
    console.log('graph-backfill: DISABLED by MANDREL_GRAPH_BACKFILL_ENABLED — nothing attempted.');
    process.exit(0);
    return;
  }

  await initializeDatabase();
  try {
    const s = await runGraphBackfill(
      {
        apply: opts.apply,
        includeDeclared: opts.includeDeclared,
        repair: opts.repair,
        threshold: opts.threshold,
        maxOrphans: opts.maxOrphans,
        maxRepairs: opts.maxRepairs,
      },
      db
    );

    if (opts.json) {
      console.log(JSON.stringify(s));
    } else {
      const mode = s.dryRun ? 'DRY-RUN (nothing written)' : 'APPLY (live write)';
      console.log('');
      console.log('==============================================================');
      console.log(`  Graph backfill — ${mode}`);
      console.log('==============================================================');
      console.log('  Orphan count query (paste-able):');
      console.log(`    ${ORPHAN_COUNT_SQL.replace(/\s+/g, ' ')}`);
      console.log(`  Orphans before        : ${s.orphansBefore}`);
      console.log(`  Orphans after         : ${s.orphansAfter}${s.dryRun ? ' [projected]' : ''}`);
      console.log(`  Guess threshold       : ${s.guessThreshold}`);
      console.log('--------------------------------------------------------------');
      console.log('  GUESSED leg (-> meter bucket: guessed)');
      console.log(`    processed           : ${s.guessed.orphansProcessed}`);
      console.log(`    left for next run   : ${s.guessed.orphansRemainingUnprocessed}`);
      console.log(`    rescuable           : ${s.guessed.rescuable}`);
      console.log(`    newly minted        : ${s.guessed.minted}`);
      console.log(`    attached to orphan  : ${s.guessed.attachedToUnreachable} (island-building, recorded on the edge)`);
      for (const [k, v] of Object.entries(s.guessed.skips)) {
        console.log(`    skip:${k.padEnd(24)}: ${v}`);
      }
      console.log('--------------------------------------------------------------');
      console.log('  REPAIR leg (created_by NEVER rewritten — no bucket movement)');
      console.log(`    examined            : ${s.repair.examined}`);
      console.log(`    re-labeled          : ${s.repair.relabeled}`);
      console.log(`    re-pointed          : ${s.repair.repointed}`);
      console.log(`    not comparable      : ${s.repair.notComparable}`);
      console.log(`    left for next run   : ${s.repair.remainingUnprocessed}`);
      console.log('--------------------------------------------------------------');
      if (s.declared) {
        console.log('  DECLARED leg (-> meter bucket: declared) [CN2 opt-in was given]');
        console.log(`    tasks considered    : ${s.declared.tasksConsidered}`);
        console.log(`    dependency edges    : ${s.declared.dependencyEdges}`);
        console.log(`    tag edges           : ${s.declared.tagEdges}`);
        console.log(`    trust-bearing       : ${s.declared.trustBearingEdges} (decided_by — SHIFTS trust scores)`);
      } else {
        console.log('  DECLARED leg          : SKIPPED (CN2-gated; pass --include-declared)');
      }
      console.log('--------------------------------------------------------------');
      console.log(`  Duration              : ${s.durationMs} ms`);
      console.log('==============================================================');
      console.log('');
    }
  } finally {
    await closeDatabase();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('graph-backfill FAILED:', e);
      process.exit(1);
    });
}
