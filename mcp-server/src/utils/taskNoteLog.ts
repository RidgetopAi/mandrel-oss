/**
 * APPEND-ONLY jsonb LOGS on `tasks.metadata`.
 *
 * THE ASYMMETRY THIS CLOSES: `task_update`'s own contract already said of `metadata`
 * — "MERGED (shallow). Set a key to null to DELETE it; omitted keys are preserved (no
 * silent data loss)". Someone thought carefully about silent data loss, wrote a merge
 * semantic to prevent it, and left `description` as an unguarded full replace three lines
 * away. These helpers give the two remaining paths the same property: a note APPENDS
 * rather than replacing, and a replaced description is PRESERVED rather than destroyed.
 *
 * WHY SQL AND NOT READ-MODIFY-WRITE: the same reason `metadataMergeSql` exists. Reading
 * the array in JS, pushing, and writing it back loses a concurrent note under any
 * interleaving. These build ONE expression evaluated inside the UPDATE.
 *
 * COMPOSABILITY IS THE POINT. Each helper takes `innerExpr` — the jsonb expression the
 * column should have BEFORE this append — and references it EXACTLY ONCE, so the callers
 * can nest them (`metadataMergeSql` -> note append -> description history) and still emit
 * a SINGLE `metadata = ...` assignment. Two assignments to one column is a Postgres error,
 * and the bulk path already carries a comment recording that as a latent bug.
 */

/** One entry in the append-only note log. */
export interface TaskNoteEntry {
  /** ISO-8601 instant the note was recorded. */
  at: string;
  /** Who recorded it. `null` when the caller supplied no actor — never invented. */
  actor: string | null;
  /** The note text, verbatim. */
  note: string;
}

/** One superseded description, preserved so a replace is recoverable. */
export interface TaskDescriptionHistoryEntry {
  /** ISO-8601 instant the replacement happened. */
  at: string;
  /** Who replaced it. `null` when the caller supplied no actor. */
  actor: string | null;
  /** The description text that was REPLACED — i.e. what would otherwise be gone. */
  description: string;
}

/**
 * Build `{ expr, params }` appending the entries produced by `entriesExpr` to
 * `<innerExpr>->key`, keeping at most `maxEntries` (oldest fall off first), and leaving
 * every other key untouched.
 *
 * `innerExpr` and `entriesExpr` are trusted SQL expressions and are INTERPOLATED, so
 * neither may be caller-controlled. Each is referenced EXACTLY ONCE, so their own bound
 * params are emitted once and the helpers nest cleanly.
 *
 * WHY `entriesExpr` IS AN EXPRESSION AND NOT A VALUE: the description-history entry has to
 * carry the description being REPLACED, and inside an UPDATE's SET clause a bare column
 * reference yields the OLD row. Reading it in a prior statement would be the same
 * read-modify-write race these helpers exist to avoid.
 *
 * AN EMPTY `entriesExpr` IS A NO-OP: if it yields `[]`, the object comes back untouched
 * and the key is NOT created. That is what lets the description-history call site decline
 * to record (nothing was destroyed) without emitting a second, conditional SET clause.
 *
 * @param innerExpr   trusted jsonb expression (e.g. `metadata`, or a merge expression)
 * @param key         the metadata key holding the array — trusted literal, from config
 * @param entriesExpr trusted SQL expression yielding a jsonb ARRAY of entries to append
 * @param maxParamIdx 1-based index of the ONE param this emits (the retention bound)
 * @param maxEntries  retention bound, bound as `$maxParamIdx::int`
 */
export function appendJsonbLogSql(
  innerExpr: string,
  key: string,
  entriesExpr: string,
  maxParamIdx: number,
  maxEntries: number,
): { expr: string; params: any[] } {
  // `key` is a config constant, not user input, but it still travels into a jsonb path
  // literal — so refuse anything that is not a plain identifier rather than trusting the
  // call site to keep it that way.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`appendJsonbLogSql: unsafe metadata key ${JSON.stringify(key)}`);
  }

  // `src` evaluates innerExpr and entriesExpr ONCE each. `grown` is the concatenation;
  // WITH ORDINALITY + the `i > offset` predicate keeps the LAST maxEntries elements in
  // their original order. A pre-existing NON-array value under `key` is treated as an
  // empty log rather than a crash — it cannot be appended to, and refusing the whole
  // update over it would make the affordance fail on exactly the records that need it.
  const expr = `(
    SELECT CASE WHEN jsonb_array_length(src.fresh) = 0 THEN src.m ELSE jsonb_set(
      src.m,
      '{${key}}',
      (
        SELECT COALESCE(jsonb_agg(e.v ORDER BY e.i), '[]'::jsonb)
        FROM jsonb_array_elements(src.grown) WITH ORDINALITY AS e(v, i)
        WHERE e.i > GREATEST(0, jsonb_array_length(src.grown) - $${maxParamIdx}::int)
      ),
      true
    ) END
    FROM (
      SELECT base.m AS m,
             base.fresh AS fresh,
             (CASE WHEN jsonb_typeof(base.m->'${key}') = 'array'
                   THEN base.m->'${key}'
                   ELSE '[]'::jsonb END) || base.fresh AS grown
      FROM (
        SELECT COALESCE(${innerExpr}, '{}'::jsonb) AS m,
               COALESCE(${entriesExpr}, '[]'::jsonb) AS fresh
      ) AS base
    ) AS src
  )`;

  return { expr, params: [maxEntries] };
}
