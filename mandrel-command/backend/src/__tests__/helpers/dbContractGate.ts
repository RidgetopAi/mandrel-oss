/**
 * Shared gate for EVERY DB-backed test suite (extended by an earlier change).
 *
 * The file name says "contract" for history's sake: it was written for the
 * `*.contract.test.ts` family. It is now the SINGLE gate for both families —
 * `*.contract.test.ts` (`describeContract`) and `*.db.test.ts` (`describeDb`) — because
 * a second copy of this rule is exactly the failure this file exists to prevent.
 * Both exports read ONE decision (`DB_SUITE_MODE` below). There is no other place in
 * the backend where a DB suite may decide to run or skip; `dbTestGateCoverage.test.ts`
 * enforces that by scanning every test file.
 *
 * WHY IT HAD TO BE EXTENDED
 *   The 14 `*.db.test.ts` suites never adopted this helper. They each carried their own
 *   copy of the idiom:
 *
 *       const SKIP = process.env.MANDREL_SKIP_DB_TESTS === 'true';
 *       const d = SKIP ? describe.skip : describe;      // (2 of them: an opt-IN flag)
 *
 *   and BOTH authoritative gates set that flag job-wide — the CI gate STAGE 4 and
 *   .github/workflows/ci.yml — so 14 suites / 93 tests were silently skipped in CI
 *   while a fully migrated Postgres sat right there. MEASURED: with the security fix
 *   for an earlier change reverted (the route revoking nothing), the full backend suite under
 *   exact the CI gate STAGE 4 conditions still reported 408 passed / 0 failed. A guard that
 *   opts out of the gate is not a guard.
 *
 *   The flag is deliberately NOT read here. Its documented purpose (ci.yml) is to let
 *   "live-MCP-server-only suites self-skip"; these suites need only Postgres, which both
 *   gates provision and migrate. Ignoring it makes the gates' setting irrelevant to DB
 *   suites WITHOUT editing the CI gate or ci.yml.
 *
 * WHY: several `*.contract.test.ts` suites used to `return` early with a
 * `console.warn('DB unavailable — skipping …')` when Postgres was unreachable. In a
 * runner WITHOUT a DB those tests GREEN-PASSED while asserting NOTHING — silently
 * eroding the gate (LIST==DETAIL / project-isolation / real-migrated-schema
 * guarantees went unverified) yet reporting success. A silent green must be
 * impossible: coverage can never quietly disappear.
 *
 * THE CONTRACT (single source of truth — do not re-implement per file):
 *   - DEFAULT (incl. CI): a DB is REQUIRED. CI (the CI gate + .github/workflows/
 *     ci.yml) provisions a disposable migrated Postgres via
 *     scripts/provision-test-db.sh and exports the DATABASE_* env, so these suites
 *     RUN and ASSERT for real. If a required suite cannot reach Postgres,
 *     `assertDbReachable` THROWS in beforeAll → the whole suite FAILS LOUDLY (never a
 *     silent green).
 *   - LOCAL DEV opt-out: a developer with no Postgres may set
 *     MANDREL_DB_CONTRACTS_OPTIONAL=true → the suite is declared with `describe.skip`
 *     → a VISIBLE "skipped" line in the report (still not a silent green). This flag
 *     is NOT set in CI, so CI can never skip these guarantees.
 *
 * NOTE: this file lives under __tests__/ but is NOT a test file (no ".test.ts"
 * suffix) so jest's testMatch (files ending in .test.ts) never runs it as a suite.
 */
import type { Pool } from 'pg';

/**
 * The DATABASE_ / DB_ env convention shared by CI (the CI gate / ci.yml) and local runs.
 * The same shape every DB-backed contract suite used to declare inline.
 */
export const contractDbConfig = {
  user: process.env.DATABASE_USER || process.env.DB_USER || 'mandrel',
  host: process.env.DATABASE_HOST || process.env.DB_HOST || 'localhost',
  database: process.env.DATABASE_NAME || process.env.DB_NAME || 'mandrel',
  password: process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD || '',
  port: parseInt(process.env.DATABASE_PORT || process.env.DB_PORT || '5432', 10),
};

/**
 * Opt-out for a purely-local dev run with no Postgres. NOT set in CI, so CI always
 * REQUIRES the DB. When true the suite is declared with `describe.skip` → a VISIBLE
 * skip in the report, never a silent green.
 */
