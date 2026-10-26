/**
 * SURVIVAL, NOT WRAPPING — the guard for an earlier task.
 *
 * THE INCIDENT THIS EXISTS TO KEEP FIXED. 2026-08-12 10:14:50Z: an unattended host upgrade
 * restarted `postgresql@16-main`; Postgres closed its connections with SQLSTATE 57P01; prod
 * Mandrel logged `❌ Uncaught Exception` and called `process.exit(1)`. The stack had ZERO
 * product frames (pg-protocol → Socket → TCP.onStreamRead) because nothing in the product was
 * on the stack: an IDLE pooled client's socket error is re-emitted ON THE POOL by `pg`, and a
 * Pool with no `'error'` listener rethrows it as an uncaughtException.
 *
 * WHY THE EXISTING GUARD DID NOT CATCH IT, which is the reason this file is separate from it.
 * `datastoreErrorBoundary.contract.test.ts` §4 asserts that every production `new Pool(` is
 * WRAPPED in `guardPool(`. That was true throughout the incident. Wrapping is a property of the
 * source text; survival is a property of a running process. A guard can only ever assert the
 * property it actually exercises (CLASSES.md C3), so this one exercises the property that
 * matters: kill the connections underneath a real pool and assert THE PROCESS IS STILL ALIVE
 * and still serving.
 *
 * THE ORACLE IS AN EXIT CODE, deliberately. Inside the vitest worker an uncaughtException is
 * intercepted by the runner and reported as a failed test — the wrong instrument entirely, since
 * the failure being guarded is process death. So each leg is a real child process
 * (`fixtures/poolBounceChild.ts`) that builds its pool through the PRODUCTION path (the exported
 * `db` from `src/config/database.ts`) and installs the PRODUCTION fatal handler (the real
 * `processLock.acquire()`), and the assertion is on its exit code.
 *
 * THE THREE ASSERTIONS (CLASSES.md C3) are carried by the tests below: the control leg is GREEN, the
 * mutation LANDED (listener count 1 → 0, printed by the child before the fault), and the mutated
 * leg is RED. The mutation removes exactly what `guardPool()` installs, i.e. it reconstructs the
 * pre-fix code at runtime; the same fixture was also run against the pre-fix SOURCE and exited 1.
 *
 * WHAT THIS DOES NOT COVER, named rather than implied: the fixture terminates backends with
 * `pg_terminate_backend` while the server stays up, so it exercises the idle-client error path
 * and the pool's re-establishment, NOT reconnect while Postgres is genuinely down for seconds.
 * The crash under test happened at the first instant of the bounce, not at reconnect.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { Client } from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.resolve(HERE, '../../node_modules/.bin/tsx');
const CHILD = path.join(HERE, 'fixtures', 'poolBounceChild.ts');
const REPO = path.resolve(HERE, '../../..');
const PROVISION = path.join(REPO, 'scripts', 'provision-test-db.sh');

/**
 * Scratch dir for the child's lock file and app logs — never the tree's own logs/.
 * REMOVED in afterAll: one dir per run, never cleaned, is how a tmpfs fills — and a full
 * /tmp has already made a deploy gate misreport once (CLASSES.md C5, systems fill).
 */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'poolbounce-'));

/**
 * THE BOUNCE DATABASE — why the child no longer bounces the suite's own DB.
 *
 * `pg_terminate_backend` writes a real `FATAL: terminating connection due to administrator
 * command` into the Postgres server log. The gate's DB capacity check reads that log
 * scoped to the run's database and invalidates the whole gate run on any unrecognised FATAL —
 * by SEVERITY, deliberately, because that is also the signature of the connection-slot
 * exhaustion and of the `postgresql@16-main` restart that killed prod on 2026-08-12. Both
 * behaviours are correct; they are incompatible in one database. So the noise leaves the
 * invalidator's population instead of the invalidator learning to ignore a wording it must
 * keep catching.
 *
 * DERIVED, NEVER HARDCODED (CLASSES.md C4): the name is the suite's own `DATABASE_NAME` plus a
 * suffix, and it is provisioned by `scripts/provision-test-db.sh` — the SAME helper
 * `the CI gate` calls for the run DB, so role + extensions + `migrate.ts` are one code path,
 * not two. `the CI gate`'s cleanup drops this derived name too, so a crashed run cannot leak
 * it. The tests below assert, executably, that the child ran against THIS database and that its
 * applied-migration fingerprint equals the suite DB's.
 */
