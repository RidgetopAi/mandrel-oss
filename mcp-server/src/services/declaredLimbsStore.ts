/**
 * DECLARED LIMBS — the STORAGE half: resolve against the live corpus, write the column.
 * BRANCH-1 (an earlier decision Phase 1).
 *
 * The RULE lives in declaredLimbs.ts and is pure (no database, no logger), so the golden
 * parity test can replay it against the measured population. Everything that touches the
 * database is here. Nothing in this file decides what a limb is.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { DECLARED_LIMBS_CONFIG } from '../config/declaredLimbsConfig.js';
import {
  buildId8Resolver,
  collectNamedId8s,
  composeLimbBody,
  deriveDeclaredLimbs,
  type DerivedLimbs,
  type LimbResolvableType,
  type LimbSourceRecord,
} from './declaredLimbs.js';

/**
 * Record type → its table. A const map, never a caller-supplied string: the table name is
 * interpolated into SQL, so it must be impossible for it to originate outside this file.
 */
export const LIMB_TABLES: Readonly<Record<LimbResolvableType, string>> = {
  context: 'contexts',
  task: 'tasks',
  decision: 'technical_decisions',
};

/**
 * Load the rows needed to resolve `id8s`, across EVERY project.
 *
 * Deliberately NOT project-scoped, and this is the one place it matters. The measured rule
 * resolved against the whole node table (`hierarchy.py` builds its `by8` index from every
 * node), so a project filter here would be a different rule than the one evaluated. It is
 * also the conservative direction: a wider population can only turn a resolution into an
 * AMBIGUOUS DROP, never into a wrong limb.
 */
export async function loadId8Rows(
  id8s: readonly string[],
  pool: Pool = db
): Promise<Array<{ id: string; type: LimbResolvableType }>> {
  if (id8s.length === 0) return [];
  const sql = `
    SELECT id::text AS id, 'task'::text AS type     FROM tasks               WHERE left(id::text, 8) = ANY($1::text[])
    UNION ALL
    SELECT id::text,        'decision'::text        FROM technical_decisions WHERE left(id::text, 8) = ANY($1::text[])
    UNION ALL
    SELECT id::text,        'context'::text         FROM contexts            WHERE left(id::text, 8) = ANY($1::text[])
  `;
  const res = await pool.query(sql, [Array.from(new Set(id8s))]);
  return res.rows.map(r => ({ id: r.id, type: r.type as LimbResolvableType }));
}

/**
 * Read back the MATERIALISED limb sets for a set of records (BRANCH-2).
 *
 * Lives here rather than in the terminality service so that every statement touching a
 * `declared_limbs` column is in the one file that owns that column — the same reason
 * `LIMB_TABLES` is a const map and never a caller-supplied string.
 *
 * THE RETURN TYPE CARRIES THE THIRD STATE, and callers must not flatten it:
 *   `string[]`  — the column was derived (possibly to the empty array: "declares nothing")
 *   `null`      — the column is NULL (never derived) OR the id is not in this table at all
 * Both of those are "we cannot say what this record names", which is a different fact from
 * "it names nothing" and is what services/threadTerminality.ts branches on separately.
 *
 * Ids are bound as uuid[] PARAMETERS; only the table name is interpolated, and only from
 * LIMB_TABLES.
 */
export async function loadDeclaredLimbs(
  refs: ReadonlyArray<{ id: string; type: LimbResolvableType }>,
  pool: Pool = db
): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  if (refs.length === 0) return out;

  const byType = new Map<LimbResolvableType, string[]>();
  for (const ref of refs) {
    const bucket = byType.get(ref.type);
    if (bucket) bucket.push(ref.id);
    else byType.set(ref.type, [ref.id]);
  }

  for (const [type, ids] of byType) {
    const res = await pool.query(
      `SELECT id::text AS id, declared_limbs FROM ${LIMB_TABLES[type]} WHERE id = ANY($1::uuid[])`,
      [Array.from(new Set(ids))]
    );
    for (const row of res.rows) {
      out.set(row.id, row.declared_limbs === null ? null : (row.declared_limbs as string[]));
    }
  }
  return out;
}

