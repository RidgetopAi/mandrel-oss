/**
 * taskColumnPresence — THE ONE COLUMN-PRESENCE PROBE for the `tasks` table.
 *
 * ═══ WHY THIS FILE EXISTS AS A SEPARATE FILE ═══
 * Migration 093 needed a probe so that a fleet roll and a migration run could happen in
 * either order without a window in which new code 500s on a column a database does not have
 * yet (SQLSTATE 42703). It got one, inside services/taskBlockedOnCapability.ts.
 *
 * Migration 098 adds `closed_at` and needs exactly the same thing. Writing a second probe
 * would be two implementations of one rule — the C5 shape this codebase keeps paying for,
 * and the one that produces a cache that is cleared in one place and not the other. So the
 * MECHANISM moved here and both named readers call it. taskBlockedOnCapability.ts keeps its
 * public API byte-for-byte; it is now a caller of this file rather than an owner of a probe.
 *
 * ═══ THREE STATES, NOT TWO (CLASSES.md C1) ═══
 * `present` / `absent` / `unknown`. Any instrument that crosses a process boundary can
 * return "I could not measure", and code that folds that onto one of the first two is the
 * bug — it is worse than a wrong answer because the output still LOOKS measured. The pool
 * can be down, the role can lack `information_schema` visibility, a statement timeout can
 * fire. `unknown` gets its own value here and its own branch in every consumer.
 *
 * ═══ WHY information_schema AND NOT try-the-query-and-catch ═══
 * Catching 42703 would also work and is one fewer round trip. It is rejected because a
 * caught exception inside a transaction ABORTS that transaction in Postgres, and because
 * "the query failed" cannot distinguish a missing column from a missing TABLE, a permission
 * error, or a syntax mistake introduced later. Asking the catalog answers the exact question
 * that was asked.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * The three states an instrument that crosses a process boundary can return.
 * `unknown` is NOT a synonym for `absent` and is never collapsed into it.
 */
export type ColumnPresence = 'present' | 'absent' | 'unknown';

export interface ColumnPresenceReading {
  /** One entry per column NAME asked about. Never partial — every asked name is a key. */
  presence: Record<string, ColumnPresence>;
  /**
   * Why the probe returned `unknown`, verbatim from the driver. Null unless something is
   * `unknown`. Carried as a FIELD so a caller can RENDER the reason rather than inventing
   * one (an earlier decision RULING 6 — the display may only assert what a record carries).
   */
  probeError: string | null;
}

interface CacheEntry {
  value: ColumnPresenceReading;
  readAtMs: number;
}

/**
 * Cached per POOL OBJECT and per COLUMN SET, not globally and not per connection string.
 *
 * PER POOL: a test that hands in its own pool must not read a cache primed by the production
 * pool, and vice versa — that cross-talk is precisely how a "green here" becomes a "red
 * there" (CLASSES.md C4). A WeakMap so a discarded pool's entry is collectable.
 *
 * PER COLUMN SET: this is the property the single-purpose predecessor did not need and this
 * generic one does. Two readers asking about two different column sets share this map, and a
 * cache keyed only by pool would serve the `blocked_on`/`due_at` answer to the `closed_at`
 * question. The key is the SORTED, joined name list, so argument order cannot mint a second
 * entry for the same question.
 */
const cache = new WeakMap<Pool, Map<string, CacheEntry>>();

/** The cache key for a set of column names — sorted, so order is not part of the identity. */
function cacheKey(columns: readonly string[]): string {
  return [...columns].sort().join(',');
}

/**
 * Drop memoized answers for a pool. With `columns`, drops only that question's entry; with
 * none, drops every question's (what a test that has just applied or dropped a migration
 * in-process wants).
 */
export function clearTaskColumnPresenceCache(pool: Pool = db, columns?: readonly string[]): void {
  if (!columns) {
    cache.delete(pool);
    return;
  }
  cache.get(pool)?.delete(cacheKey(columns));
}

/**
 * Which of these columns does `tasks` actually have?
 *
 * NEVER THROWS. A probe that can take the caller down defeats the entire purpose of probing:
 * the caller would have to wrap it in the try/catch this function exists to remove. Every
 * failure path returns every asked column as `unknown`, with the driver's own message in
 * `probeError`.
 *
 * @param ttlMs how long a PRESENT/ABSENT answer may be reused. 0 means probe every call.
 */
export async function readTaskColumnPresence(
  columns: readonly string[],
  pool: Pool = db,
  ttlMs: number,
  nowMs: number = Date.now(),
): Promise<ColumnPresenceReading> {
  const key = cacheKey(columns);
  const hit = cache.get(pool)?.get(key);
  // ttlMs === 0 means "probe every call" and must NOT be reachable through this branch: with
  // `nowMs - readAtMs === 0` on a fast consecutive call, `< 0` is false, so the cache is
  // correctly bypassed. Written as `<` rather than `<=` for exactly that reason.
  if (hit && nowMs - hit.readAtMs < ttlMs) return hit.value;

  try {
    const { rows } = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'tasks'
          AND column_name = ANY($1)`,
      [columns as string[]],
    );
    const found = new Set<string>(rows.map((r: { column_name: string }) => r.column_name));
    const presence: Record<string, ColumnPresence> = {};
    // Iterate the ASKED names, not the returned rows: the caller's question defines the key
    // set, so a column the catalog did not return is `absent` rather than missing from the
    // result. A caller must never have to distinguish "no key" from "absent".
    for (const c of columns) presence[c] = found.has(c) ? 'present' : 'absent';
    const value: ColumnPresenceReading = { presence, probeError: null };
    let perPool = cache.get(pool);
    if (!perPool) {
      perPool = new Map();
      cache.set(pool, perPool);
    }
    perPool.set(key, { value, readAtMs: nowMs });
    return value;
  } catch (e) {
    // THE THIRD STATE. Deliberately NOT CACHED: a cached "I could not measure" would pin an
    // instance into the degraded behaviour for the whole TTL after a single transient blip,
    // and re-probing costs one catalog read. A failure state must never be sticky.
    const message = (e as Error)?.message ?? String(e);
    logger.warn(
      `🔎 tasks column-presence probe COULD NOT MEASURE [${columns.join(', ')}] — consumers ` +
        `will degrade and SAY SO rather than report the columns as absent: ${message}`,
    );
    const presence: Record<string, ColumnPresence> = {};
    for (const c of columns) presence[c] = 'unknown';
    return { presence, probeError: message };
  }
}
