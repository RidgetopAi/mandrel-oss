/**
 * DATASTORE ERROR BOUNDARY.
 *
 * THE CLASS THIS FIXES — "internal error text is the default caller-facing text."
 *
 * Every MCP tool response for a failure is built by `utils/mcpFormatter.formatMcpError`,
 * which sanitizes a DENYLIST of known-sensitive SHAPES (connection URIs, key=value
 * secrets, absolute paths, stack frames) and then forwards whatever is left VERBATIM.
 * A denylist is the wrong default for this: anything the driver says that is not on the
 * list is published to the caller. Measured on `1943293` at the real HTTP surface, a
 * pgvector fault reached an MCP caller as:
 *
 *     ❌ Error: Context storage failed: expected 1536 dimensions, not 768
 *
 * — the column's vector width, handed out in an error message. The historical instances
 * were the same mechanism: `invalid input syntax for type uuid: "<the caller's string>"`
 * (column type + backing store + input echo), `value too long for type character
 * varying(200)` (column width), `insert or update on table "contexts" violates foreign
 * key constraint` (table + constraint names), `duplicate key value violates unique
 * constraint "tasks_pkey"` (index name).
 *
 * Each of those was fixed ONE AT A TIME, upstream, by making that particular bad input
 * unreachable — and each fix left behind a test grepping for that ONE string
 * (taskCreateDependencyResolution, decisionSupersededByShortId, projectArgNormalizer,
 * taskCreateLongDescription, contextStoreDanglingSession, sessionAnalyticsUuidGuard,
 * sessionCreateRace: seven files, seven known-bad strings). That is the decorative form
 * of the guard — it can only ever catch the leak that already happened. The leaks it
 * cannot catch are the ones nobody has triggered yet: a statement timeout, a deadlock,
 * connection-slot exhaustion (SQLSTATE 53300), `could not extend file "base/…"` on a full
 * disk — every one of which is reachable in production on inputs that are perfectly valid.
 *
 * THE CHOKE POINT. Every Postgres driver error in this server escapes through one of three
 * doorways, and `guardPool()` closes all three:
 *   1. `Pool.query(...)`             — BOTH overloads (promise AND callback; see wrapQuery)
 *   2. `PoolClient.query(...)`       — same wrapper, same both-overloads treatment
 *   3. the client itself             — from `connect()` (both overloads) AND from the
 *                                      `'connect'` EVENT, which hands out a raw client
 *                                      without going through `connect()` at all
 * A driver error is converted to a `DatastoreError` before any handler can see it. That is
 * what makes leakage unreachable rather than unlikely: the 332 `db.query` / `pool.query` /
 * `client.query` call sites are not trusted to be careful, and the 60
 * `formatMcpError(error, …)` catch blocks that interpolate `err.message` cannot leak what
 * was never handed to them.
 *
 * BOTH OVERLOADS AND ALL THREE DOORWAYS ARE STATED HERE BECAUSE THE FIRST VERSION OF THIS
 * FILE GOT IT WRONG. It closed doorway 3 with a careful both-forms `connect`, and doorways
 * 1 and 2 with a rejection-only wrapper — so `pool.query(sql, cb)` leaked raw driver text
 * while the suite was GREEN, because §1 of the guard only ever exercised await-form calls.
 * Correct work, one doorway over: the same shape this whole task exists to close. If you
 * widen this sentence, widen the guard in the same commit.
 *
 * A handler that does
 * `catch (e) { throw new Error('X failed: ' + e.message) }` — the exact shape that
 * produced the measured pgvector leak — now produces
 * `X failed: [DATASTORE_ERROR] … (ref: 1a2b3c4d)`, which is safe, still actionable, and
 * correlates to the full raw detail in the server log.
 *
 * WHY NOT CLASSIFY THE ERROR. There is deliberately NO test here for "is this a pg error"
 * — no `severity`/`routine` shape check, no message pattern, no SQLSTATE list. Anything
 * thrown out of `pool.query()` is a datastore fault BY POSITION, whatever its shape; a
 * connection-level failure from the Pool itself carries none of the `DatabaseError`
 * fields and would have been missed by every shape check. Position is the property that
 * cannot rot (CLASSES.md C3: anchor on the choke point, not on the shapes you had in mind).
 *
 * DIAGNOSTICS ARE NOT LOST — that is the other half of the acceptance. The raw error is
 * written to the server log at ERROR level with the ref, the SQLSTATE, and the statement
 * that failed, and is kept on the DatastoreError as a NON-ENUMERABLE `internal` property
 * so `JSON.stringify`, object spread and structuredContent cannot re-publish it, while a
 * debugger and the log still have everything.
 */

