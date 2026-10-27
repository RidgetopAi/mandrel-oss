/**
 * idlePoolReleasesEventLoop.db.test.ts
 *
 * THE PROPERTY: once the backend's product code has finished its work, a Node process
 * that imported it must be able to EXIT ON ITS OWN. No idle pool and no background
 * timer is allowed to be the reason a process stays alive.
 *
 * WHY THIS EXISTS — MEASURED, on ref 7979f00 (batch1/merge-candidate).
 *   `the CI gate` STAGE 4 runs `npx jest --runInBand --ci --passWithNoTests`, with no
 *   `--forceExit`. The suite reported `Tests: 18 skipped, 1524 passed, 1542 total` and
 *   then printed "Jest did not exit one second after the test run has completed." and
 *   never exited: 8h36m on one run, killed at 45 min on the next — both times holding
 *   the authoritative gate's lock and producing NO VERDICT.
 *
 *   Signal trace (a probe that dumped handles on SIGUSR2 and on an UNREF'd timer, so it
 *   could not itself hold the loop open): in the steady state after the suite finished,
 *   `process.getActiveResourcesInfo()` returned exactly ONE entry — `["TCPSocketWrap"]`
 *   — and that socket's captured creation stack was
 *   `BackendPoolManager.initialize -> getConnection -> query -> healthCheck`, reached
 *   from `src/routes/health.ts`. In the SAME dump all 63 live intervals reported
 *   `hasRef=false`. So no timer was holding the loop; one idle pg client was.
 *
 *   MECHANISM: pg-pool arms its idleTimeoutMillis reaper only while `_isAboveMin()`
 *   (pg-pool/index.js:116 and :371) and poolManager sets `min: 3`, so the last clients
 *   are never above min, get no reaper, and idle FOREVER while ref'd.
 *   `allowExitOnIdle: true` makes pg-pool `client.unref()` an idle client
 *   (pg-pool/index.js:386) and `client.ref()` it again on re-acquire (:153): an
 *   in-flight query still holds the loop, the connection is not closed, and a
 *   long-running server is unaffected because its loop is held by app.listen.
 *
 * WHY A CHILD PROCESS AND NOT AN ASSERTION ABOUT CONFIG.
 *   "Does this release the event loop" is a property of the RUNNING process, and the
 *   layer that answers it is the process's own exit. Asserting the config object would
 *   be a rung too high: it would stay green if a pg upgrade changed what
 *   `allowExitOnIdle` does, and it cannot see a second holder. The child exits or it
 *   does not; `spawnSync`'s `status`/`signal` is structured, not prose.
 *
 * WHY `--detectOpenHandles` IS NOT THE ORACLE ANYWHERE HERE.
 *   MEASURED on the same ref: the identical suite run WITH `--detectOpenHandles` exits
 *   cleanly and reports NO open handles. The flag alters teardown and SUPPRESSES the
 *   defect it is sold as diagnosing. The oracle is the gate's own invocation.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { describeDb } from './helpers/dbContractGate';

/** Root of the backend package (this file is src/__tests__/*.test.ts). */
const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(BACKEND_DIR, 'src');

/**
 * Budget for the child.
 *
 * MEASURED, and the number is chosen against a measurement rather than a feeling:
 *   - passing case: 0.5–0.6 s (ts-node transpile-only start + one SELECT)
 *   - poolManager without the fix: NEVER exits (killed at 45 s, then at 25 s)
 *   - connection.ts's `db` without the fix: exits at 30.5 s — it sets no `min`, so its
 *     idleTimeoutMillis reaper eventually closes the socket.
 *
 * That middle case is why the budget is 10 s and not 45 s. At 45 s this suite GREENED
 * with connection.ts's fix reverted (measured: 30541 ms, PASS) — a guard that cannot
 * tell fixed from broken for one member of its population. 10 s separates 0.6 s from
 * 30.5 s with ~16x headroom on the passing case.
 */
const CHILD_TIMEOUT_MS = 10_000;

/**
 * THE POPULATION: every entry point by which a short-lived process can pick up one of
 * this package's long-lived handles. Each case runs the real product path in a child
 * and requires the child to exit on its own.
 *
 * `witness` is asserted BEFORE the exit assertion, so a child that exited because its
 * import threw can never read as a pass — and so a mutation probe against this suite is
 * measuring the mutated code having RUN, not merely having been edited.
 */
