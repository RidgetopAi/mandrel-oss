/**
 * CHILD FIXTURE for `poolSurvivesDatastoreBounce.contract.test.ts`.
 *
 * WHY A CHILD PROCESS AT ALL. The property under test is "the PROCESS stays up". That is not
 * observable from inside the test runner: an `uncaughtException` in the vitest worker is
 * caught by vitest's own handler and reported as a failed test, which is exactly the wrong
 * oracle — the incident was `process.exit(1)`, not a rejected promise. So the survival check
 * has to be an EXIT CODE of a process that (a) built its pool the way production does and
 * (b) carries production's `uncaughtException` handler.
 *
 * PRODUCTION INVOCATION PATH, not a stand-in (CLASSES.md C4 — "a gate went green only because
 * it ran in /tmp"):
 *   - the pool is the exported `db` from `src/config/database.ts` — the same object every MCP
 *     tool reaches, constructed by the same `guardPool(new Pool(dbConfig))` line;
 *   - the fatal handler is the REAL `processLock.acquire()` (utils/processLock.ts), whose
 *     `uncaughtException` branch is the `logger.error(); this.release(); process.exit(1)` that
 *     killed prod at 10:14:50Z on 2026-08-12. `AIDIS_LOCK_FILE` points it at a scratch path so
 *     this fixture can never contend with a real instance's lock;
 *   - the fault is a REAL Postgres `57P01` — `pg_terminate_backend` issued from a separate
 *     control connection, which is the same SQLSTATE and the same "server closed the socket of
 *     an IDLE pooled client" mechanism the `postgresql@16-main` restart produced.
 *
 * WHERE THE BOUNCE LANDS. The parent points this process's `DATABASE_*` at a
 * DISPOSABLE database of its own, provisioned through `scripts/provision-test-db.sh` — the same
 * helper `the CI gate` uses. The terminations below are real SQLSTATE 57P01 FATALs written to
 * the Postgres server log, and the clean gate's invalidator treats an unrecognised FATAL in THE
 * RUN'S database as "I could not measure this run". Killing our own backends inside the suite's
 * database therefore made the gate unable to certify anything. Isolating the blast radius keeps
 * the fault real and takes it out of the invalidator's population, rather than teaching the
 * invalidator to ignore the one wording a real Postgres restart also emits.
 *
 * WHAT THIS DOES NOT REPRODUCE, stated plainly: the server going AWAY for a period. A real
 * `systemctl restart postgresql` also makes the next `connect()` fail for a second or two.
 * This fixture kills the backends while the server stays up, so it exercises the idle-client
 * error path and the pool's re-establishment, not reconnect-under-outage. The crash being
 * fixed happened at the first instant of the bounce (the socket error), not at reconnect, so
 * this is the path that mattered — but the untested remainder is real and is named here rather
 * than papered over.
 *
 * ARGV:
 *   --remove-pool-error-handler   MUTATION LEG. Strips the listener `guardPool()` installed,
 *                                 i.e. puts the pool back in its pre-fix state. Prints the
 *                                 listener count before and after so the mutation is shown to
 *                                 have LANDED rather than assumed (CLASSES.md C3, assertion 1).
 *
 * OUTPUT: one `#RESULT# {json}` line on stdout. Anything else on stdout/stderr is the app's
 * own logging, which the parent asserts on for the "it stayed LOUD" half of the contract.
 */

import { Client } from 'pg';

// The application_name every pooled connection of THIS process carries, so the control
// connection can terminate exactly our backends and nothing else on a shared Postgres.
// Set by the parent via PGAPPNAME before `pg` reads it.
const POOL_APPNAME = process.env.PGAPPNAME ?? 'mandrel-pool-bounce-fixture';
const CONTROL_APPNAME = 'mandrel-pool-bounce-control';

const MUTATE = process.argv.includes('--remove-pool-error-handler');

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`#RESULT# ${JSON.stringify(result)}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // Production's fatal-error handler. Registering it BEFORE the fault is what makes this an
  // honest reproduction of the incident rather than a test of node's default behaviour.
  const { processLock } = await import('../../utils/processLock.js');
  processLock.acquire();

  const { db } = await import('../../config/database.js');
  const { monitoring } = await import('../../utils/monitoring.js');

  const errorListenersAtBirth = db.listenerCount('error');
  if (MUTATE) db.removeAllListeners('error');
  const errorListenersAfterMutation = db.listenerCount('error');
  // Printed BEFORE the fault, because in the mutated leg the process is expected to die and
  // never reach `#RESULT#`. Without this line the RED leg would prove the process crashed but
  // not that the MUTATION is what removed the protection (CLASSES.md C3, assertion 1).
  process.stdout.write(
    `#MUTATION# ${JSON.stringify({ mutated: MUTATE, errorListenersAtBirth, errorListenersAfterMutation })}\n`,
  );

  // Open a connection and let it go back to the pool: an IDLE pooled client is the population
  // the incident hit (pg-pool/index.js `makeIdleListener` re-emits its socket error ON THE POOL).
  await db.query('SELECT 1');
  const idleBefore = db.idleCount;
  const totalBefore = db.totalCount;

  // The bounce. A separate, differently-named connection so it does not terminate itself.
  const control = new Client({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    application_name: CONTROL_APPNAME,
  });
  await control.connect();
  const killed = await control.query(
    `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
    [POOL_APPNAME],
  );
  await control.end();

  // Let the socket error reach the event loop. In the mutated leg the process is expected to
  // be gone before this resolves.
  await sleep(750);

  // Served-after-bounce, plus the two facts the parent needs to prove this process ran
  // against the ISOLATED bounce database and that that database was built by the SAME
  // migration path as the suite's own. Both are read THROUGH the
  // production pool, after the bounce, so they also witness that it re-established.
  //   - current_database(): which DB the production `db` actually connected to.
  //   - the migration fingerprint: the FILENAME of every applied migration, ordered.
  //     (the SQL coalesces a `checksum` column that migrate.ts declares but never writes,
  //      so this distinguishes migration SETS, not migration CONTENT)
  //     Migrations are appended only by migrate.ts, so this value does not move while a
  //     suite runs (a table COUNT does — any test creating a table would shift it).
  const stillServing = await db.query(
    `SELECT 1 AS ok,
            current_database() AS db,
            (SELECT md5(string_agg(filename || ':' || coalesce(checksum, ''), ','
                                   ORDER BY migration_number, filename))
               FROM _aidis_migrations) AS migration_fingerprint`,
  );
  const poolErrorCounter =
    monitoring.getLatestMetric('datastore_pool_errors_total')?.value ?? 0;

  emit({
    survived: true,
    databaseName: (stillServing.rows[0] as { db: string }).db,
    migrationFingerprint: (stillServing.rows[0] as { migration_fingerprint: string | null })
      .migration_fingerprint,
    errorListenersAtBirth,
    errorListenersAfterMutation,
    backendsTerminated: killed.rowCount ?? 0,
    idleBefore,
    totalBefore,
    // Self-heal evidence: the errored client was removed by pg-pool and the pool opened a
    // fresh one to answer the query above.
    totalAfter: db.totalCount,
    servedAfterBounce: (stillServing.rows[0] as { ok: number }).ok,
    // The "it stayed LOUD" half: a swallowed error would still print `survived: true`.
    poolErrorCounter,
  });

  await db.end();
  process.exit(0);
}

void main();