import type { Pool, PoolClient } from 'pg';
import { logger } from './logger.js';

/**
 * The typed code that prefixes every caller-facing datastore failure. Follows the
 * `[SCREAMING_SNAKE]` convention established by `[PROJECT_ARG_UNRESOLVED]`:
 * a stable token a client can branch on, that says nothing about internals.
 */
export const DATASTORE_ERROR_CODE = '[DATASTORE_ERROR]';

/** Marker property set on every redacted error. Read by the guard test, not by product code. */
export const DATASTORE_ERROR_MARKER = 'isDatastoreError' as const;

/**
 * The caller-facing text. Deliberately says only: (1) WHAT happened at the coarsest safe
 * grain, (2) that it is NOT the caller's arguments — so a model does not burn retries
 * mutating its input — and (3) the ref to quote. It names no table, column, type,
 * constraint, index, statement, host, path or engine.
 */
export function datastoreErrorText(ref: string): string {
  // THE 💡 IS LOAD-BEARING, not decoration. `utils/actionableError.ts::actionableErrorText`
  // appends a STANDING generic suffix — "If this looks like a bad argument, re-check the
  // tool's parameters" — to any message that does not already carry a 💡/📌 hint. Without
  // the marker, a caller received this text and that suffix in the SAME response: "not a
  // problem with the arguments you sent" immediately followed by "re-check your arguments."
  // Contradictory guidance, and a model burning retries mutating its own correct input is
  // precisely what this wording exists to prevent. The marker suppresses the generic suffix
  // so the ONE piece of advice that is true for a datastore fault is the only one given.
  // (Measured in the pre-fix caller-facing capture, reports/2d383cc2-…/2d383cc2-after5.json.)
  return (
    `${DATASTORE_ERROR_CODE} A database operation could not be completed (ref: ${ref}). ` +
    `This is a server-side fault, not a problem with the arguments you sent — re-sending ` +
    `the same call is reasonable.` +
    `\n\n💡 Do not change your arguments; they are not what failed. Retry once, and if it ` +
    `persists quote ref ${ref} to an operator — the full diagnostic detail is in the server ` +
    `log under that ref.`
  );
}

/**
 * A datastore failure, redacted for the caller.
 *
 * `message` is caller-safe. Everything that is not is on `internal`, which is defined
 * NON-ENUMERABLE precisely so the three mechanisms that would otherwise republish it —
 * `JSON.stringify(err)`, `{ ...err }`, and the structuredContent channel in
 * `routes/index.ts` — cannot see it.
 */
export class DatastoreError extends Error {
  readonly name = 'DatastoreError';
  /** Correlation id, also embedded in `message` and in the server log line. */
  readonly ref: string;
  /**
   * SQLSTATE (e.g. '23505'), preserved for control flow and for
   * `utils/mcpErrorStatus.ts`, which treats a STRING code as unclassified → HTTP 500.
   * Preserving it keeps the status mapping byte-for-byte what it was. It is a property,
   * never interpolated into `message`.
   */
  readonly code?: string;
  /**
   * The violated constraint's name, when Postgres supplied one. Like `code`, a PROPERTY
   * that existing DB-enforcement tests read to pin a failure to a SPECIFIC constraint
   * rather than accepting a bare "it threw" — never interpolated into `message`, and
   * non-enumerable so no serializer can republish it.
   */
  readonly constraint?: string;
  /** The original error + statement. NON-ENUMERABLE (see class doc). */
  readonly internal!: { cause: unknown; sql?: string };

