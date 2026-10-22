/**
 * TAG CENSUS — "which tags exist, and how many records carry each".
 *
 * === WHY THIS OP EXISTS ===
 *
 * Tag filtering requires an EXACT value. Before this, nothing on either surface could
 * answer "which tags begin with `invalid-`?" or "which values does the `class:` axis
 * actually carry IN THE DATA (as opposed to which the config ACCEPTS)?". The only route
 * was fetching every record and scanning tags client-side: 6,380 records, 65 HTTP calls,
 * for a question one GROUP BY answers.
 *
 * That absence is why a hand-written list in a handoff was the DEFAULT answer to "which
 * records need re-tagging" — and on 2026-09-04 that list was wrong in both directions at
 * once (it named a tag that has never existed, and missed one that does). A human writing
 * a population from memory is not a discipline failure; it is what happens when the cheap
 * query does not exist. This is the cheap query.
 *
 * === IT COUNTS THE SAME POPULATION THE ENUMERATING OPS COUNT ===
 *
 * A census that disagreed with context_search / decision_search / task_list would be a new
 * instrument that lies quietly — worse than no op at all. So it reads the SAME table
 * registry (DISCLOSABLE_TABLES) and applies the SAME soft-delete predicate under the SAME
 * `includeArchived` flag, and it returns the SAME archive-disclosure block, so a narrowed
 * census cannot read as clean either. A contract test asserts the agreement rather than
 * this comment asserting it.
 *
 * === THE ABSENT/ZERO DIRECTION ===
 *
 * A prefix that matches nothing returns `matched: 0` with `evaluated: true` and the full
 * echo of what was searched. That is distinguishable from a failure to evaluate, which
 * throws. "No such tag" and "I did not look" are different answers and never share a shape.
 */

import {
  DISCLOSABLE_TABLES,
  TAG_CENSUS_DEFAULT_LIMIT,
  type DisclosableEntity,
} from '../config/archiveDisclosureConfig.js';

export interface TagCensusRow {
  /** The tag value, verbatim as stored. */
  tag: string;
  /** Records carrying it, summed across the entity types in scope. */
  count: number;
  /** Per-entity split, so a caller never has to re-query to find WHERE a tag lives. */
  byEntity: Partial<Record<DisclosableEntity, number>>;
}

export interface TagCensusResult {
  tags: TagCensusRow[];
  /** Distinct tag values matching the filter. NOT the returned slice length. */
  matched: number;
  /** Rows dropped by `limit`. A truncated census says so rather than looking complete. */
  omitted: number;
  /**
   * ALWAYS true on a returned result — the census ran. Present so that "the prefix matched
   * nothing" is a positive statement rather than an empty response the caller must
   * interpret. A census that could not run throws; it never returns `matched: 0`.
   */
  evaluated: true;
  /** Echo of the filter, so the number in hand can never be separated from its query. */
  filter: {
    prefix: string | null;
    entities: DisclosableEntity[];
    includeArchived: boolean;
    limit: number;
  };
}

/**
 * Run the census. One UNION ALL over the tables in scope, unnesting the tags array, so the
 * database does the grouping and the caller never walks the table.
 */
export async function runTagCensus(
  queryFn: (sql: string, params: any[]) => Promise<{ rows: any[] }>,
  opts: {
    projectId: string;
    prefix?: string | null;
    entities?: readonly DisclosableEntity[];
    includeArchived?: boolean;
    limit?: number;
  }
): Promise<TagCensusResult> {
  const entities: DisclosableEntity[] = (
    opts.entities && opts.entities.length > 0
      ? opts.entities
      : DISCLOSABLE_TABLES.map((t) => t.entity)
  ).slice() as DisclosableEntity[];

  const includeArchived = opts.includeArchived === true;
  const limit = opts.limit ?? TAG_CENSUS_DEFAULT_LIMIT;
  const prefix = opts.prefix ?? null;

  const tables = DISCLOSABLE_TABLES.filter((t) => entities.includes(t.entity));
  if (tables.length === 0) {
    return {
      tags: [],
      matched: 0,
      omitted: 0,
      evaluated: true,
      filter: { prefix, entities, includeArchived, limit },
    };
  }

  // $1 = projectId, $2 = prefix-or-null. The prefix is matched with a parameterised
  // `LIKE` on an ESCAPED literal — a caller-supplied `%` or `_` is data, not syntax.
  const params: any[] = [opts.projectId, prefix];
  // SOFT-DELETE-VIA: `branches` — each UNION branch below carries `archived_at IS NULL`
  // unless the caller passed includeArchived, so the aggregate further down (which reads
  // the `filtered` CTE, not a table) is already scoped to the same population the
  // search/list ops return. The predicate is assembled here rather than at the aggregate.
  const branches = tables.map((t) => {
    const archived = includeArchived ? '' : ` AND ${t.archivedColumn} IS NULL`;
    return `SELECT '${t.entity}'::text AS entity, unnest(${t.tagsColumn}) AS tag
              FROM ${t.table}
             WHERE ${t.projectColumn} = $1${archived}
               AND ${t.tagsColumn} IS NOT NULL`;
  });

  const sql = `
    WITH exploded AS (
      ${branches.join('\n      UNION ALL\n      ')}
    ), filtered AS (
      SELECT entity, tag FROM exploded
       WHERE $2::text IS NULL
          OR tag LIKE replace(replace(replace($2::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
    )
    SELECT tag,
           -- SUM of the per-entity counts, NOT count(*): count(*) over this grouped
           -- subquery would count (tag, entity) GROUPS — at most 3 — and every tag would
           -- report a count of 1..3 while looking entirely plausible.
           sum(per_entity)::int AS total,
           jsonb_object_agg(entity, per_entity) AS by_entity
      FROM (
        SELECT tag, entity, count(*)::int AS per_entity FROM filtered GROUP BY tag, entity
      ) g
     GROUP BY tag
     ORDER BY sum(per_entity) DESC, tag ASC`;

  const res = await queryFn(sql, params);
  const all = res.rows;

  const tags: TagCensusRow[] = all.slice(0, limit).map((r: any) => ({
    tag: String(r.tag),
    // `total` is the sum over entities of that tag's per-entity counts, which is the
    // number of RECORDS carrying it (a record cannot carry the same tag twice in a way
    // that matters here — a duplicated array element would be a data defect, and counting
    // it is the honest report of what is stored).
    count: Number(r.total),
    byEntity: r.by_entity ?? {},
  }));

  return {
    tags,
    matched: all.length,
    omitted: Math.max(0, all.length - tags.length),
    evaluated: true,
    filter: { prefix, entities, includeArchived, limit },
  };
}