const CASES = [
  {
    label: 'backendPool query — src/database/poolManager.ts',
    witness: 'QUERY_OK:[{"ok":1}]',
    code:
      "const { backendPool } = require('./src/database/poolManager');" +
      "backendPool.query('SELECT 1 AS ok')" +
      ".then(rows => { process.stdout.write('QUERY_OK:' + JSON.stringify(rows) + '\\n'); })" +
      ".catch(e => { process.stdout.write('ERR:' + e.message + '\\n'); process.exitCode = 3; });",
  },
  {
    label: 'db query — src/database/connection.ts',
    witness: 'QUERY_OK:[{"ok":1}]',
    code:
      "const { db } = require('./src/database/connection');" +
      "db.query('SELECT 1 AS ok')" +
      ".then(r => { process.stdout.write('QUERY_OK:' + JSON.stringify(r.rows) + '\\n'); })" +
      ".catch(e => { process.stdout.write('ERR:' + e.message + '\\n'); process.exitCode = 3; });",
  },
  {
    // initializeDatabase() also arms the 60s pool-stats interval — a second handle in
    // the same file, which is why this case exists next to the plain `db` query above.
    label: 'initializeDatabase() — src/database/connection.ts (pool-stats interval)',
    witness: 'INIT_OK',
    code:
      "const { initializeDatabase } = require('./src/database/connection');" +
      "initializeDatabase()" +
      ".then(() => { process.stdout.write('INIT_OK\\n'); })" +
      ".catch(e => { process.stdout.write('ERR:' + e.message + '\\n'); process.exitCode = 3; });",
  },
  {
    // server.ts calls this at module scope, so it is on the import path of anything
    // that loads the app.
    label: 'ensureFeatureFlags() — src/utils/featureFlags.ts (5s refresh poller)',
    witness: 'FLAGS_OK',
    code:
      "const { ensureFeatureFlags } = require('./src/utils/featureFlags');" +
      "ensureFeatureFlags()" +
      ".then(() => { process.stdout.write('FLAGS_OK\\n'); })" +
      ".catch(e => { process.stdout.write('ERR:' + e.message + '\\n'); process.exitCode = 3; });",
  },
];

/**
 * The declared inventory of loop-holding constructs in PRODUCT code, each with the
 * disposition that makes it safe. This is a set-equality against a scan of disk, not a
 * parse of the call: it cannot fail open on a shape it does not understand, because an
 * unknown file is an EXTRA member and set-equality reports extras.
 *
 * A new `new Pool(` or `setInterval(` in product code turns this RED until its author
 * states the disposition here — and, for anything a short-lived process can reach, adds
 * a case to CASES above.
 */
const DECLARED_POOL_FILES = [
  'src/database/connection.ts', // allowExitOnIdle: true
  'src/database/poolManager.ts', // allowExitOnIdle: true
];
const DECLARED_INTERVAL_FILES = [
  'src/database/connection.ts', // pool-stats logger, .unref()'d
  'src/database/poolManager.ts', // pool monitoring, .unref()'d
  'src/services/monitoring.ts', // service monitoring, .unref()'d
  'src/utils/featureFlags.ts', // flag refresh poller, .unref()'d
  'src/services/sse.ts', // PER-CONNECTION heartbeat: created when a client connects
  //                        and clearInterval'd when the response ends. Not module
  //                        scope and not a singleton, so it lives and dies with a
  //                        request the server is already holding the loop open for.
];

/** Every `.ts` under src/ excluding the test tree — the scan population, stated here. */
function productTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      productTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function productFilesMatching(re: RegExp): string[] {
  return productTsFiles(SRC_DIR)
    // `re.exec(...) !== null` rather than `re.test(...)`: dbTestGateCoverage.test.ts
    // flags any reference to the identifier `test` outside a gate call, and a RegExp
    // method named `test` reads the same to it. Measured — it went RED on this line.
    .filter((f) => re.exec(fs.readFileSync(f, 'utf-8')) !== null)
    .map((f) => path.relative(BACKEND_DIR, f))
    .sort();
}

describeDb('short-lived processes must be able to exit (the CI gate STAGE 4 has no --forceExit)', () => {
  it('every product file that creates a pg Pool is declared', () => {
    expect(productFilesMatching(/new\s+Pool\s*\(/)).toEqual([...DECLARED_POOL_FILES].sort());
  });

  it('every product file that starts an interval is declared', () => {
    expect(productFilesMatching(/setInterval\s*\(/)).toEqual([...DECLARED_INTERVAL_FILES].sort());
  });

  for (const c of CASES) {
    it(
      `${c.label}: the process exits on its own`,
      () => {
        const child = spawnSync(
          process.execPath,
          ['-r', 'ts-node/register/transpile-only', '-e', c.code],
          {
            cwd: BACKEND_DIR,
            encoding: 'utf-8',
            timeout: CHILD_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
          },
        );

        // WITNESS FIRST: prove the product path actually RAN in the child.
        expect(`${child.stdout}${child.stderr}`).toContain(c.witness);

        // THEN the property. `signal: 'SIGKILL'` is spawnSync's honest reading of "we
        // had to kill it at the budget" — the hang — as distinct from a non-zero status,
        // which would be the child failing for its own reasons.
        expect({ signal: child.signal, status: child.status }).toEqual({ signal: null, status: 0 });
      },
      CHILD_TIMEOUT_MS + 20_000,
    );
  }
});
