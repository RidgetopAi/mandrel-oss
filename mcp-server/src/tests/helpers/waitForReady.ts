/**
 * Wait until a just-started HealthServer is actually able to SERVE, not merely bound.
 *
 * WHY THIS EXISTS
 * ---------------------------------------
 * `HealthServer.start()` resolves from inside the `listen()` callback, so awaiting it
 * proves only that the socket is accepting connections. It says nothing about whether the
 * server can answer — in particular whether it can reach Postgres. Several integration
 * tests went straight from `await health.start()` to a request that hits the DB.
 *
 * That gap is not theoretical. In the connection-exhaustion incident the host ran out of Postgres client slots, the
 * DCR cap middleware's fail-CLOSED catch turned the resulting SQLSTATE 53300 into an HTTP
 * 503, and the failure surfaced as `expected [200,201] to include 503` on a business
 * assertion about registration caps — pointing at OAuth code that was entirely innocent.
 * A readiness gate turns that class of problem into an explicit, correctly-attributed
 * failure in the setup hook.
 *
 * `/readyz` (healthServer.ts) publishes exactly the signal we need — but read the RIGHT
 * field. Its overall 200/503 also depends on `this.dbHealthy`, a flag flipped by the
 * server BOOTSTRAP via `setDatabaseHealth()`. An integration test that constructs
 * `HealthServer` directly never runs that bootstrap, so the overall status is
 * structurally 503 in this harness and waiting for 200 would hang every time (measured —
 * it did, on the first run of this helper).
 *
 * The field that actually answers "can this server reach Postgres" is `pool.healthy`,
 * from `poolHealthCheck()` → `dbPool.healthCheck()`, which executes a real `SELECT 1` and
 * returns false when that throws. That is precisely what goes false when the host is out
 * of connection slots. So we key on the product's own published field rather than
 * inventing a second notion of readiness that could drift from it.
 *
 * IMPORTANT — this is defence in depth, NOT a fix for connection exhaustion. It makes the
 * failure legible and correctly attributed; it does not create capacity. The actual fix
 * for the connection-exhaustion incident is bounding the suite's connection footprint (DATABASE_POOL_* pins in
 * scripts/lib/gate-env.sh) plus the capacity controls in the CI gate.
 *
 * AND IT IS NOT VERDICT-NEUTRAL — say it plainly, because the surrounding work is. Every
 * control in scripts/lib/gate-db-capacity.sh can only ever refuse to certify (all six of
 * its exit sites are the HARNESS_ERROR code); none of them can turn a failing test into a
 * passing one. THIS HELPER CAN. It polls for up to `timeoutMs` (10 s), so a run that
 * momentarily could not reach Postgres — and recovered inside that window — now proceeds
 * to a PASS where it would previously have failed at the first request. That is the
 * intended behaviour of a readiness gate, and it is still a real change in what the suite
 * reports, so it does not belong under a blanket "nothing here can turn a failing test
 * into a pass."
 *
 * What keeps it from being a SILENT pass is that the absorbed exhaustion is still written
 * to the Postgres server log under this run's own @database tag, and
 * gate_db_capacity_verdict scans that log after the stage whether it passed or failed —
 * so a run that only went green because this helper waited out an exhaustion is still
 * invalidated. The legibility is bought here; the honesty is bought there.
 */

/** Poll `<baseUrl>/readyz` until it reports ready, or throw with the last observed state. */
export async function waitForReady(
  baseUrl: string,
  { timeoutMs = 10_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'no response';
  let lastBody = '';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      lastStatus = String(res.status);
      lastBody = await res.text().catch(() => '');
      // 200 = fully ready. Otherwise accept the DB-reachability signal on its own: a
      // directly-constructed HealthServer never gets setDatabaseHealth(true), so the
      // overall status stays 503 even when Postgres is perfectly reachable.
      if (res.ok) return;
      const body = JSON.parse(lastBody) as { pool?: { healthy?: boolean } };
      if (body?.pool?.healthy === true) return;
    } catch (err) {
      lastStatus = `fetch failed: ${(err as Error).message}`;
      lastBody = '';
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  // Fail LOUD and with the diagnosis attached — the whole point is that the next
  // assertion should never be the thing that reports an infrastructure problem.
  throw new Error(
    `server at ${baseUrl} never became ready within ${timeoutMs}ms ` +
    `(last /readyz: ${lastStatus}${lastBody ? ` ${lastBody.slice(0, 300)}` : ''}). ` +
    `A not_ready /readyz usually means the DB pool is unhealthy — e.g. the host is out ` +
    `of Postgres connection slots (SQLSTATE 53300) — not that the code under test is broken.`,
  );
}
