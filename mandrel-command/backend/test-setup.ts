/**
 * Global Jest setup for the Mandrel Command backend test suite.
 * Loaded via `setupFilesAfterEnv` — runs once per test file before tests execute.
 */

// Integration / SSE tests can be slow; give them headroom.
jest.setTimeout(30000);

// Default to a test environment.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Local-dev DB defaults so `npm test` works without a hand-rolled env line.
// The whole codebase reads a single canonical DB-config convention: DATABASE_*
// (the legacy AIDIS_DB_* alias was removed in D6). The local dev database is
// `aidis_production` owned by the OS user.
//
// CI / other machines should point at a dedicated test DB by exporting
// DATABASE_NAME (e.g. `mandrel_test`) — plus DATABASE_USER/PASSWORD/HOST/PORT as
// needed — before running the suite; these defaults are only a local fallback.
process.env.DATABASE_NAME = process.env.DATABASE_NAME || 'aidis_production';
process.env.DATABASE_USER = process.env.DATABASE_USER || 'mandrel';
process.env.DATABASE_PASSWORD = process.env.DATABASE_PASSWORD || '';

// MANDREL_SKIP_DB_TESTS NO LONGER SKIPS DB SUITES.
//
// This warning used to announce "DB/SSE integration tests will be skipped" — and it
// was printed 52 times in a run where 510 DB-inclusive tests actually executed, which
// is worse than no message: every CI log said coverage had been dropped when it had
// not. DB suites now gate on REACHABILITY via src/__tests__/helpers/dbContractGate.ts
// (describeDb / describeContract), which does not read this flag at all.
//
// The flag survives only for `npm run test:contracts` (package.json) and the two CI
// gates, which still export it; it is inert for suite selection. The local way to skip
// DB suites is MANDREL_DB_CONTRACTS_OPTIONAL=true, and that produces a VISIBLE skipped
// line rather than a silent green.
if (process.env.MANDREL_SKIP_DB_TESTS === 'true') {
  // eslint-disable-next-line no-console
  console.warn(
    '[test-setup] MANDREL_SKIP_DB_TESTS=true is set but is INERT for DB suites — they ' +
      'gate on Postgres reachability (helpers/dbContractGate). Nothing is being skipped ' +
      'because of this flag. To skip DB suites locally: MANDREL_DB_CONTRACTS_OPTIONAL=true.',
  );
}
