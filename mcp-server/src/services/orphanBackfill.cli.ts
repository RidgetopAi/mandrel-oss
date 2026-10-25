/**
 * ONE-TIME ORPHAN BACKFILL — CLI parsing + usage (DB-FREE)
 * (branch:mandrel-reliability, task ST-6, spec §C1/C2/C3, §X4).
 *
 * WHY A SEPARATE, DB-FREE MODULE: the DB logic (orphanBackfill.ts) transitively imports
 * config/database.ts, which THROWS at module load if DATABASE_NAME is unset. Arg parsing and
 * `--help` must work WITHOUT a DB env (an operator asking for help shouldn't need creds). So
 * the pure CLI surface lives here — it imports only the (db-free) reliableThreadingConfig for
 * the default threshold — and the script loads the DB-heavy module dynamically, AFTER the
 * help/parse check. Single source for the flag grammar; the contract test asserts it directly.
 */

import { INFERENCE_THRESHOLD } from '../config/reliableThreadingConfig.js';

export interface BackfillCliOptions {
  /** Project name or id to scope the backfill to (required). */
  project: string;
  /** True = evaluate + project only, write nothing (the safe default). False = live write. */
  dryRun: boolean;
  /** The inference floor for this run (defaults to INFERENCE_THRESHOLD). */
  threshold: number;
  /** True when --help/-h was requested. */
  help: boolean;
}

/**
 * Parse argv into {@link BackfillCliOptions}. Throws a clear Error on a bad/missing/contradictory
 * flag so the CLI can print it + usage and exit non-zero. Safe default: dryRun=true unless --apply.
 */
export function parseArgs(argv: string[]): BackfillCliOptions {
  let project: string | undefined;
  let dryRunFlag = false;
  let applyFlag = false;
  let threshold: number | undefined;
  let help = false;

  const parseThreshold = (raw: string | undefined): number => {
    const n = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(n)) {
      throw new Error(`--threshold requires a finite number (got "${raw ?? ''}").`);
    }
    if (!(n >= 0 && n <= 1)) {
      throw new Error(`--threshold must be a cosine in [0, 1] (got ${n}).`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--dry-run':
        dryRunFlag = true;
        break;
      case '--apply':
        applyFlag = true;
        break;
      case '--project':
        project = argv[++i];
        break;
      case '--threshold':
        threshold = parseThreshold(argv[++i]);
        break;
      default:
        // Support --project=foo / --threshold=0.6 form too.
        if (arg.startsWith('--project=')) {
          project = arg.slice('--project='.length);
        } else if (arg.startsWith('--threshold=')) {
          threshold = parseThreshold(arg.slice('--threshold='.length));
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  if (help) {
    // Return early with placeholders; the CLI prints usage and exits before touching the DB.
    return {
      project: project ?? '',
      dryRun: true,
      threshold: threshold ?? INFERENCE_THRESHOLD,
      help: true,
    };
  }

  if (dryRunFlag && applyFlag) {
    throw new Error('--dry-run and --apply are mutually exclusive — pick one.');
  }
  if (!project) {
    throw new Error('--project <name|id> is required.');
  }

  return {
    project,
    // Safe default: unless --apply is given explicitly, this is a projection (writes nothing).
    dryRun: !applyFlag,
    threshold: threshold ?? INFERENCE_THRESHOLD,
    help: false,
  };
}

/** The --help / usage text (also printed on a parse error). */
export function usageText(): string {
  return `
backfill-orphan-threads — one-time orphan repair (reliable-auto-threading ST-6)

Applies write-time inference (Component B) to every existing ORPHAN context in ONE
project, minting a weak \`related_to\` edge to each orphan's nearest reachable neighbor
at/above the threshold. Reuses the SAME inference helper the live write path uses.

USAGE
  npx tsx scripts/backfill-orphan-threads.ts --project <name|id> [--dry-run | --apply] [--threshold <n>]

FLAGS
  --project <name|id>   REQUIRED. The project to scope the backfill to (exact name or id).
  --dry-run             Evaluate + project the rescue, write NOTHING. This is the DEFAULT
                        when neither --dry-run nor --apply is given (safe by default).
  --apply               EXPLICITLY perform the live write (mint related_to edges).
  --threshold <n>       Cosine floor in [0, 1] to clear for a rescue. Defaults to the
                        configured INFERENCE_THRESHOLD (currently ${INFERENCE_THRESHOLD}).
  -h, --help            Show this help.

SAFETY
  Dry-run is the default; a live write requires --apply. Idempotent (re-running mints
  nothing new). Scoped to one project. Do NOT run against the prod/riverbend DB from a
  dev build — that real-corpus run is gated by a human after review.

EXAMPLES
  # Project the rescue on a project (writes nothing):
  npx tsx scripts/backfill-orphan-threads.ts --project riverbend --dry-run

  # Perform the live backfill at a lower floor:
  npx tsx scripts/backfill-orphan-threads.ts --project riverbend --apply --threshold 0.55
`.trim();
}