const SUITE_DB = process.env.DATABASE_NAME;
const BOUNCE_DB_SUFFIX = '_pb';
const BOUNCE_DB = `${SUITE_DB ?? ''}${BOUNCE_DB_SUFFIX}`;
/** Filled by beforeAll from the provisioner's own `export DATABASE_*` output. */
let bounceEnv: Record<string, string> = {};
let suiteMigrationFingerprint: string | null = null;

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...bounceEnv,
    PGAPPNAME: 'mandrel-pool-bounce-fixture',
    AIDIS_LOCK_FILE: path.join(SCRATCH, 'aidis.pid'),
    AIDIS_LOG_DIR: path.join(SCRATCH, 'logs'),
  };
}

/**
 * `md5` over every applied migration's FILENAME — see the child for why not a count.
 *
 * The SQL selects `filename || ':' || coalesce(checksum, '')`, but nothing ever WRITES
 * `checksum`: `scripts/migrate.ts` declares the column (:73) and inserts only the filename,
 * so the coalesce always yields '' and this fingerprint is filename-only in practice.
 * That is sufficient for what this test asks of it — telling one migration SET from another —
 * but it CANNOT detect the same filenames carrying different content. Do not cite it as a
 * content check.
 */
const MIGRATION_FINGERPRINT_SQL = `
  SELECT md5(string_agg(filename || ':' || coalesce(checksum, ''), ','
             ORDER BY migration_number, filename)) AS fp
    FROM _aidis_migrations`;

async function migrationFingerprint(env: NodeJS.ProcessEnv): Promise<string | null> {
  const client = new Client({
    host: env.DATABASE_HOST,
    port: parseInt(env.DATABASE_PORT ?? '5432', 10),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    application_name: 'mandrel-pool-bounce-parent',
  });
  await client.connect();
  try {
    const r = await client.query<{ fp: string | null }>(MIGRATION_FINGERPRINT_SQL);
    return r.rows[0]?.fp ?? null;
  } finally {
    await client.end();
  }
}

/** Run the provisioner. Returns the `DATABASE_*` it printed — the creds that authenticate. */
function provisionBounceDb(): Record<string, string> {
  const r = spawnSync('bash', [PROVISION, BOUNCE_DB], {
    env: {
      ...process.env,
      TEST_DB_HOST: process.env.DATABASE_HOST ?? 'localhost',
      TEST_DB_PORT: process.env.DATABASE_PORT ?? '5432',
      AIDIS_LOG_DIR: path.join(SCRATCH, 'logs'),
      LOG_DIR: path.join(SCRATCH, 'logs'),
    },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `provision-test-db.sh failed for '${BOUNCE_DB}' (rc=${r.status}).\n${r.stdout}\n${r.stderr}`,
    );
  }
  const env: Record<string, string> = {};
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^export (DATABASE_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

interface Leg {
  code: number | null;
  stdout: string;
  stderr: string;
  result?: Record<string, unknown>;
  mutation?: Record<string, unknown>;
}

function runLeg(args: string[]): Promise<Leg> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [CHILD, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      const pick = (marker: string): Record<string, unknown> | undefined => {
        const line = (stdout + stderr).split('\n').find((l) => l.startsWith(marker));
        return line ? (JSON.parse(line.slice(marker.length).trim()) as Record<string, unknown>) : undefined;
      };
      resolve({ code, stdout, stderr, result: pick('#RESULT#'), mutation: pick('#MUTATION#') });
    });
  });
}

// Spawning tsx + connecting + a 750ms settle, twice. Well above the 10s file default.
const LEG_TIMEOUT_MS = 90_000;

