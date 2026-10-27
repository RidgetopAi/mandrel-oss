/**
 * DATASTORE ERROR BOUNDARY — the guard for an earlier task.
 *
 * WHAT IT GUARDS: "internal error text is the default caller-facing text." A Postgres
 * driver message must never reach an MCP caller, and the raw detail must still reach the
 * server log. See utils/datastoreError.ts for the mechanism and the measured leak.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A GREP FOR `invalid input syntax` (CLASSES.md C3)
 *
 * Seven existing test files each assert the absence of ONE known-bad driver string
 * (taskCreateDependencyResolution, decisionSupersededByShortId, projectArgNormalizer,
 * taskCreateLongDescription, contextStoreDanglingSession, sessionAnalyticsUuidGuard,
 * sessionCreateRace). That is the decorative form: it can only ever catch the leak that
 * already happened, and it rots the moment Postgres words a fault differently or a NEW
 * fault class (statement timeout, deadlock, connection-slot exhaustion, disk full) shows
 * up on perfectly valid input.
 *
 * So §1 asserts an ALLOWLIST, not a denylist: the escaping error's message must be
 * EXACTLY `datastoreErrorText(ref)` — the one synthetic string, character for character.
 * There is nothing for a new driver message to slip past, because nothing is being
 * pattern-matched. A leak is not "a message that matches a bad pattern"; it is "a message
 * that is not the typed one".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE POPULATION THIS GUARD ENUMERATES, STATED PRECISELY (CLASSES.md C3, last paragraph)
 *
 * §4 walks EVERY `.ts` file under `mcp-server/src/`, INCLUDING `src/tests/`, `src/scripts/`
 * and `src/api/`, with NO hand-written file list and NO directory the author happened to be
 * working in. It asserts the walk found files and found pools, so an empty or zero
 * population FAILS instead of passing vacuously. It applies THREE checks of increasing
 * strength:
 *   (a) every textual `new Pool(` outside `src/tests/` is wrapped in `guardPool(`;
 *   (b) every same-file `const X = Pool` alias construction is wrapped;
 *   (c) THE ONE THAT DOES THE WORK — only the four known construction sites may import
 *       `Pool` from 'pg' as a VALUE at all.
 *
 * (a) and (b) are textual and Reviewer got THREE shapes past them: `import { Pool as PG }`,
 * `new  Pool({})` (two spaces), and `const P: typeof Pool = Pool`. All three are caught by
 * (c), because constructing a pg Pool REQUIRES importing `Pool` as a value and no spelling
 * of `new` avoids that. `import type` cannot construct, so type-only users are untouched —
 * the four handlers that imported it as a value while using it purely as a type were
 * converted to `import type`, which is what they always meant.
 *
 * WHAT §4 CANNOT SEE — say it plainly rather than let the sentence be wider than the code:
 *   1. `mandrel-command/` (the Command UI backend) is a SEPARATE service with its own
 *      pg access and is NOT scanned. It is outside this task's surface (it does not serve
 *      MCP tool calls) and outside this fix. Its own error hygiene is unaudited by this
 *      guard, and that is a real, named gap — not a claim that it is safe.
 *   2. A pool constructed via a DYNAMIC import — `new (await import('pg')).Pool(…)` — which
 *      never produces a STATIC import statement for check (c) to see. It is the one spelling
 *      nobody writes by accident, but it is not the only one that gets through: see below.
 *
 *      HISTORY, because this line has been wrong before and the wrongness is the hazard:
 *      an earlier revision of this comment claimed "the static alias/spacing/rename shapes
 *      ARE caught". Reviewer then got THREE ordinary spellings past check (c) —
 *      `import * as pg from 'pg'`, `import pgDefault from 'pg'`, and a multi-line
 *      `import {\n  Pool as PG,\n} from 'pg'` (i.e. exactly how prettier formats a long
 *      import). The old check matched line-by-line and required the token `Pool` before
 *      `from`, so a namespace/default import (which never names `Pool`) and any statement
 *      split across lines both sailed through.
 *
 *      Check (c) has since been widened to parse whole import STATEMENTS (multi-line aware)
 *      and to flag ANY non-`import type` import from 'pg' outside the four ALLOWED paths,
 *      regardless of what it names — because you cannot construct a Pool without importing
 *      the module as a value in some form. All three shapes above are now caught. What is
 *      still NOT caught is the dynamic import, and anything outside `mcp-server/src`.
 *
 *      The rule this file exists to demonstrate applies to this comment too: a false
 *      blind-spot statement is worse than a missing one, because the next author reads it
 *      and believes their spelling is covered. If you widen this sentence, widen the guard
 *      in the same commit — and if you narrow the guard, narrow this sentence.
 *   3. A dependency that opens its own connection and surfaces its own error text
 *      (better-auth talks through the pool we hand it, so it IS covered; a library that
 *      dialed out itself would not be).
 *   4. Non-DB internal text — an fs path, an internal fetch URL, an embedder message.
 *      Those still route through `sanitizeErrorText`'s denylist in
 *      `utils/actionableError.ts`, which is unchanged by this task and is a WEAKER
 *      guarantee than the one asserted here.
 *
 * DB target: the disposable migrated database provisioned by the CI gate. NEVER `mandrel`.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import type * as http from 'http';
import type express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.unmock('crypto');
vi.unmock('node:crypto');

import {
  DatastoreError,
  DATASTORE_ERROR_CODE,
  datastoreErrorText,
  isDatastoreError,
  redactDatastoreError,
  guardPool,
} from '../utils/datastoreError.js';
import { Pool } from 'pg'; // value import: test files are excluded from the §4 value-import scan
import { db } from '../config/database.js';
import { dbPool } from '../services/databasePool.js';
import MandrelMcpServer from '../server/MandrelMcpServer.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const CONN = `dserr-conn-${STAMP}`;

/**
 * Fault shapes, each a DIFFERENT Postgres error class, each with the exact fragment the
 * caller must never see. Deliberately spans cast / length / uniqueness / referential /
 * schema / arithmetic / syntax so the guard is not tuned to the one that was reported.
 */
