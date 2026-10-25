/**
 * CONNECTION-FOOTPRINT CONTRACT
 *
 * WHY THIS EXISTS
 * ---------------
 * Postgres client slots (max_connections minus superuser_reserved_connections) are a
 * BOX-WIDE shared resource. This suite runs all ~170 files in ONE process (vitest
 * `singleFork`); each file re-evaluates config/database.ts, creating a new `Pool` that is
 * never `end()`ed, and each abandoned pool squats on its connections for
 * `idleTimeoutMillis`. Measured peak concurrent client backends on an unmodified suite:
 * 80, against 97 usable slots — 82% of the entire host's capacity. At that level the
 * suite periodically EXHAUSTED the server and an unlucky query got SQLSTATE 53300, which
 * the DCR cap middleware's fail-CLOSED catch turned into an HTTP 503 and a false RED on
 * an innocent business assertion.
 *
 * The fix bounds the footprint from CI via DATABASE_POOL_* (scripts/lib/gate-env.sh
 * GATE_ENV_STAGE1_PINS). Measured peak with the pins applied: 21.
 *
 * WHAT THIS TEST GUARDS
 * ---------------------
 * That the pins are not INERT. A shell guard can only grep for `process.env.DATABASE_POOL_MAX`
 * in the source; that text would still be present if someone reintroduced a literal
 * elsewhere, or if the value stopped reaching the Pool. This test asserts the pg `Pool`
 * the product actually constructs — the choke point every pooled connection passes
 * through — so re-hardcoding the footprint is a RED, not a silent regression back to 80
 * slots and an unexplainable gate.
 *
 * It also pins the DEFAULTS, because the defaults are what PROD runs: the connection-exhaustion incident change
 * must not alter production pool behaviour, only make it boundable.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

/** Load a fresh copy of config/database.ts under the given env and report the Pool's options. */
async function poolOptionsUnder(env: Record<string, string | undefined>): Promise<{
  max: number; idleTimeoutMillis: number; connectionTimeoutMillis: number;
}> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    // stubEnv(key, undefined) DELETES the var — that is how we exercise the default path
    // even when the surrounding CI run pins a value.
    vi.stubEnv(key, value as string);
  }
  const { db } = await import('../config/database.js');
  const opts = (db as unknown as { options: Record<string, number> }).options;
  return {
    max: opts.max,
    idleTimeoutMillis: opts.idleTimeoutMillis,
    connectionTimeoutMillis: opts.connectionTimeoutMillis,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('DB pool footprint is env-bounded', () => {
  it('honours DATABASE_POOL_* — the CI pins are not inert', async () => {
    // Deliberately NOT the values CI pins, and not the defaults: if this test read the
    // same constant the gate pins, it would widen in lockstep with the thing it guards
    // (a past incident rule 7). Distinct literals prove the env actually drives the Pool.
    const opts = await poolOptionsUnder({
      DATABASE_POOL_MAX: '7',
      DATABASE_POOL_IDLE_TIMEOUT_MS: '1234',
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: '567',
    });
    expect(opts.max, 'DATABASE_POOL_MAX must reach the pg Pool').toBe(7);
    expect(opts.idleTimeoutMillis, 'DATABASE_POOL_IDLE_TIMEOUT_MS must reach the pg Pool').toBe(1234);
    expect(opts.connectionTimeoutMillis, 'DATABASE_POOL_CONNECTION_TIMEOUT_MS must reach the pg Pool').toBe(567);
  });

  it('defaults are unchanged, so PROD pool behaviour is byte-identical to earlier', async () => {
    const opts = await poolOptionsUnder({
      DATABASE_POOL_MAX: undefined,
      DATABASE_POOL_IDLE_TIMEOUT_MS: undefined,
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: undefined,
    });
    expect(opts.max).toBe(20);
    expect(opts.idleTimeoutMillis).toBe(30000);
    expect(opts.connectionTimeoutMillis).toBe(2000);
  });
});