  constructor(ref: string, cause: unknown, sql?: string) {
    super(datastoreErrorText(ref));
    this.ref = ref;
    const c = cause as { code?: unknown; constraint?: unknown } | null | undefined;
    // NON-ENUMERABLE on purpose: a constraint/index name is a schema detail. Readable by
    // product code and tests, invisible to `JSON.stringify` / spread / structuredContent.
    Object.defineProperty(this, 'code', {
      value: typeof c?.code === 'string' ? c.code : undefined,
      enumerable: false,
    });
    Object.defineProperty(this, 'constraint', {
      value: typeof c?.constraint === 'string' ? c.constraint : undefined,
      enumerable: false,
    });
    Object.defineProperty(this, 'internal', {
      value: { cause, sql },
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(this, DATASTORE_ERROR_MARKER, {
      value: true,
      enumerable: false,
      writable: false,
    });
  }
}

/** True iff `e` is a DatastoreError. Structural, so it survives a module-registry split. */
export function isDatastoreError(e: unknown): e is DatastoreError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Record<string, unknown>)[DATASTORE_ERROR_MARKER] === true
  );
}

/**
 * THE CO-LOCATED ESCAPE (a past incident / CLASSES.md C3 corollary: "when you widen a
 * population, check what you just made illegal").
 *
 * Installing this boundary broke FOUR existing, CORRECT tests — `taskAtomicClaim`
 * ("the audit log is IMMUTABLE — an UPDATE is refused by the database"),
 * `reaperClockDomainFloor` ("the poisoned fixture is genuinely poisoned"),
 * `sessionCreationReasonContract` ("the DENY actually bites"), and `projectInsights`
 * ("renaming `tasks` away makes the tool ERROR"). Each asserts that POSTGRES ITSELF
 * enforced something, and each read the driver's own words to prove it. Redacting the
 * message did not make them wrong; it took away their instrument.
 *
 * A guard that forbids legitimate work gets deleted the first time it is inconvenient,
 * which is worse than the hole it closed. So: a NAMED accessor for the raw text, whose
 * name says out loud that what it returns is NOT caller-safe. Product code must never put
 * this into a response; a test or a diagnostic asserting on the datastore's own behaviour
 * is exactly what it is for. Deliberately NOT a central allow-list, and NOT a narrowing of
 * the guard — the caller-facing path is untouched by it.
 */