describe('a real datastore bounce must not kill the process', () => {
  let control: Leg;
  let mutated: Leg;

  beforeAll(async () => {
    // Fail LOUD, not silently against whatever DB happens to be default: this file spawns a
    // provisioner and terminates backends, and both need to know exactly which DB that is.
    if (!SUITE_DB) {
      throw new Error(
        'DATABASE_NAME is not set. This contract provisions a disposable bounce DB derived ' +
          'from it (see scripts/provision-test-db.sh --print-env for the local workflow).',
      );
    }
    bounceEnv = provisionBounceDb();
    suiteMigrationFingerprint = await migrationFingerprint(process.env);
    control = await runLeg([]);
    mutated = await runLeg(['--remove-pool-error-handler']);
  }, LEG_TIMEOUT_MS * 2);

  test('ISOLATED — the bounce lands in its own migrated DB, not the suite\'s', () => {
    // (1) the fault really happened somewhere else than the run DB the gate scans...
    expect(control.result!.databaseName).toBe(BOUNCE_DB);
    expect(control.result!.databaseName).not.toBe(SUITE_DB);
    // (2) ...and "somewhere else" is not an unlike-production DB: same applied migrations,
    // because it went through the same provision -> extensions -> migrate.ts helper.
    expect(suiteMigrationFingerprint).toBeTruthy();
    expect(control.result!.migrationFingerprint).toBe(suiteMigrationFingerprint);
  });

  test('CONTROL — production pool survives a real 57P01 and keeps serving', () => {
    expect(control.result, `child produced no #RESULT#:\n${control.stdout}\n${control.stderr}`).toBeDefined();
    // 1. the process did not die
    expect(control.code).toBe(0);
    // 2. the fault was REAL and reached the pool: a backend was actually terminated
    expect(control.result!.backendsTerminated).toBeGreaterThan(0);
    expect(control.result!.idleBefore).toBeGreaterThan(0); // it was an IDLE client, the incident's population
    // 3. the pool is still usable afterwards — self-heal, not just "did not crash"
    expect(control.result!.servedAfterBounce).toBe(1);
    expect(control.result!.totalAfter).toBeGreaterThan(0);
  });

  test('CONTROL — the swallow is LOUD: error-level log with the SQLSTATE, and a counter', () => {
    // A silent catch would pass the survival test above. These two assertions are what make
    // "survived" different from "swallowed" — the tradeoff the fix is required to respect.
    const out = control.stdout + control.stderr;
    expect(out).toMatch(/ERROR .*DATABASE::pool_error/);
    expect(out).toContain('57P01');
    expect(out).toMatch(/terminating connection due to administrator command/);
    expect(control.result!.poolErrorCounter).toBeGreaterThan(0);
  });

  test('MUTATION LANDED — the fix\'s listener is present at birth and removed by the probe', () => {
    expect(control.mutation).toEqual({
      mutated: false,
      errorListenersAtBirth: 1,
      errorListenersAfterMutation: 1,
    });
    expect(mutated.mutation).toEqual({
      mutated: true,
      errorListenersAtBirth: 1,
      errorListenersAfterMutation: 0,
    });
  });

  test('PROBE GOES RED — with the listener removed, the same bounce kills the process', () => {
    expect(mutated.code).not.toBe(0);
    expect(mutated.result, 'the mutated leg must never reach #RESULT#').toBeUndefined();
    // NOT reducible to the exit code: with no DB reachable the child also exits non-zero
    // (failed connect), so `code !== 0` passes spuriously. This regex is what distinguishes
    // "died the way we predicted" from "died on the way to the experiment". Load-bearing.
    expect(mutated.stdout + mutated.stderr).toMatch(/Uncaught Exception/);
  });

  afterAll(() => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    // Drop the bounce DB + its role. the CI gate's cleanup drops the same derived name on every
    // exit path, so this is the fast path, not the only one (CLASSES.md C5 — systems fill).
    if (SUITE_DB) {
      spawnSync('bash', [PROVISION, BOUNCE_DB, '--drop'], { encoding: 'utf8' });
    }
  });
});
