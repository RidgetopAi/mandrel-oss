/**
 * Resolve the disposable, migrated database a DB-backed test must run against —
 * or FAIL LOUDLY. There is deliberately no default.
 *
 * WHY THERE IS NO DEFAULT (folded in on the coordinator's call)
 * ------------------------------------------------------------------
 * Four OAuth integration tests each carried their own last-resort literal:
 *   process.env.X_DB_NAME || process.env.DATABASE_NAME || 'ci_better_auth_ba1'
 * It was written so a bare `vitest` run against a hand-provisioned DB would work. What
 * it actually did was give every lane on the box the SAME database name the moment
 * DATABASE_NAME was unset — the same defect as the fixed TCP port one axis over, and the
 * more dangerous one: `scripts/provision-test-db.sh --drop` destroys by NAME, and 58 of
 * the 67 copies of that script under ~/projects carry no ownership-stamp logic at all
 * (measured 2026-08-26). A stale peer runs as the Postgres superuser and drops whatever
 * name it is given. Colliding on a port costs you a failed run; colliding on a database
 * name costs another lane its database mid-suite.
 *
 * WHY THE ANSWER IS "REQUIRE IT", NOT "DERIVE IT"
 * ----------------------------------------------
 * For a PORT, a test can mint its own with zero agreement from anyone: ask the kernel
 * (`listen(0)`). A DATABASE cannot be minted from inside a test — it has to already
 * exist, already be migrated, and already have a role that authenticates. So the
 * zero-agreement answer here is the opposite move: refuse to invent one. Any invented
 * default IS a shared convention every future lane must know about and avoid, which is
 * exactly the property that made the port literal and the name literal fail.
 *
 * This also RESTORES AGREEMENT with the shipped product. `src/config/database.ts` already
 * throws `DATABASE_NAME environment variable is required!` when it is unset. These four
 * test files were a bespoke SECOND default that quietly overrode that fail-closed rule by
 * handing a literal straight to a `pg.Pool`. Deleting the literal is not new machinery; it
 * is the removal of an override.
 *
 * Enforced by sharedScratchDbName.contract.test.ts.
 */

export interface ScratchDb {
  readonly name: string;
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: string;
}

/**
 * @param overridePrefix the file's own escape hatch prefix (e.g. 'BA1' -> BA1_DB_NAME),
 *   so a manual run can pin a specific scratch DB without touching DATABASE_*.
 */
export function requireScratchDb(overridePrefix: string): ScratchDb {
  const pick = (suffix: string): string | undefined =>
    process.env[`${overridePrefix}_DB_${suffix}`] || process.env[`DATABASE_${suffix}`];

  const name = pick('NAME');
  const user = pick('USER');
  const password = pick('PASSWORD') ?? process.env[`${overridePrefix}_DB_PASS`];

  // All three or none. A partial set is the state that used to produce a confusing auth
  // error three layers down instead of naming the missing variable here.
  const missing = [
    name ? null : `${overridePrefix}_DB_NAME or DATABASE_NAME`,
    user ? null : `${overridePrefix}_DB_USER or DATABASE_USER`,
    password ? null : `${overridePrefix}_DB_PASSWORD or DATABASE_PASSWORD`,
  ].filter((m): m is string => m !== null);

  if (missing.length > 0) {
    throw new Error(
      `This test needs a disposable, MIGRATED database and there is deliberately no ` +
        `default — a shared default name is what lets a concurrent lane (or a stale ` +
        `provision-test-db.sh, which drops by name) destroy your database mid-suite.\n` +
        `Missing: ${missing.join(', ')}\n` +
        `Provision one and point this run at it:\n` +
        `  eval "$(bash scripts/provision-test-db.sh --auto)"\n` +
        `  npx vitest run <this file>\n` +
        `…and drop it when you are done:\n` +
        `  bash scripts/provision-test-db.sh "$DATABASE_NAME" --drop`
    );
  }

  return {
    name: name as string,
    user: user as string,
    password: password as string,
    host: process.env.DATABASE_HOST || 'localhost',
    port: process.env.DATABASE_PORT || '5432',
  };
}