const FAULTS: Array<{ name: string; sql: string; params?: unknown[]; leaks: RegExp }> = [
  { name: '22P02 uuid cast', sql: `SELECT * FROM projects WHERE id = $1`, params: ['not-a-uuid'], leaks: /invalid input syntax for type uuid/i },
  // A ROLLED-BACK write, not a read: `'x'::varchar(2)` truncates silently in Postgres — only a
  // real column constraint raises 22001. This is the exact shape of the taskCreateLongDescription
  // leak (`value too long for type character varying(200)`), so the guard covers it for real.
  { name: '22001 value too long (column constraint)', sql: `INSERT INTO projects (name) VALUES (repeat('x', 300))`, leaks: /value too long for type/i },
  { name: '22003 numeric out of range', sql: `SELECT 99999::smallint`, leaks: /smallint out of range/i },
  { name: '42703 undefined column', sql: `SELECT no_such_column_2d383cc2 FROM projects`, leaks: /column .*no_such_column_2d383cc2.* does not exist/i },
  { name: '42P01 undefined table', sql: `SELECT 1 FROM no_such_table_2d383cc2`, leaks: /relation .*no_such_table_2d383cc2.* does not exist/i },
  { name: '22012 division by zero', sql: `SELECT 1/0`, leaks: /division by zero/i },
  { name: '42601 syntax error', sql: `SELEKT 1`, leaks: /syntax error at or near/i },
  { name: '22P02 enum/int cast', sql: `SELECT $1::int`, params: ['abc'], leaks: /invalid input syntax for type integer/i },
];

async function expectRedacted(run: () => Promise<unknown>, leaks: RegExp, label: string) {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, `${label}: expected a throw`).toBeDefined();
  const err = caught as DatastoreError;

  // (a) it IS the typed boundary error
  expect(isDatastoreError(err), `${label}: not a DatastoreError`).toBe(true);
  expect(err).toBeInstanceOf(Error);
  expect(err.ref, `${label}: missing ref`).toMatch(/^[0-9a-f]{8}$/);

  // (b) ALLOWLIST: the message is EXACTLY the synthetic text. Not "does not match a bad
  //     pattern" — IS the one permitted string. Nothing can slip past an equality check.
  expect(err.message, `${label}: message is not the typed form`).toBe(datastoreErrorText(err.ref));
  expect(err.message).toContain(DATASTORE_ERROR_CODE);

  // (c) and, redundantly but explicitly, the raw fragment is gone. This assertion is the
  //     denylist one and is kept ONLY as a human-readable failure message; (b) is the guard.
  expect(err.message, `${label}: RAW DRIVER TEXT LEAKED`).not.toMatch(leaks);
}