/**
 * Derive a record's limbs against the live database and STORE them on the row.
 *
 * DEGRADES, NEVER FAILS THE WRITE: a resolution error leaves `declared_limbs` untouched
 * (NULL on a fresh row = not-derived, which the backfill closes) and is logged. The user's
 * record is already committed; losing it over a materialised index would be the wrong trade.
 */
export async function deriveAndPersistDeclaredLimbs(
  rec: LimbSourceRecord,
  pool: Pool = db
): Promise<DerivedLimbs | null> {
  if (!DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled) return null;
  try {
    const { tagId8s, bodyId8s } = collectNamedId8s(rec);
    const rows = await loadId8Rows([...tagId8s, ...bodyId8s], pool);
    const derived = deriveDeclaredLimbs(rec, buildId8Resolver(rows));
    await pool.query(
      `UPDATE ${LIMB_TABLES[rec.type]}
          SET declared_limbs = $1::uuid[],
              declared_limbs_ambiguous_drops = $2
        WHERE id = $3`,
      [derived.limbs, derived.ambiguousDrops, rec.id]
    );
    if (derived.ambiguousDrops > 0) {
      logger.warn(
        `🌿 declared limbs: dropped ${derived.ambiguousDrops} ambiguous id8 mention(s) on ${rec.type} ${rec.id.substring(0, 8)}`,
        {
          metadata: {
            recordId: rec.id,
            recordType: rec.type,
            ambiguousDrops: derived.ambiguousDrops,
          },
        }
      );
    }
    return derived;
  } catch (error) {
    logger.error(
      `🌿 declared limbs: derivation failed for ${rec.type} ${rec.id}; row left NOT-DERIVED (the backfill closes it)`,
      error as Error
    );
    return null;
  }
}

/**
 * THE ONE CALL SITE SHAPE FOR A WRITE PATH: hand it the row the write RETURNed and the
 * record kind, and it composes the body, derives and stores.
 *
 * Every handler calls THIS, not `composeLimbBody` + `deriveAndPersistDeclaredLimbs`
 * separately, so no call site can compose a body differently from any other — the
 * composition is not a decision a caller gets to make.
 *
 * CALLED UNCONDITIONALLY ON CREATE AND ON UPDATE, from the row the write itself returned.
 * Not gated on "did a field that feeds the derivation change": that predicate is an
 * enumeration of columns, and an enumeration is what goes stale the next time one is added,
 * leaving the stored set silently disagreeing with the tags and prose it came from.
 * Re-deriving from the RETURNING row costs one resolve query and makes the drift
 * unreachable rather than merely watched-for.
 */
export async function persistDeclaredLimbsForRow(
  type: LimbResolvableType,
  row: Record<string, any>,
  pool: Pool = db
): Promise<DerivedLimbs | null> {
  return deriveAndPersistDeclaredLimbs(
    {
      id: String(row.id),
      type,
      body: composeLimbBody(type, row),
      tags: row.tags ?? [],
    },
    pool
  );
}

