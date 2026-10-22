/**
 * SCHEDULED GRAPH BACKFILL — CLI parsing + usage (DB-FREE)  (PHASE 3).
 *
 * WHY THIS IS A SEPARATE MODULE IN src/ RATHER THAN LIVING IN scripts/, which is where it
 * started: the repo's tsconfig sets `rootDir: src`, so a test importing from scripts/ fails
 * to compile with TS6059. That is not an obstacle to work around — it is the reason
 * services/orphanBackfill.cli.ts already exists, and this file follows the same established
 * pattern for the same reason.
 *
 * IT MATTERS HERE SPECIFICALLY because of the CN2 gate. The shipped systemd unit's safety
 * property is "its ExecStart argv does not opt into the declared leg", and the only honest
 * way to assert that is to run the REAL parser over the REAL argv. String-matching the unit
 * file for the absence of a flag would pass just as happily if the parser's grammar changed
 * underneath it. Putting the parser where the contract test can import it is what turns that
 * comment into an executed assertion.
 *
 * DB-FREE on purpose (same as orphanBackfill.cli.ts): `--help` and argument errors must work
 * without DATABASE_NAME, since config/database.ts throws at module load without it.
 */

export interface CliOptions {
  apply: boolean;
  includeDeclared: boolean;
  repair: boolean;
  threshold?: number;
  maxOrphans?: number;
  maxRepairs?: number;
  json: boolean;
  help: boolean;
}

export function usage(): string {
  return `
graph-backfill — the ONE scheduled, idempotent graph backfill (Phase 3)

Connects orphaned records as LABELED GUESSES and makes historical guesses honest. Runs
across every project; takes no project argument by design (a job that needs an operator to
name 103 projects is a command nobody runs, which is the failure this phase exists to fix).

LEGS
  guessed   similarity-derived \`related_to\` for true orphans, stamped
            created_by='backfill:orphan-threads' (-> the meter's GUESSED bucket) with
            provenance/method/similarity recorded ON the edge. Never trust-bearing,
            never auto-promoted.
  repair    pre-existing guessed edges get their measured score written on them, and a
            below-floor edge with a materially better neighbour is re-pointed.
            \`created_by\` is never rewritten, so nothing changes meter bucket.
  declared  OPT-IN ONLY (--include-declared). Derives edges from EXISTING threading tags
            and the explicit task \`dependencies\` field -> the meter's DECLARED bucket.
            Its prod run is CN2-gated: the operator approves it personally. The systemd unit does
            NOT pass this flag.

USAGE
  npx tsx scripts/graph-backfill.ts [--apply] [--include-declared] [--no-repair]
                                    [--threshold <n>] [--max-orphans <n>] [--max-repairs <n>]
                                    [--json]

FLAGS
  --apply              Perform the live write. WITHOUT this the run is a DRY RUN (default).
  --include-declared   Also run the CN2-gated declared leg. Requires a human.
  --no-repair          Skip the repair leg.
  --threshold <n>      Cosine floor in [0,1] for a guessed mint (default: config).
  --max-orphans <n>    Cap orphans processed this run (0 = no cap; default: config).
  --max-repairs <n>    Cap edges the repair leg examines (0 = no cap; default: config).
  --json               Emit the run summary as JSON (what the timer's journal records).
  -h, --help           Show this help.
`;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = {
    apply: false,
    includeDeclared: false,
    repair: true,
    json: false,
    help: false,
  };

  const num = (raw: string | undefined, name: string, min: number, max: number): number => {
    const n = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(n)) {
      throw new Error(`${name} requires a finite number (got "${raw ?? ''}").`);
    }
    if (!(n >= min && n <= max)) throw new Error(`${name} must be in [${min}, ${max}] (got ${n}).`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--include-declared') o.includeDeclared = true;
    else if (a === '--no-repair') o.repair = false;
    else if (a === '--json') o.json = true;
    else if (a === '--threshold') o.threshold = num(argv[++i], '--threshold', 0, 1);
    else if (a.startsWith('--threshold=')) o.threshold = num(a.slice(12), '--threshold', 0, 1);
    else if (a === '--max-orphans') o.maxOrphans = num(argv[++i], '--max-orphans', 0, 1e9);
    else if (a.startsWith('--max-orphans=')) o.maxOrphans = num(a.slice(14), '--max-orphans', 0, 1e9);
    else if (a === '--max-repairs') o.maxRepairs = num(argv[++i], '--max-repairs', 0, 1e9);
    else if (a.startsWith('--max-repairs=')) o.maxRepairs = num(a.slice(14), '--max-repairs', 0, 1e9);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