describe('datastore error boundary', () => {
  // CONNECTION BUDGET (measured, not assumed). Touching `dbPool` initialises the SECOND pool
  // — min 5 / max 30 idle connections that it then holds for the remainder of the run. Added
  // to the shared `db` pool's 20, that exceeds the throwaway CI role's CONNECTION LIMIT (40,
  // scripts/provision-test-db.sh TEST_DB_CONN_LIMIT) and detonated 70 unrelated test FILES
  // with `too many connections for role`. Close it as soon as this file is done with it.
  afterAll(async () => {
    await dbPool.close().catch(() => {});
  });

  // ===================================================================================
  // §1 THE CHOKE POINT — every doorway, every fault shape, allowlist assertion.
  // ===================================================================================
  describe('§1 no driver text escapes any DB doorway', () => {
    for (const f of FAULTS) {
      test(`db.query — ${f.name}`, async () => {
        await expectRedacted(() => db.query(f.sql, f.params as never[]), f.leaks, `db.query/${f.name}`);
      });

      test(`client.query via db.connect() — ${f.name}`, async () => {
        const client = await db.connect();
        try {
          await expectRedacted(
            () => client.query(f.sql, f.params as never[]),
            f.leaks,
            `client.query/${f.name}`,
          );
        } finally {
          client.release();
        }
      });
    }

    // ---------------------------------------------------------------------------------
    // THE CALLBACK OVERLOAD. `pg`'s query() supports `query(text, cb)` as well as the
    // promise form, and the callback form DOES NOT REJECT — it hands the raw driver error
    // to the callback. The first version of this boundary intercepted only the rejection,
    // so these two calls walked straight past it while every await-form call was airtight
    // (Reviewer measured it on a real DB). §1 above exercises only await-form calls, so
    // the suite was GREEN with the hole open — the exact hollow-guard shape this task
    // exists to close. These two cases are the fuse for it.
    // ---------------------------------------------------------------------------------
    function queryViaCallback(
      target: { query: (...a: unknown[]) => unknown },
      sql: string,
    ): Promise<unknown> {
      return new Promise((resolve) => {
        target.query(sql, (err: unknown) => resolve(err));
      });
    }

    test('pool.query(text, CALLBACK) — the callback err is redacted (F1)', async () => {
      const err = (await queryViaCallback(db as never, 'SELEKT 1')) as DatastoreError;
      expect(err, 'the callback received no error at all').toBeTruthy();
      expect(isDatastoreError(err), 'RAW DRIVER ERROR reached the callback').toBe(true);
      expect(err.message).toBe(datastoreErrorText(err.ref));
      expect(err.message).not.toMatch(/syntax error at or near/i);
    });

    test('client.query(text, CALLBACK) — the callback err is redacted (F1)', async () => {
      const client = await db.connect();
      try {
        const err = (await queryViaCallback(client as never, 'SELEKT 1')) as DatastoreError;
        expect(err, 'the callback received no error at all').toBeTruthy();
        expect(isDatastoreError(err), 'RAW DRIVER ERROR reached the callback').toBe(true);
        expect(err.message).toBe(datastoreErrorText(err.ref));
        expect(err.message).not.toMatch(/syntax error at or near/i);
      } finally {
        client.release();
      }
    });

    test('the callback overload still delivers RESULTS on success (the guard did not break it)', async () => {
      const res = await new Promise<{ rows: Array<{ n: number }> }>((resolve, reject) => {
        (db as never as { query: (...a: unknown[]) => unknown }).query(
          'SELECT 1::int AS n',
          (err: unknown, r: unknown) => (err ? reject(err) : resolve(r as never)),
        );
      });
      expect(res.rows[0].n).toBe(1);
    });

    test('dbPool.query (the SECOND pool) is guarded too', async () => {
      await expectRedacted(
        () => dbPool.query(`SELECT no_such_column_2d383cc2 FROM projects`),
        /does not exist/i,
        'dbPool.query',
      );
    });

    test('dbPool.transaction rolls back AND redacts', async () => {
      await expectRedacted(
        () => dbPool.transaction(async (c) => c.query(`SELEKT 1`)),
        /syntax error at or near/i,
        'dbPool.transaction',
      );
    });

    test("a client handed to a pool 'connect' LISTENER is guarded too (the second doorway)", async () => {
      // `pool.on('connect', cb)` bypasses `connect()` entirely and hands over the RAW client.
      // Measured during this task: wrapping connect() alone left it unwrapped. Guarded now at
      // construction time, so a listener added tomorrow cannot inherit a raw client.
      const probe = guardPool(new (await import('pg')).Pool({
        user: process.env.DATABASE_USER,
        host: process.env.DATABASE_HOST,
        database: process.env.DATABASE_NAME,
        password: process.env.DATABASE_PASSWORD,
        port: Number(process.env.DATABASE_PORT ?? 5432),
        max: 1,
      }));
      const seen = new Promise<import('pg').PoolClient>((resolve) => probe.on('connect', resolve));
      const warm = await probe.connect();
      warm.release();
      const listenerClient = await seen;
      await expectRedacted(
        () => listenerClient.query(`SELEKT 1`),
        /syntax error at or near/i,
        "listener client",
      );
      await probe.end();
    }, 30000);

    test('a pool freshly guarded at runtime behaves identically (guardPool is the mechanism, not a one-off edit)', async () => {
      // Proves the boundary is a reusable function applied at construction, not three
      // hand-written try/catches that happen to agree today.
      const again = guardPool(db); // idempotent — must NOT stack wrappers or double-log
      await expectRedacted(() => again.query(`SELECT 1/0`), /division by zero/i, 're-guarded');
    });
  });

  // ===================================================================================
  // §2 DIAGNOSTICS ARE NOT LOST — the other half of the acceptance.
  // ===================================================================================
  describe('§2 the raw detail survives server-side and CANNOT be re-published', () => {
    test('the raw driver message is retained on the error, and the ref ties it to the log', async () => {
      let err!: DatastoreError;
      try {
        await db.query(`SELECT * FROM projects WHERE id = $1`, ['not-a-uuid']);
      } catch (e) {
        err = e as DatastoreError;
      }
      const cause = err.internal.cause as Error;
      expect(cause.message).toMatch(/invalid input syntax for type uuid/i);
      expect(err.internal.sql).toContain('FROM projects');
      expect(err.code).toBe('22P02'); // SQLSTATE preserved for control flow + status mapping
      expect(err.message).toContain(err.ref); // the caller can quote the ref
    });

    test('`internal` is NON-ENUMERABLE — the three republishing paths cannot see it', async () => {
      let err!: DatastoreError;
      try {
        await db.query(`SELECT * FROM projects WHERE id = $1`, ['not-a-uuid']);
      } catch (e) {
        err = e as DatastoreError;
      }
      // JSON.stringify — how an error reaches a log shipper or an API body
      expect(JSON.stringify(err)).not.toMatch(/invalid input syntax/i);
      // object spread — how an error reaches structuredContent
      expect(JSON.stringify({ ...err })).not.toMatch(/invalid input syntax/i);
      // enumeration — how a generic serializer walks it
      expect(Object.keys(err)).not.toContain('internal');
      // …but the value is still there for a human/debugger
      expect((err.internal.cause as Error).message).toMatch(/invalid input syntax/i);
    });
  });

  // ===================================================================================
  // §3 FAIL CLOSED on the values that slip through a guard (CLASSES.md C3: empty/zero/absent).
  // ===================================================================================
  describe('§3 fail-closed on degenerate causes', () => {
    for (const [label, value] of [
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ['zero', 0],
      ['false', false],
      ['NaN', NaN],
      ['a bare object', {}],
      ['a string throw', 'invalid input syntax for type uuid: "abc"'],
      ['an Error with a leaky message', new Error('duplicate key value violates unique constraint "tasks_pkey"')],
    ] as Array<[string, unknown]>) {
      test(`redactDatastoreError(${label}) still yields the typed, safe form`, () => {
        const out = redactDatastoreError(value);
        expect(isDatastoreError(out)).toBe(true);
        expect(out.message).toBe(datastoreErrorText(out.ref));
        expect(out.message).not.toMatch(/invalid input syntax|duplicate key|tasks_pkey/i);
      });
    }

    test('re-redacting a DatastoreError is a no-op (no double-wrap, no second log line)', () => {
      const once = redactDatastoreError(new Error('invalid input syntax for type uuid: "x"'));
      const twice = redactDatastoreError(once);
      expect(twice).toBe(once);
      expect(twice.ref).toBe(once.ref);
    });
  });

  // ===================================================================================
  // §4 POPULATION GUARD — every pg Pool constructed under mcp-server/src is boundaried.
  //     Scope + blind spots are stated in the file header AND asserted here.
  //
  //     WRAPPING IS HALF A CLAIM. Read what these scans prove and what they do not, because
  //     the gap cost a P0: on 2026-08-12 prod died on a routine Postgres
  //     restart while every assertion in this section was GREEN. They were green correctly —
  //     every pool WAS wrapped. `guardPool()` simply did not yet install a `pool.on('error')`
  //     listener, so an idle client's socket error was rethrown by EventEmitter as an
  //     uncaughtException and the process exited 1. "Wrapped in guardPool" only means
  //     "protected" if you also know what guardPool CONFERS.
  //
  //     So the guarantee is a CHAIN of two links, and both are executed here:
  //       (a) every production pool passes through `guardPool()`   — the textual scans below;
  //       (b) a pool that passed through `guardPool()` SURVIVES a connection-level fault
  //           — the behavioural tests immediately following, driven on the real `db` and
  //           `dbPool` objects.
  //     Link (b) is asserted here against a SYNTHETIC emit, which is the strongest thing an
  //     in-process test can do. The end-to-end version — real Postgres backends terminated
  //     underneath the production pool, with the process's exit code as the oracle — is
  //     poolSurvivesDatastoreBounce.contract.test.ts, and it is the one that reproduces the
  //     incident.
  // ===================================================================================
  describe('§4 every `new Pool(` under mcp-server/src is wrapped in guardPool()', () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    function walk(dir: string, out: string[] = []): string[] {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'dist') continue;
          walk(p, out);
        } else if (e.isFile() && p.endsWith('.ts')) {
          out.push(p);
        }
      }
      return out;
    }

    const files = walk(SRC);
    const TESTS_DIR = path.join(SRC, 'tests') + path.sep;

    test('the walk actually found a population (an empty scan must FAIL, not pass vacuously)', () => {
      expect(files.length, 'the src walk found no .ts files — the guard would be inert').toBeGreaterThan(100);
      const withPool = files.filter((f) => fs.readFileSync(f, 'utf8').includes('new Pool('));
      expect(withPool.length, 'no `new Pool(` found anywhere — the guard would be inert').toBeGreaterThan(0);
    });

    // ── link (b): guardPool CONFERS SURVIVAL ────────────────────────────────────────────
    // `EventEmitter.emit('error', e)` THROWS `e` synchronously when the emitter has no
    // 'error' listener. That is the whole mechanism of the P0, and it makes these tests
    // falsifiable: before the fix they threw, exactly as prod did.
    // Two members on purpose: the REAL production pool (the instance the incident hit), and a
    // freshly-guarded arbitrary pool (the CLASS — which, combined with link (a), is what
    // extends the guarantee to every other construction site, `dbPool` included, without this
    // file having to reach into that service's private pool).
    for (const [name, makePool] of [
      ['the production `db` pool from config/database.ts', () => db],
      ['any pool guardPool() has touched', () => guardPool(new Pool({}))],
    ] as Array<[string, () => import('pg').Pool]>) {
      test(`a connection-level error on ${name} does not take the process down`, async () => {
        const { monitoring } = await import('../utils/monitoring.js');
        const { DATASTORE_POOL_ERROR_COUNTER } = await import('../utils/datastoreError.js');
        const before = monitoring.getLatestMetric(DATASTORE_POOL_ERROR_COUNTER)?.value ?? 0;

        // The exact fault prod saw: 57P01, "terminating connection due to administrator
        // command", arriving with no product frame on the stack.
        const fault = Object.assign(new Error('terminating connection due to administrator command'), {
          code: '57P01',
        });
        expect(() => makePool().emit('error', fault)).not.toThrow();

        // NOT SILENTLY: a swallow would pass the line above. The counter is incremented via a
        // deferred import (see onPoolError), hence the tick.
        await new Promise((r) => setTimeout(r, 100));
        expect(monitoring.getLatestMetric(DATASTORE_POOL_ERROR_COUNTER)?.value ?? 0).toBeGreaterThan(before);
      });
    }

    test('the handler survives degenerate error values (empty/zero/absent)', () => {
      // A driver does not always hand you an Error. `undefined`/`null`/a bare string reaching
      // the handler must not throw OUT of it — a handler that throws while handling the pool's
      // error re-creates the uncaughtException it exists to prevent.
      const pool = guardPool(new Pool({}));
      for (const v of [undefined, null, '', 0, false, NaN, {}, 'socket hang up']) {
        expect(() => pool.emit('error', v), `emit('error', ${String(v)}) threw`).not.toThrow();
      }
    });

    test('every production `new Pool(` occurrence is guarded', () => {
      const offenders: string[] = [];
      let productionPools = 0;
      for (const f of files) {
        if (f.startsWith(TESTS_DIR)) continue; // test harnesses own their own throwaway pools
        const src = fs.readFileSync(f, 'utf8');
        const lines = src.split('\n');
        lines.forEach((rawLine, i) => {
          // Strip `//` line comments FIRST. This file's own prose mentions `new Pool(`, and a
          // comment is not a construction — matching it would make the guard fail on its own
          // documentation, which is how a guard gets deleted.
          const line = rawLine.replace(/\/\/.*$/, '');
          if (!line.includes('new Pool(')) return;
          productionPools++;
          // The construction must be the ARGUMENT of guardPool(...) on the same line.
          if (!/guardPool\(\s*new Pool\(/.test(line)) {
            offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
      // Non-vacuity: if a refactor ever leaves ZERO production pools, that is a signal the
      // scan broke, not that the codebase got safe.
      expect(productionPools, 'zero production pools found — scan is broken').toBeGreaterThanOrEqual(4);
      expect(offenders, `UNGUARDED pg Pool(s):\n${offenders.join('\n')}`).toEqual([]);
    });

    test('a Pool constructed through a LOCAL ALIAS is caught too', () => {
      // MEASURED BYPASS, not a hypothetical: during this task `const P = Pool; new P({})` was
      // dropped into src/services/ and the scan above passed 41/41 without noticing. This
      // closes the realistic half of that hole — a same-file alias. It does NOT close the
      // general case (a Pool reaching a call site through an arbitrary expression, an import
      // rename, or a factory in a dependency); see "WHAT §4 CANNOT SEE" in the header.
      const offenders: string[] = [];
      for (const f of files) {
        if (f.startsWith(TESTS_DIR)) continue;
        const src = fs.readFileSync(f, 'utf8');
        const aliases = [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*Pool\s*[;\n]/g)].map((m) => m[1]);
        for (const alias of aliases) {
          const ctor = new RegExp(`new\\s+${alias}\\s*\\(`, 'g');
          src.split('\n').forEach((rawLine, i) => {
            const line = rawLine.replace(/\/\/.*$/, '');
            if (!ctor.test(line)) return;
            if (!new RegExp(`guardPool\\(\\s*new\\s+${alias}\\s*\\(`).test(line)) {
              offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
            }
          });
        }
      }
      expect(offenders, `UNGUARDED aliased pg Pool(s):\n${offenders.join('\n')}`).toEqual([]);
    });

    test('ONLY the known construction sites import `Pool` from pg as a VALUE', () => {
      // THE SPELLING-PROOF CHOKE POINT. Scanning for `new Pool(` is textual and Reviewer
      // got THREE shapes past it: `import { Pool as PG }`, `new  Pool({})` (two spaces),
      // and `const P: typeof Pool = Pool`. All three share ONE prerequisite that cannot be
      // spelled around: to CONSTRUCT a pg Pool you must first import `Pool` as a VALUE.
      // `import type` cannot construct anything, so type-only users are unaffected — and
      // the four handlers that imported it as a value while using it purely as a type were
      // converted to `import type`, which is what they always meant. Net: value-import of
      // Pool ⟹ you are a construction site ⟹ you must be one of the four.
      //
      // WIDENED 2026-07-29 after Reviewer got THREE shapes past the previous version:
      // `import * as pg from 'pg'`, `import pgDefault from 'pg'`, and a multi-line
      // `import {\n  Pool as PG,\n} from 'pg'`. The old scan walked LINE BY LINE and
      // required the token `Pool` to appear before `from` — so a namespace or default
      // import (which never names `Pool`) was invisible, and so was any import statement
      // that prettier had wrapped across lines.
      //
      // Now: parse whole import STATEMENTS (multi-line aware) and flag ANY non-`import
      // type` import from 'pg' outside ALLOWED, regardless of what it binds. Rationale —
      // you cannot construct a Pool without importing the module as a value in SOME form,
      // and what you choose to call it is exactly the part a text scan cannot pin down.
      // Measured before widening: of 32 pg imports in src, exactly 4 are value imports and
      // all 4 are already ALLOWED — every other file uses `import type`. So this widening
      // makes no legitimate code illegal today (C3 corollary: when you widen a population,
      // check what you just outlawed).
      //
      // STILL NOT SEEN (and stated in the header): a DYNAMIC `await import('pg')`, and
      // anything outside mcp-server/src.
      const ALLOWED = new Set([
        'config/database.ts',
        'services/databasePool.ts',
        'server/auth.ts',
        'scripts/seed-first-oauth-user.ts',
        // operator CLI, same shape as the seeder (sign-up S5); guardPool-wrapped
        'scripts/mint-set-password-link.ts',
      ]);
      // Whole-statement matcher: `import ... from 'pg'`, however many lines it spans.
      //
      // ⚠️ FALSE-POSITIVE CLASS FIXED 2026-08-24 (P5.4). The body used to be `[\s\S]*?`,
      // which CROSSES STATEMENT BOUNDARIES: the lazy match starts at the FIRST `import` at
      // line start and runs until it finds `from 'pg'`, so in a file whose pg import is
      // PRECEDED by any other import, the captured "statement" begins with the WRONG
      // import. The classifier then tests `/^import\s+type\b/` against that wrong
      // beginning — so a perfectly legal `import type { Pool } from 'pg'` was reported as a
      // VALUE import, purely because of where it sat in the import block. Measured on this
      // tree: services/handoffCarriedFields.ts was flagged while services/handoffStamp.ts,
      // carrying the byte-identical import line, was not — the ONLY difference is that
      // handoffStamp's is the file's first import.
      //
      // That is worse than a miss: it is a guard that fails CLOSED on correct code, and a
      // guard that blocks correct work gets deleted the first time it is inconvenient (C3).
      //
      // THE FIX IS A NARROWING, NOT A WIDENING: an import statement's head cannot contain a
      // `;`, so forbidding one in the body pins each match to its own statement. It cannot
      // hide a real value-import from 'pg' — a real one has no semicolon before its `from`.
      const PG_IMPORT_STMT = /^[ \t]*import\b[^;]*?from\s*['"]pg['"]/gm;
      const valueImporters: string[] = [];
      for (const f of files) {
        if (f.startsWith(TESTS_DIR)) continue;
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(PG_IMPORT_STMT)) {
          const stmt = m[0].replace(/\s+/g, ' ').trim();
          if (/^import\s+type\b/.test(stmt)) continue; // type-only: cannot construct
          valueImporters.push(path.relative(SRC, f).split(path.sep).join('/'));
        }
      }
      expect(valueImporters.length, "no value-import from 'pg' found — the scan is broken").toBeGreaterThanOrEqual(4);
      const unexpected = valueImporters.filter((f) => !ALLOWED.has(f));
      expect(
        unexpected,
        `file(s) import from 'pg' as a VALUE but are not a known guarded construction site:\n${unexpected.join('\n')}\n` +
          'Any value-import from \'pg\' can construct a Pool — named, renamed, namespace (`import * as pg`)\n' +
          'or default — so this check does not care what you bound it to.\n' +
          'Either construct via guardPool(new Pool(...)) and add the path to ALLOWED, or use `import type`.',
      ).toEqual([]);
      // and every ALLOWED site must still actually exist (a rename must not silently shrink it)
      for (const a of ALLOWED) {
        expect(valueImporters, `known construction site '${a}' no longer imports Pool`).toContain(a);
      }
    });

    test('the guard states its own blind spots in-file (so the sentence never outgrows the code)', () => {
      const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
      expect(self).toContain('WHAT §4 CANNOT SEE');
      expect(self).toContain('mandrel-command/');
    });
  });
});

// =====================================================================================
// §5 + §6 — the CALLER-FACING surface, end to end. Separate describe so it owns the
//           server/DB fixture lifecycle.
// =====================================================================================
describe('caller-facing surface', () => {
  let listener: http.Server;
  let base: string;
  let projectNames: string[] = [];
  const OTHER_PROJECT = `dserr-other-${STAMP}`;

  async function post(tool: string, args: Record<string, unknown>) {
    const res = await fetch(`${base}/mcp/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-ID': CONN, 'X-Actor-ID': 'guard' },
      body: JSON.stringify({ arguments: args }),
    });
    const body = (await res.json()) as { success: boolean; result?: any; error?: string };
    const text =
      body.result?.content?.map((c: { text?: string }) => c.text ?? '').join('\n') ?? body.error ?? '';
    return { status: res.status, text, body };
  }

  beforeAll(async () => {
    const server = new MandrelMcpServer();
    const app = (server as any).healthServer.app as express.Application;
    listener = await new Promise<http.Server>((r) => {
      const l = app.listen(0, () => r(l));
    });
    const a = listener.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'boundary guard')`, [OTHER_PROJECT]);
    // §6 stores a context with NO explicit projectId, so the connection must have CHOSEN a
    // project — otherwise the route never reaches the vector insert whose driver error is
    // the whole subject, and the response carries [AMBIENT_PROJECT_FALLBACK] instead of
    // [DATASTORE_ERROR]. Which project is irrelevant to both §5 and §6;
    // that it is DECIDED, rather than being whichever row `ORDER BY updated_at DESC` put
    // first, is the point.
    await bindConnectionToProject(CONN, OTHER_PROJECT);
    projectNames = (await db.query(`SELECT name FROM projects`)).rows.map((r: { name: string }) => r.name);
  }, 60000);

  afterAll(async () => {
    try {
      await db.query(`DELETE FROM projects WHERE name = $1`, [OTHER_PROJECT]);
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => listener?.close(() => r()));
  });

  // ===================================================================================
  // §5 NO ENUMERATION — an unresolved project must not hand back a directory listing.
  //     Reported shape: `Project 'X' not found. Available projects: Personal Project`.
  // ===================================================================================
  describe('§5 an unresolved project names ONLY what the caller supplied', () => {
    const UNKNOWN = `NoSuchProject${STAMP}`;

    for (const [tool, args] of [
      ['session_list', { project: UNKNOWN }],
      ['session_start', { project: UNKNOWN }],
      ['context_search', { query: 'x', projectId: UNKNOWN }],
      ['task_list', { projectId: UNKNOWN }],
      ['task_progress_summary', { projectId: UNKNOWN }],
      ['context_get_recent', { projectId: UNKNOWN }],
    ] as Array<[string, Record<string, unknown>]>) {
      test(`${tool} leaks no project name the caller did not supply`, async () => {
        const r = await post(tool, args);
        // It DOES echo the caller's own value — that is the actionable part, and it is
        // information the caller already had.
        expect(r.text).toContain(UNKNOWN);

        // The population checked is EVERY project name that exists in the DB right now —
        // read from the DB, not hand-listed, so a new project cannot escape the check.
        expect(projectNames.length, 'no projects in DB — this assertion would be vacuous').toBeGreaterThan(0);
        expect(projectNames).toContain(OTHER_PROJECT);
        for (const name of projectNames) {
          if (name === UNKNOWN) continue;
          expect(r.text, `${tool} ENUMERATED project '${name}' to a caller who never named it`).not.toContain(name);
        }
        // and the shape of the reported defect specifically
        expect(r.text).not.toMatch(/Available projects:/i);
      });
    }
  });

  // ===================================================================================
  // §6 A DB FAULT REACHING A TOOL RESPONSE IS REDACTED, END TO END.
  //     The trigger is a REAL one: an embedder whose dimension does not match the vector
  //     column (a genuine prod misconfiguration — swap embedders without re-indexing).
  //     This is the exact fault that produced the measured leak
  //     `❌ Error: Context storage failed: expected 1536 dimensions, not 768`.
  // ===================================================================================
  describe('§6 a DB fault surfaced by a tool carries the typed code, not the driver text', () => {
    test('context_store with a dimension-mismatched embedding returns [DATASTORE_ERROR]', async () => {
      const embedding = await import('../services/embedding.js');
      const spy = vi
        .spyOn(embedding.embeddingService, 'generateEmbedding')
        .mockResolvedValue({ embedding: new Array(7).fill(0.01), dimensions: 7, model: 'boundary-probe' } as never);
      try {
        const r = await post('context_store', { content: `boundary probe ${STAMP}`, type: 'code' });
        expect(r.text).toContain(DATASTORE_ERROR_CODE);
        expect(r.text).toMatch(/ref: [0-9a-f]{8}/);
        // the driver's own words, in every shape it uses for this fault
        expect(r.text).not.toMatch(/expected \d+ dimensions/i);
        expect(r.text).not.toMatch(/\bvector\b/i);
        expect(r.text).not.toMatch(/invalid input syntax|does not exist|violates .* constraint/i);
      } finally {
        spy.mockRestore();
      }
    }, 30000);
  });
});