export const DB_CONTRACTS_OPTIONAL =
  process.env.MANDREL_DB_CONTRACTS_OPTIONAL === 'true';

/**
 * THE decision — the one place in the backend where a DB-backed suite is allowed to
 * choose between running and skipping. `describeContract` and `describeDb` are both
 * derived from this; neither may re-derive it, and no test file may express it inline
 * (enforced by dbTestGateCoverage.test.ts).
 *
 * 'run'  -> the real `describe`; an unreachable DB then fails LOUDLY in beforeAll.
 * 'skip' -> `describe.skip`; a VISIBLE skipped line, only ever from an explicit local
 *           opt-out that neither gate sets.
 */
export const DB_SUITE_MODE: 'run' | 'skip' = DB_CONTRACTS_OPTIONAL ? 'skip' : 'run';

/**
 * `describe` for a DB-backed contract suite. Use in place of a bare `describe`:
 *   - default (incl. CI): the real `describe` → the suite runs; an unreachable DB
 *     fails LOUDLY via `assertDbReachable` in beforeAll.
 *   - MANDREL_DB_CONTRACTS_OPTIONAL=true: `describe.skip` → a VISIBLE skip.
 * (Mirrors the existing `const d = SKIP ? describe.skip : describe` idiom used by the
 * repo's *.db.test.ts suites, centralized here so the skip logic can't drift.)
 */
export const describeContract = DB_SUITE_MODE === 'skip' ? describe.skip : describe; // db-gate-exempt: THE single gate implementation — this file is the one place allowed to hold a reference to `describe`, which is exactly why every other file is forbidden to

/**
 * Assert a reachable Postgres or FAIL LOUDLY. Call at the TOP of the suite's
 * beforeAll, before inserting fixtures. Throwing here fails the whole suite with an
 * actionable message instead of letting its tests silently pass without asserting.
 *
 * Only reached when the suite is REQUIRED (describeContract === describe); an
 * opted-out suite is `describe.skip` and this never runs.
 */
export async function assertDbReachable(pool: Pool): Promise<void> {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  } catch (err) {
    throw new Error(
      'DB-backed contract suite requires a reachable Postgres but could not connect ' +
        `(${(err as Error).message}). These suites assert customer-facing guarantees ` +
        '(LIST==DETAIL, project isolation, real migrated schema) and MUST run in CI, ' +
        'which provisions a disposable migrated DB via scripts/provision-test-db.sh. ' +
        'Start / point at a Postgres (set DATABASE_* env), or set ' +
        'MANDREL_DB_CONTRACTS_OPTIONAL=true to VISIBLY skip this suite in local dev.',
    );
  }
}

/**
 * `describe` for a DB-backed suite (`*.db.test.ts`).
 *
 * Use INSTEAD of a bare `describe` and instead of any hand-rolled
 * `const d = SKIP ? describe.skip : describe`. The old idiom is now a RED in
 * dbTestGateCoverage.test.ts, so a 15th suite cannot be written the old way by
 * copy-paste.
 *
 * The difference from `describeContract` is not the decision — that is shared
 * (`DB_SUITE_MODE`) — it is that this one INJECTS the reachability assertion into the
 * suite instead of trusting each author to remember to call it. The `.contract`
 * family has to call `assertDbReachable` by hand in its own beforeAll, and "remember
 * to call the guard" is the weakest place a rule can be written. Here,
 * adopting the gate IS being guarded — you cannot take the describe and skip the check.
 *
 * The probe opens its OWN short-lived connection from `contractDbConfig` rather than
 * borrowing the suite's pool: the suite's pool is usually created inside its own
 * beforeAll, which registers AFTER this one and would still be undefined here.
 * `max: 1` + an explicit `end()` keeps it to a single client slot for a few ms
 * (Postgres client slots are a box-wide resource this suite does not provision).
 */
export function describeDb(name: string, body: () => void): void { // db-gate-exempt: THE single gate implementation
  if (DB_SUITE_MODE === 'skip') {
    describe.skip(name, body); // db-gate-exempt: THE single gate implementation
    return;
  }

  describe(name, () => { // db-gate-exempt: THE single gate implementation
    beforeAll(async () => {
      // Imported lazily so a skipped run never even loads the driver.
      const { Pool } = await import('pg');
      const probe = new Pool({ ...contractDbConfig, max: 1 });
      try {
        await assertDbReachable(probe);
      } finally {
        await probe.end();
      }
    });

    body();
  });
}