export function rawDatastoreMessage(e: unknown): string {
  if (!isDatastoreError(e)) return e instanceof Error ? e.message : String(e);
  const cause = e.internal.cause;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Short correlation id: 8 hex chars, monotonic counter + per-process entropy so two refs in
 * one process can never collide and two processes practically never do.
 *
 * DELIBERATELY NOT `crypto.randomBytes`. This module is imported by `config/database.ts`,
 * which almost every test file loads — and eight test files `vi.mock('crypto')` with a
 * PARTIAL mock. A module-scope `import { randomBytes } from 'crypto'` here therefore
 * detonated in files that had nothing to do with this change ("No 'randomBytes' export is
 * defined on the 'crypto' mock"), taking 7 unrelated assertions RED. Measured, not guessed.
 * A correlation ref needs to be unique and greppable, not unguessable — it is emitted to
 * the caller precisely so they can quote it — so there is no security property to lose.
 */
let refCounter = 0;
const REF_SALT = Math.floor(Math.random() * 0xffff);
function newRef(): string {
  refCounter = (refCounter + 1) & 0xffff;
  return (REF_SALT.toString(16).padStart(4, '0') + refCounter.toString(16).padStart(4, '0'));
}

/**
 * Convert ANY thrown value from the DB boundary into a caller-safe DatastoreError,
 * logging the raw detail server-side first.
 *
 * Idempotent: a DatastoreError passed back in is returned unchanged, so a nested
 * boundary (a `client.query` inside a wrapped `pool.query`) cannot double-wrap or
 * double-log.
 */
export function redactDatastoreError(cause: unknown, sql?: string): DatastoreError {
  if (isDatastoreError(cause)) return cause;
  const ref = newRef();
  const c = cause as { code?: unknown; message?: unknown } | null | undefined;
  logger.error(
    `${DATASTORE_ERROR_CODE} datastore failure ref=${ref} — RAW DETAIL (server-side only; ` +
      `the caller received the redacted form)`,
    cause instanceof Error ? cause : new Error(String(cause)),
    {
      component: 'DATABASE',
      operation: 'query',
      metadata: {
        ref,
        sqlstate: typeof c?.code === 'string' ? c.code : undefined,
        rawMessage: typeof c?.message === 'string' ? c.message : String(cause),
        sql,
      },
    },
  );
  return new DatastoreError(ref, cause, sql);
}

/**
 * Counter name for pool-level (connection-level) datastore errors. Read in tests via
 * `monitoring.getLatestMetric(DATASTORE_POOL_ERROR_COUNTER)`.
 */
export const DATASTORE_POOL_ERROR_COUNTER = 'datastore_pool_errors_total';

/**
 * THE POOL-LEVEL ERROR HANDLER (an earlier task — a P0 that killed prod).
 *
 * WHAT IT PREVENTS, measured: on 2026-08-12 at 10:14:50Z an unattended host upgrade restarted
 * `postgresql@16-main`. Postgres closed every open connection with SQLSTATE 57P01
 * ("terminating connection due to administrator command"). `pg` re-emits an IDLE pooled
 * client's socket error ON THE POOL (`pg-pool/index.js` `makeIdleListener`), and an
 * EventEmitter with ZERO `'error'` listeners RETHROWS — so it arrived as an
 * `uncaughtException` with no product frame in its stack, and `utils/processLock.ts`'s handler
 * did `process.exit(1)`. The MCP server killed itself over a routine 2-second database restart.
 *
 * NOT A SILENT CATCH. Swallowing a connection fault quietly would be a worse bug than the
 * crash, because the crash was at least loud. So this handler does BOTH halves:
 *   (1) logs at ERROR level with the SQLSTATE and the raw driver message, and
 *   (2) increments a counter through `utils/monitoring.ts` — the mechanism this codebase
 *       already uses for exactly this (see utils/sessionObservability.ts).
 *
 * THE LOG IS THE SIGNAL; THE COUNTER IS NOT ALERTABLE YET. `monitoring` is an in-memory Map
 * capped at `maxMetricHistory`, and there is no /metrics endpoint or exporter in mcp-server.
 * So in production the externally visible evidence of a pool fault is the ERROR line above,
 * and nothing else. Do not let "we have a counter for it" become an argument that this is
 * monitored — wire an exporter first if you want to alert on it.
 *
 * WHY `monitoring` IS IMPORTED LAZILY AND NOT AT MODULE SCOPE. Historically this was load-
 * bearing: `utils/monitoring.ts` started three uncleared `setInterval`s as an IMPORT-TIME side
 * effect, one of which did `db.query('SELECT 1')` every 60s, so a static import here — in a
 * module `config/database.ts` loads — started those timers in nearly every test process. an earlier Task
 * and the explicit-start change removed that: starting is now an explicit `startMonitoring()` call made
 * by `services/backgroundServices.ts`, and the timers are unref'd. The lazy import is kept
 * anyway because this module sits under `config/database.ts` and the counter is only ever
 * needed on a pool fault, so there is no reason to widen that graph; it is now a preference,
 * not a workaround.
 *
 * THE POOL REMAINS USABLE — this is why "log and continue" is correct rather than a papered-over
 * fault. `pg-pool`'s `makeIdleListener` calls `pool._remove(client)` BEFORE it emits, so the
 * broken connection is already gone from the pool by the time this runs; the next acquire opens
 * a fresh one. Verified behaviourally, not from reading alone: the contract test bounces real
 * backends and then serves a real query on the same pool object.
 */
function onPoolError(err: unknown): void {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const sqlstate = typeof e?.code === 'string' ? e.code : undefined;
  const rawMessage = typeof e?.message === 'string' ? e.message : String(err);
  logger.error(
    `${DATASTORE_ERROR_CODE} pool-level connection failure (sqlstate=${sqlstate ?? 'none'}): ` +
      `${rawMessage} — the affected connection was discarded by the pool; the pool stays usable ` +
      `and the process survives`,
    err instanceof Error ? err : new Error(rawMessage),
    {
      component: 'DATABASE',
      operation: 'pool_error',
      metadata: { sqlstate, rawMessage },
    },
  );
  // Fire-and-forget: counting must never be able to take the process down, which is the whole
  // point of this handler. The log line above has already recorded the fault either way.
  void import('./monitoring.js')
    .then(({ monitoring }) =>
      monitoring.incrementCounter(DATASTORE_POOL_ERROR_COUNTER, { sqlstate: sqlstate ?? 'none' }),
    )
    .catch(() => {});
}

/** Best-effort statement text for the LOG (never for the caller). */
function sqlOf(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null) {
    const t = (first as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return undefined;
}

/**
 * Install the boundary on a `pg` Pool, IN PLACE.
 *
 * Wraps `query` (the direct path) and `connect` (so every `PoolClient.query` a caller
 * obtains is wrapped too — that is the second doorway, used by all the transactional
 * code in handlers/tasks.ts, SessionRepo, …).
 *
 * Idempotent: guarding an already-guarded pool is a no-op, so module re-evaluation
 * (vitest re-imports the config module per test file) cannot stack wrappers.
 *
 * Returns the same object it was given, so it can be used inline at the export site.
 */
/**
 * Wrap ONE checked-out client's `query`, in place and idempotently. A client is recycled
 * by the pool, so it can be handed out many times — the marker stops the wrapper stacking.
 */
/**
 * THE ONE query() WRAPPER, used for BOTH `Pool.query` and `PoolClient.query`.
 *
 * IT IS ONE FUNCTION ON PURPOSE. The first version of this file hand-wrote the pool wrapper
 * and the client wrapper separately, and gave `connect` a careful both-overloads treatment
 * that neither `query` wrapper got — so the CALLBACK overload of `query` walked straight
 * past the boundary while `connect` was airtight. Measured by the reviewer on a real DB:
 *
 *     pool.query(text, cb)     isDatastoreError=false   syntax error at or near "SELEKT"
 *     await pool.query(text)   isDatastoreError=true    [DATASTORE_ERROR] … (ref: 6f…)
 *     client.query(text, cb)   isDatastoreError=false   syntax error at or near "SELEKT"
 *
 * That is the same failure this whole task exists to close — correct work, one doorway over
 * — reproduced INSIDE the fix for it. Two copies of a rule can be weakened in one without
 * the other noticing (CLASSES.md C3). So there is now exactly one copy, applied twice.
 *
 * BOTH OVERLOADS, because `pg` supports both and they fail DIFFERENTLY:
 *   * promise form  — rejects. Intercept the rejection (and a synchronous throw).
 *   * callback form — does NOT reject. It hands the raw driver error to the callback and
 *     returns undefined. Intercepting the rejection is a no-op here; the callback's `err`
 *     is what has to be redacted.
 */
function wrapQuery(original: (...a: unknown[]) => unknown) {
  return function guardedQuery(...args: unknown[]): unknown {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const cb = last as (err: unknown, res?: unknown) => void;
      const head = args.slice(0, -1);
      return original(...head, (err: unknown, res: unknown) => {
        if (err) return cb(redactDatastoreError(err, sqlOf(args)));
        return cb(err, res);
      });
    }
    // Promise form. The try/catch covers a SYNCHRONOUS throw from `query()` (bad arguments
    // reach `pg`'s own validation before any I/O), which a bare `.catch()` would miss.
    try {
      return Promise.resolve(original(...args) as Promise<unknown>).catch((e) => {
        throw redactDatastoreError(e, sqlOf(args));
      });
    } catch (e) {
      return Promise.reject(redactDatastoreError(e, sqlOf(args)));
    }
  };
}

function guardClient(client: PoolClient): void {
  const c = client as unknown as Record<string, unknown>;
  if (c.__mandrelDatastoreGuarded === true) return;
  c.query = wrapQuery(client.query.bind(client) as (...a: unknown[]) => unknown);
  c.__mandrelDatastoreGuarded = true;
}

export function guardPool<T extends Pool>(pool: T): T {
  const target = pool as unknown as Record<string, unknown>;
  if (target.__mandrelDatastoreGuarded === true) return pool;

  const originalQuery = pool.query.bind(pool) as (...a: unknown[]) => unknown;
  const originalConnect = pool.connect.bind(pool) as () => Promise<PoolClient>;

  // THE SECOND DOORWAY OUT OF A POOL, closed by measurement rather than by reasoning.
  // `pool.on('connect', cb)` hands the listener the RAW `PoolClient` — it does not go through
  // `connect()`, so wrapping `connect()` alone leaves it unwrapped. There are three such
  // listeners in src/ today (config/database.ts:148 sets ivfflat.probes; databasePool.ts
  // registers 'connect' and 'acquire') and all three only log server-side, so nothing leaks
  // TODAY — but "today" is not a guarantee, and the next listener someone adds would inherit
  // a raw client silently. Registering OUR listener here, at construction, means ours runs
  // first (pg dispatches in registration order) and every client is guarded at birth.
  pool.on('connect', (client) => guardClient(client as unknown as PoolClient));

  // THE FOURTH DOORWAY, and the only one that is about SURVIVAL rather than REDACTION.
  // A connection can fail while NO caller is holding it, so it escapes through neither
  // `query` nor `connect` — `pg` emits it on the Pool, and with no listener that is a fatal
  // uncaughtException. See onPoolError above for the incident and for why the handler logs
  // AND counts instead of swallowing. Installed here, at the one construction wrapper, so
  // every guarded pool in the process gets it — `services/databasePool.ts` had one of these
  // and `config/database.ts` did not, which is the one-copy-weakened-not-the-other shape
  // (CLASSES.md C3). databasePool's own listener still runs after this one; two listeners are
  // additive, and either one alone is enough to stop the rethrow.
  pool.on('error', onPoolError);

  target.query = wrapQuery(originalQuery);

  // `connect` MUST support BOTH of its forms. The promise form is what product code calls;
  // the CALLBACK form is what `pg`'s own `Pool.prototype.query` calls internally
  // (pg-pool/index.js: `this.connect((err, client) => …)`). An async-only override silently
  // breaks every `pool.query()` in the process — measured: the whole probe suite hung to its
  // 120s timeout on the first attempt at this. Forward the arguments; intercept only the
  // outcome.
  target.connect = function guardedConnect(...args: unknown[]) {
    const cb = typeof args[0] === 'function' ? (args[0] as (e: unknown, c?: PoolClient) => void) : undefined;
    if (cb) {
      return (originalConnect as unknown as (f: (e: unknown, c?: PoolClient) => void) => void)(
        (err, client) => {
          if (err) return cb(redactDatastoreError(err));
          if (client) guardClient(client);
          return cb(err, client);
        },
      );
    }
    return originalConnect().then(
      (client) => {
        guardClient(client);
        return client;
      },
      (e) => {
        // Acquisition failures (pool exhaustion, SQLSTATE 53300, connection refused) are
        // datastore faults too and were previously forwarded verbatim.
        throw redactDatastoreError(e);
      },
    );
  };

  target.__mandrelDatastoreGuarded = true;
  return pool;
}