/**
 * THE BATCH SHAPE OF `persistDeclaredLimbsForRow` — same rule, same composition, same
 * degradation, ONE resolver load and ONE update statement for the whole set.
 * (an earlier task.)
 *
 * WHY IT EXISTS: `bulkUpdateTasks` deliberately does its edit as a SINGLE statement, then
 * called the per-row function in a serial loop over the RETURNING rows — 2N round trips
 * (one resolver load + one UPDATE each) bolted onto a call whose whole design point was to
 * be single-statement. Measured on a 300-id bulk against a 14k-record corpus, that made the
 * flag-ON call ~9x the flag-OFF call; the artifacts are on an earlier task.
 *
 * IT IS NOT A SECOND RULE. It calls the SAME `composeLimbBody` + `deriveDeclaredLimbs` the
 * per-row function calls, so a row written through here is byte-identical to the same row
 * written through there. The only difference is the RESOLVER's population: the per-row
 * function loads the id8s ONE record names, this one loads the UNION across the batch. That
 * cannot change a single resolution — `loadId8Rows` filters `left(id,8) = ANY(list)`, so the
 * rows returned for a given id8 are exactly the same whether that id8 travelled alone or in
 * company, and `buildId8Resolver` buckets strictly per id8. This is the same
 * one-resolver-for-the-batch argument `backfillDeclaredLimbs.ts` already rests on.
 *
 * DEGRADES, NEVER FAILS THE WRITE — identical contract to the per-row function: on error
 * the rows are left as they were (NULL = not-derived on a fresh row) and the backfill
 * closes them. Callers run it AFTER COMMIT for that reason. Note the GRANULARITY differs
 * from the per-row function: degradation here is ALL-OR-NOTHING, so one bad row (an invalid
 * uuid, say) leaves the WHOLE batch not-derived where the serial loop would have lost only
 * that row — safe from the only caller, whose ids come straight from its own `RETURNING id`
 * and therefore cannot be malformed, but a caller passing ids from anywhere else owes that
 * check itself.
 *
 * ONE STATEMENT, UNCHUNKED, ON PURPOSE: its only caller is bounded by TASK_BULK_MAX_IDS.
 * A caller with an unbounded row set must chunk before calling.
 *
 * Returns the number of rows written, or null if the kill switch is off / nothing to do.
 */
export async function persistDeclaredLimbsForRows(
  type: LimbResolvableType,
  rows: ReadonlyArray<Record<string, any>>,
  pool: Pool = db
): Promise<number | null> {
  if (!DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled) return null;
  if (rows.length === 0) return null;
  try {
    const recs: LimbSourceRecord[] = rows.map(row => ({
      id: String(row.id),
      type,
      body: composeLimbBody(type, row),
      tags: row.tags ?? [],
    }));

    // ONE resolver load for the whole batch (was: one per row).
    const id8s: string[] = [];
    for (const rec of recs) {
      const { tagId8s, bodyId8s } = collectNamedId8s(rec);
      id8s.push(...tagId8s, ...bodyId8s);
    }
    const resolver = buildId8Resolver(await loadId8Rows(id8s, pool));

    const derived = recs.map(rec => ({ rec, d: deriveDeclaredLimbs(rec, resolver) }));

    // ONE statement for the whole batch (was: one UPDATE per row). Same shape as the
    // backfill: a uuid[] per row cannot be unnested as a 2-D array (Postgres arrays are
    // rectangular), so each row's set travels as its literal text form and is cast.
    const res = await pool.query(
      `UPDATE ${LIMB_TABLES[type]} t
          SET declared_limbs = v.limbs::uuid[],
              declared_limbs_ambiguous_drops = v.drops
         FROM (SELECT unnest($1::uuid[]) AS id,
                      unnest($2::text[]) AS limbs,
                      unnest($3::int[])  AS drops) v
        WHERE t.id = v.id`,
      [
        derived.map(x => x.rec.id),
        derived.map(x => `{${x.d.limbs.join(',')}}`),
        derived.map(x => x.d.ambiguousDrops),
      ]
    );

    // Same warning, per affected row, as the per-row path — an ambiguous drop must be as
    // visible from a bulk write as from a single one.
    for (const { rec, d } of derived) {
      if (d.ambiguousDrops > 0) {
        logger.warn(
          `🌿 declared limbs: dropped ${d.ambiguousDrops} ambiguous id8 mention(s) on ${rec.type} ${rec.id.substring(0, 8)}`,
          {
            metadata: {
              recordId: rec.id,
              recordType: rec.type,
              ambiguousDrops: d.ambiguousDrops,
            },
          }
        );
      }
    }
    return res.rowCount ?? 0;
  } catch (error) {
    logger.error(
      `🌿 declared limbs: batch derivation failed for ${rows.length} ${type} row(s); rows left NOT-DERIVED (the backfill closes it)`,
      error as Error
    );
    return null;
  }
}
