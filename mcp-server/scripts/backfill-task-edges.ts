/**
 * CLI for the one-time TASK-EDGE BACKFILL (Q5).
 *
 * Thin wrapper — all logic lives in src/services/taskEdgeBackfill.ts (repo pattern:
 * logic-in-src, thin-executable-in-scripts, so the core is importable by the contract test).
 *
 * USAGE
 *   npx tsx scripts/backfill-task-edges.ts                       # DRY RUN, all projects
 *   npx tsx scripts/backfill-task-edges.ts --project <uuid>      # DRY RUN, one project
 *   npx tsx scripts/backfill-task-edges.ts --limit 50            # DRY RUN, capped
 *   npx tsx scripts/backfill-task-edges.ts --apply               # WRITE (requires --i-mean-it)
 *   npx tsx scripts/backfill-task-edges.ts --undo                # DRY RUN of the undo
 *   npx tsx scripts/backfill-task-edges.ts --undo --apply --i-mean-it   # WRITE the undo
 *
 * SAFETY
 *   * DRY RUN IS THE DEFAULT. The dry run executes the REAL minters inside a transaction and
 *     rolls back, so its numbers are the actual behaviour rather than an estimate.
 *   * --apply additionally requires --i-mean-it. Two flags, because this writes across every
 *     task in the database and the whole point of the gate is that it cannot happen by reflex
 *     or by a stray shell-history recall.
 *   * The undo is one provenance-scoped statement; --undo prints the count first.
 *
 * ⚠️ RUNNING THIS AGAINST PROD IS A HUMAN GATE (the operator's). Backfilled `decided_by` edges enter
 * the TRUST WALK, so trust scores on existing tasks WILL SHIFT — that is the intent, but it is
 * a visible change on live data. Read the dry-run report (it quantifies exactly how many
 * trust-bearing edges are in play) before deciding.
 */

import {
  runTaskEdgeBackfill,
  undoTaskEdgeBackfill,
  formatSummary,
  BACKFILL_CREATED_BY,
} from '../src/services/taskEdgeBackfill.js';
import { db } from '../src/config/database.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const apply = flag('apply');
  const confirmed = flag('i-mean-it');
  const undo = flag('undo');
  const projectId = arg('project');
  const limit = Number(arg('limit') ?? 0) || 0;

  // FAIL CLOSED: --apply without the confirmation flag REFUSES and writes nothing.
  if (apply && !confirmed) {
    console.error(
      '❌ REFUSING to write.\n\n' +
        '   --apply also requires --i-mean-it. This backfill writes edges across EVERY task\n' +
        '   in the database, and backfilled decided_by edges shift trust scores on live data.\n' +
        '   Run without --apply first and read the dry-run report.\n'
    );
    process.exit(2);
  }

  try {
    if (undo) {
      const res = await undoTaskEdgeBackfill({ projectId, apply }, db);
      if (res.dryRun) {
        console.log(
          `🔍 UNDO DRY RUN: ${res.removed} edge(s) carry a backfill provenance stamp ` +
            `(${BACKFILL_CREATED_BY.join(', ')})${projectId ? ` in project ${projectId}` : ''}.\n` +
            '   Re-run with --apply --i-mean-it to remove exactly these.'
        );
      } else {
        console.log(`✅ UNDO APPLIED: removed ${res.removed} backfilled edge(s).`);
      }
      return;
    }

    const summary = await runTaskEdgeBackfill({ apply, projectId, limit }, db);
    console.log(formatSummary(summary));
    if (summary.dryRun) {
      console.log('\n   Re-run with --apply --i-mean-it to write these edges.');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error('❌ backfill failed:', e);
  process.exit(1);
});
