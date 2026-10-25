/**
 * WHAT DOES DELETING THIS PROJECT DESTROY? — the ONE source for the delete gate.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * `handlers/project.ts` refuses to delete a non-empty project without `confirm: true`.
 * That refusal is the only thing standing between a caller and an irreversible cascade,
 * and it used to be decided by a SUM OVER FOUR HARDCODED COUNTS:
 *
 *     total = contexts + technical_decisions + tasks + sessions      (the old gate)
 *     "…will CASCADE-DELETE: N contexts, N decisions, N tasks, N sessions"  (the message)
 *
 * A count-shaped predicate over a hand-enumerated list, paired with a message naming the
 * same items by hand — a past incident's exact tell. The two agreed, and either could be
 * weakened without the other noticing. Worse, they were ALREADY WRONG, in the present
 * tense, not hypothetically: the schema has TWENTY-FOUR tables whose FK to `projects`
 * is ON DELETE CASCADE, and the gate counted four of them. Measured on a migrated DB
 * (2026-07-27), a project owning only `analytics_events` rows reported
 * `{contexts:0, decisions:0, tasks:0, sessions:0, total:0}` and was DELETED on
 * `confirm:false`, cascading its rows away. Silent, destructive, unrecoverable.
 *
 * ── THE SHAPE, AND WHY NOT JUST ADD THE MISSING TABLES ─────────────────────────────────
 * Adding the twenty missing COUNTs would be a fresh allow-list: correct until the next
 * migration adds a project-owned table, which would be forgotten in exactly the same way
 * (a past incident — a coverage check that greps for the shapes its author had in mind
 * defaults to a silent PASS). A registry in TypeScript has the same defect one layer up:
 * the migration that creates the table is not obliged to visit it.
 *
 * The CHOKE POINT that every project-owned table must pass through is not a list anyone
 * maintains — it is the FOREIGN KEY ITSELF. A row is destroyed by `DELETE FROM projects`
 * if and only if Postgres has a `FOREIGN KEY … REFERENCES projects ON DELETE CASCADE`
 * that reaches it. So this module ASKS THE CATALOG (`pg_constraint`), which the migration
 * has no way to avoid updating, because creating the FK IS how the cascade is created.
 *
 * ── ONE ROW PER TABLE, NOT PER CONSTRAINT (the 4dcf00d blocker) ─────────────────────────
 * The first version of this query returned one row per FK CONSTRAINT while `byTable` is
 * keyed by TABLE NAME, so a table with TWO cascading FKs to `projects` (an ordinary shape:
 * `owner_project_id` / `source_project_id`) produced two UNION-ALL branches with the same
 * label and the later silently OVERWROTE the earlier. Measured on a real DB through the
 * real handler: a project owning three rows via `owner_project_id` reported
 * `byTable = 0, total = 0`, rendered "nothing — 0 rows", and was DELETED WITHOUT
 * CONFIRMATION, destroying all three. Which of the two branches won was decided by the
 * plan, so it presented as "works sometimes" — the same fixture reported the CORRECT count
 * for a victim referenced through the other column, in the same run.
 *
 * The keying is now structural rather than reliably-correct-today: the query GROUPs BY the
 * relation, so a table appears EXACTLY ONCE and every cascading FK column it has is
 * aggregated into `sqlColumns`, which the count ORs together
 * (`WHERE col_a = $1 OR col_b = $1`). One row is counted once even if both columns point
 * at the victim, which is what "rows destroyed" means. There is no duplicate label left
 * for an ordering to decide between, so the result no longer depends on the plan at all.
 *
 * THE PROJECT COLUMN IS RESOLVED, NOT ASSUMED TO BE FIRST. Earlier this took `conkey[1]`,
 * justified by "every unique constraint on `projects` is single-column so the FK must be".
 * That is true today and nothing enforces it: a composite
 * `FOREIGN KEY (owner_ref, project_id) REFERENCES projects(alt_key, id)` would have made
 * the gate count `owner_ref` and report 0. The column is now found by pairing `conkey`
 * with `confkey` and taking the child column sitting opposite `projects.id` — correct for
 * either ordering, and exact IN THE DIRECTION THAT MATTERS because `id` is unique: if a
 * child row's id-column equals the victim's id then the parent row it references IS the
 * victim, so matching on that one column alone can never MISS a row that will cascade.
 *
 * It is NOT exact in general, and the imprecision is worth naming: under the default
 * MATCH SIMPLE, a composite FK does not constrain a tuple with a NULL in it at all, so a
 * row holding `pid = victim, pname = NULL` is not enforced by the FK and is NOT cascaded —
 * while `WHERE pid = $1` counts it (measured: gate said 2, 1 destroyed). That is an
 * OVER-count, which costs a confirmation prompt the user did not strictly need. The
 * under-count direction — the one that destroys data — is the one closed exactly.
 *
 * A cascading FK that does not reference `projects.id` at all (e.g.
 * `REFERENCES projects(name)`) cannot be measured from a project id, so it is reported as
 * UNMEASURABLE and the whole survey fails closed rather than under-counting it.
 *
 * ONE LOGICAL TABLE, ONE ROW — and there are TWO routes to a double count, not one:
 *   (a) `conparentid = 0` drops the constraint rows Postgres CLONES onto each partition of
 *       a partitioned child. Without it a 2-partition table was discovered three times
 *       (parent + both partitions) and three real rows were reported as six.
 *   (b) that filter alone is NOT enough, because a migration can declare an FK DIRECTLY on
 *       a leaf partition (`ALTER TABLE <partition> ADD FOREIGN KEY …`) and that constraint
 *       has `conparentid = 0` too. Measured: parent + own-FK leaf both discovered, three
 *       real rows reported as five, with a phantom table name in the message. So a
 *       relation is also dropped when a DISCOVERED relation is one of its
 *       `pg_partition_ancestors` — a count on the partitioned parent already reads every
 *       partition's rows. A leaf whose ancestors carry no cascading FK is KEPT (only the
 *       leaf cascades, and counting the leaf directly is exact).
 * Both were over-counts, which fail SAFE — but the number and the "across N tables"
 * denominator were wrong, and a phantom table name in a destructive prompt is worse than
 * a wrong number.
 *
 * KNOWN AND ACCEPTED: legacy table INHERITANCE (`CREATE TABLE … INHERITS`) is not
 * deduplicated. A count on the parent reads the children's rows too, so a parent and an
 * inheriting child that each carry their own cascading FK are counted twice. `SELECT …
 * FROM ONLY parent` would fix inheritance and BREAK partitioning (it would read zero rows
 * from a partitioned parent), and there are no inheriting children in this schema. It is
 * an over-count, in the safe direction, and it is written down rather than unnoticed.
 *
 * DIRECT FKs ARE SUFFICIENT FOR EMPTINESS, and that is a claim worth stating: a row in a
 * TRANSITIVELY cascading table (e.g. `git_file_changes` → `git_commits` → `projects`)
 * cannot exist unless a row exists in its direct-child parent, so "every direct cascading
 * child is empty" implies "nothing at all will be destroyed". Emptiness is answered
 * exactly; the per-table numbers reported are direct children only, and say so.
 *
 * Only `confdeltype = 'c'` counts, and that CLASSIFICATION is behavioural, not decorative:
 * a `SET NULL` FK's rows SURVIVE the delete with the column nulled (proven in
 * projectDeleteHostileSchema H3/H4, which deletes a project and reads the rows back), and a
 * `RESTRICT`/`NO ACTION` FK makes the DELETE itself fail loudly. Neither is blast radius.
 *
 * WHAT IS AND IS NOT PROMISED. A table added tomorrow is covered the moment its cascading
 * FK exists, with nothing to remember here — PROVIDED that FK reaches the child through
 * `projects.id`. Everything else the catalog can express is either counted (multiple FKs,
 * composite keys, partitions, an FK declared on a leaf partition) or refused as
 * UNMEASURABLE, or over-counted in the two named cases above (MATCH SIMPLE tuples with a
 * NULL, legacy inheritance). The claim is "covered, over-counted, or refused" — never
 * "covered because the author thought of it", and never silently under-counted.
 *
 * ── FAILS CLOSED, ON PURPOSE (the opposite of counterDelta.isEmptyDelta) ────────────────
 * `isEmptyDelta` fails OPEN because a spurious write costs a no-op UPDATE while a spurious
 * skip destroys data. Here the asymmetry points the other way: a spurious confirmation
 * prompt costs one extra call, while a spuriously-skipped prompt destroys a project. So
 * anything this module cannot PROVE to be empty is treated as non-empty:
 *
 *   - discovery found NO cascading child at all → `isProjectEmpty()` is FALSE and the
 *     rendered message says the blast radius is UNKNOWN. `{}`.every() is vacuously true,
 *     which is precisely the zero/empty value that slips through a naive predicate — so
 *     the empty set is handled FIRST and explicitly.
 *   - discovery found a cascading FK it cannot key on → same, and the message NAMES the
 *     constraints rather than claiming "nothing".
 *   - a count query throws (permissions, a dropped table mid-flight) → the exception
 *     propagates out of `deleteProject` and nothing is deleted.
 *
 * Both UNKNOWN conclusions are logged at ERROR — LOUDLY — from `countProjectChildren`,
 * which is the ONE place the conclusion is reached (discovery does not log: it reports,
 * the caller concludes). `projectDeleteHostileSchema` H5 asserts the log fires — and that a
 * MEASURABLE survey does NOT log, so "always log" cannot satisfy it — making deletion of the
 * loud half a RED rather than a silent downgrade to a quiet fail-closed.
 *
 * ── THE COMPILER IS PART OF THE GUARD ──────────────────────────────────────────────────
 * `ProjectChildCounts` is BRANDED (see types/project.ts), so `buildChildCounts` below is
 * the only thing in the codebase that can produce one. A future caller cannot hand a
 * literal `{ contexts: 0, …, total: 0 }` to the delete gate — that is a compile error at
 * the call site, not a second enumeration that drifts. `total` is derived inside the
 * constructor from the same map the predicate and the message read, so the three cannot
 * disagree.
 *
 * PREDICATE-AND-MESSAGE-AGREE IS NOT CORRECTNESS. Deriving both from `byTable` protects
 * against the two DRIFTING APART; it does nothing about a defect UPSTREAM of both, where
 * they are confidently wrong together — which is exactly what the per-constraint keying
 * bug was. Hence the hostile-schema tests: the guard on this module is a schema it did not
 * expect, not the agreement of its own two outputs.
 *
 * ── NO CACHE, DELIBERATELY ─────────────────────────────────────────────────────────────
 * The catalog is re-read on every call. Caching the discovered set would re-open the exact
 * hole this module closes: a process that started before a migration would keep gating on
 * the OLD table set. Project deletion is rare (and already a two-query operation), so
 * there is nothing to buy.
 *
 * SECURITY: the only user-derived value in any SQL here is the project id, bound as a
 * parameter. Table/column identifiers and the table-name literals are emitted BY POSTGRES
 * (`::regclass::text`, `quote_ident`, `quote_literal`) from the catalog, never assembled
 * from user input. Verified by the reviewer against a table literally named
 * `evil"; DROP TABLE projects; --`.
 */

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import type { ProjectChildCounts } from '../types/project.js';

/**
 * THE PROJECT IDENTITY — the table `deleteProject` deletes from and the column it binds.
 *
 * Exported and consumed by `handlers/project.ts` for its `DELETE` so the delete and the
 * blast-radius survey cannot come to describe different things: discovery keys child rows
 * on the FK column sitting opposite THIS column, and the DELETE is predicated on THIS
 * column. One definition, two readers.
 */
export const PROJECT_TABLE = 'projects';
export const PROJECT_ID_COLUMN = 'id';

/**
 * One TABLE that `DELETE FROM projects` will cascade into — never one constraint. Every
 * field comes from the SAME grouped catalog row, so the SQL fragments and the display name
 * cannot describe different tables.
 */
export interface ProjectCascadeChild {
  /** Bare (search_path-relative) table name — what humans read in the message. */
  name: string;
  /** Postgres-rendered, already-quoted relation identifier for SQL. */
  sqlRelation: string;
  /** `quote_literal`ed table name, used as the label column of the count query. */
  sqlLabel: string;
  /**
   * EVERY `quote_ident`ed column on this table that carries a cascading FK to
   * `projects.id` — one entry per constraint, ORed together by the count. Never empty for
   * a child that reaches `children`; a table whose cascading FKs are all unkeyable lands
   * in `unmeasurable` instead.
   */
  sqlColumns: string[];
}

/**
 * What the catalog says about a project delete: the tables it can measure, and the
 * cascading constraints it CANNOT (which force the whole answer to UNKNOWN).
 */
export interface ProjectCascadeSurvey {
  children: ProjectCascadeChild[];
  /** Constraint names whose cascading FK does not reach the child via `projects.id`. */
  unmeasurable: string[];
}

/**
 * THE CHOKE POINT. Every table Postgres will cascade-delete when a `projects` row goes,
 * read from the catalog rather than from any list a human maintains.
 *
 * `to_regclass(PROJECT_TABLE)` resolves through the SAME search_path the app's unqualified
 * `DELETE FROM projects` uses, so this describes the delete that will actually run.
 *
 * Reports; does not conclude. An empty result is not interpreted here — `countProjectChildren`
 * owns the UNKNOWN conclusion and its loud log, so there is exactly one place that decides it.
 */
export async function discoverProjectCascadeChildren(): Promise<ProjectCascadeSurvey> {
  const result = await db.query(
    `WITH target AS (
       SELECT to_regclass($1) AS relid
     ), keyatt AS (
       SELECT a.attnum
         FROM pg_attribute a, target t
        WHERE a.attrelid = t.relid AND a.attname = $2 AND NOT a.attisdropped
     ), fk AS (
       SELECT c.conrelid, c.conname, c.conkey, c.confkey
         FROM pg_constraint c, target t
        WHERE c.contype = 'f'
          AND c.confrelid = t.relid
          AND c.confdeltype = 'c'
          AND c.conparentid = 0
     ), resolved AS (
       SELECT fk.conrelid,
              fk.conname,
              (SELECT a.attname
                 FROM unnest(fk.conkey, fk.confkey) AS k(child_att, parent_att)
                 JOIN keyatt ON keyatt.attnum = k.parent_att
                 JOIN pg_attribute a
                   ON a.attrelid = fk.conrelid AND a.attnum = k.child_att
                LIMIT 1) AS colname
         FROM fk
     ), grouped AS (
       -- ONE ROW PER RELATION. The \`conname\` ::text is LOAD-BEARING (the \`quote_ident\`
       -- one is not, and is kept only for symmetry): \`conname\` is Postgres type \`name\`,
       -- and node-pg has no parser for \`name[]\` (oid 1003) — it hands back the RAW literal
       -- string '{}', which spreads into the characters '{' and '}' and makes every survey
       -- look UNMEASURABLE. Measured, not guessed: it turned all 24 tables into 48 phantom
       -- constraints. (\`quote_ident()\` already returns \`text\`, so dropping ITS cast is
       -- green — the attribution, not the fix, was one aggregate wide.)
       SELECT conrelid,
              array_remove(array_agg(DISTINCT quote_ident(colname)::text), NULL) AS sql_columns,
              array_remove(array_agg(DISTINCT CASE WHEN colname IS NULL THEN conname::text END), NULL)
                                                                                 AS unmeasurable
         FROM resolved
        GROUP BY conrelid
     )
     SELECT g.conrelid::regclass::text                     AS name,
            quote_literal(g.conrelid::regclass::text)      AS sql_label,
            g.sql_columns                                  AS sql_columns,
            g.unmeasurable                                 AS unmeasurable,
            -- IS THIS RELATION ALREADY COUNTED BY AN ANCESTOR? \`conparentid = 0\` drops the
            -- constraint rows Postgres CLONES onto each partition, but it cannot drop an FK
            -- a migration declared DIRECTLY on a leaf partition — that one is its own
            -- constraint with conparentid = 0. Measured: parent + own-FK leaf were both
            -- discovered, and 3 real rows were reported as 5 with a phantom table named.
            -- A count on the partitioned PARENT already reads every partition's rows, so a
            -- descendant of a discovered relation is dropped. A leaf whose ancestors are
            -- NOT discovered (only the leaf carries the FK) is KEPT, and counting it
            -- directly is exact.
            EXISTS (SELECT 1
                      FROM grouped a
                     WHERE a.conrelid <> g.conrelid
                       AND a.conrelid IN (SELECT relid FROM pg_partition_ancestors(g.conrelid)))
                                                           AS covered_by_ancestor
       FROM grouped g
      ORDER BY 1`,
    [PROJECT_TABLE, PROJECT_ID_COLUMN]
  );

  const children: ProjectCascadeChild[] = [];
  const unmeasurable: string[] = [];

  // A non-array here means the driver handed back an unparsed array literal (see the ::text
  // note in the query). Refusing it rather than coercing keeps a driver-level surprise from
  // silently becoming a wrong ANSWER: an exception out of here aborts the delete.
  const asArray = (v: unknown, field: string): string[] => {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) {
      throw new Error(
        `Project-delete safety probe: expected a text[] for "${field}", got ${typeof v} ` +
          `(${JSON.stringify(v)}). Refusing to measure a blast radius from an unparsed value.`
      );
    }
    return v as string[];
  };

  for (const row of result.rows as any[]) {
    const columns = asArray(row.sql_columns, 'sql_columns');
    const unkeyable = asArray(row.unmeasurable, 'unmeasurable');
    if (columns.length > 0 && row.covered_by_ancestor !== true) {
      children.push({
        name: row.name as string,
        sqlRelation: row.name as string,
        sqlLabel: row.sql_label as string,
        sqlColumns: columns,
      });
    }
    // Collected even from a relation whose ROWS an ancestor already counts: an unkeyable
    // cascade on a leaf is still an unkeyable cascade, and must still force UNKNOWN.
    unmeasurable.push(...unkeyable);
  }

  return { children, unmeasurable };
}

/**
 * Build the counts object. THE ONLY producer of a `ProjectChildCounts` — `total` is
 * derived here from `byTable`, so no caller can supply a total that disagrees with the
 * map the predicate and the message read.
 */
export function buildChildCounts(
  byTable: Readonly<Record<string, number>>,
  unmeasurable: readonly string[] = []
): ProjectChildCounts {
  const total = Object.values(byTable).reduce((sum, n) => sum + n, 0);
  // The brand is un-constructible by design (its key is a module-private unique symbol), so
  // the ONE producer needs the DOUBLE assertion — a single `as` is TS2352 here because the
  // local below is explicitly annotated. That annotation is what still type-checks the three
  // real fields (`byTable: Record<string, number>`, `total: number`, `unmeasurable: string[]`)
  // at this line; only the brand itself is asserted past the compiler.
  const counts: { byTable: Record<string, number>; total: number; unmeasurable: string[] } = {
    byTable: { ...byTable },
    total,
    unmeasurable: [...unmeasurable],
  };
  return counts as unknown as ProjectChildCounts;
}

/**
 * Count, for one project, the rows in every cascading child table — and CONCLUDE whether
 * the answer is measurable at all. This is the one place UNKNOWN is decided, so it is the
 * one place that logs it.
 *
 * `survey` is injectable ONLY so tests can drive the degenerate shapes (notably the empty
 * set) that a real catalog will not produce; production passes nothing and gets the live
 * catalog.
 */
export async function countProjectChildren(
  projectId: string,
  survey?: ProjectCascadeSurvey
): Promise<ProjectChildCounts> {
  const { children, unmeasurable } = survey ?? (await discoverProjectCascadeChildren());

  if (unmeasurable.length > 0) {
    logger.error(
      `❌ Project-delete safety probe cannot measure ${unmeasurable.length} cascading foreign ` +
        `key(s) that do not reference ${PROJECT_TABLE}.${PROJECT_ID_COLUMN}: ` +
        `${unmeasurable.join(', ')}. The blast radius of a project delete is UNKNOWN; ` +
        `every delete will require explicit confirmation until this is resolved.`
    );
    return buildChildCounts({}, unmeasurable);
  }

  if (children.length === 0) {
    // LOUD, not silent. A migrated Mandrel schema always has cascading children (contexts,
    // tasks, …), so an empty answer means the probe could not see the schema it thinks it
    // is guarding. isProjectEmpty() turns this into "require confirmation"; this line is
    // how an operator finds out why.
    logger.error(
      `❌ Project-delete safety probe found NO project-owned cascading FK in the catalog. ` +
        `The blast radius of a project delete cannot be measured; every delete will now ` +
        `require explicit confirmation until this is resolved.`
    );
    return buildChildCounts({});
  }

  // ONE branch per TABLE. Every cascading FK column on that table is ORed, so a row is
  // counted once no matter how many of its columns point at the victim — and there are no
  // duplicate labels for a plan ordering to arbitrate between.
  // SOFT-DELETE-EXEMPT: this counts the BLAST RADIUS of a project delete, and an archived
  // row is still a row that the FK cascade will destroy. Filtering archived rows out here
  // would under-report what the operator is about to lose, which is the opposite of this
  // probe's purpose — it exists to make a destructive action's cost visible before it runs.
  // (The relation is interpolated from the FK catalog, so the sweep cannot read the target.)
  const sql = children
    .map(
      (t) =>
        `SELECT ${t.sqlLabel} AS t, COUNT(*)::int AS n FROM ${t.sqlRelation} WHERE ` +
        t.sqlColumns.map((c) => `${c} = $1`).join(' OR ')
    )
    .join(' UNION ALL ');

  const result = await db.query(sql, [projectId]);

  // Seed every discovered table at 0 first, so the map always describes the FULL set of
  // tables that were checked — not just the ones that happened to have rows.
  const byTable: Record<string, number> = {};
  for (const t of children) byTable[t.name] = 0;
  for (const row of result.rows) byTable[row.t as string] = row.n as number;

  return buildChildCounts(byTable);
}

/**
 * IS THIS PROJECT EMPTY? — the one predicate the delete gate asks.
 *
 * FAILS CLOSED, in both UNKNOWN directions. The empty table set is answered FIRST and
 * explicitly: `[].every()` is vacuously TRUE, so a naive `every(n => n === 0)` would call
 * an unmeasurable project empty and wave the delete through — the zero/empty value that
 * slips past a guard (a past incident rule 7). "We found nothing to check" is not "there is
 * nothing", and neither is "we found something we cannot count".
 */
export function isProjectEmpty(counts: ProjectChildCounts): boolean {
  if (counts.unmeasurable.length > 0) return false;
  const tables = Object.keys(counts.byTable);
  if (tables.length === 0) return false;
  return tables.every((t) => counts.byTable[t] === 0);
}

/**
 * THE ONE RENDERER for "what does this project own". Every human-facing sentence about a
 * project's blast radius — the handler's refusals and its post-delete summary — is produced
 * from HERE, reading the SAME fields `isProjectEmpty` reads. A table can therefore never be
 * named in a message without being counted by the predicate, nor counted without being
 * nameable: there is no second list to keep in sync.
 */
export function describeProjectChildCounts(counts: ProjectChildCounts): string {
  // Every branch returns a NOUN PHRASE, because this one string has to read correctly after
  // three different lead-ins ("will CASCADE-DELETE …", "It owns …", "Cascade-removed …").
  if (counts.unmeasurable.length > 0) {
    const n = counts.unmeasurable.length;
    return (
      `an UNKNOWN number of rows — ${n} cascading foreign ${n === 1 ? 'key' : 'keys'} ` +
      `(${counts.unmeasurable.join(', ')}) ${n === 1 ? 'does' : 'do'} not reference ` +
      `${PROJECT_TABLE}.${PROJECT_ID_COLUMN}, so what would be destroyed cannot be measured`
    );
  }

  const tables = Object.keys(counts.byTable);
  if (tables.length === 0) {
    return (
      'an UNKNOWN number of rows — no project-owned cascading table could be read from the ' +
      'schema, so what would be destroyed cannot be measured'
    );
  }

  const owned = tables.filter((t) => counts.byTable[t] > 0).sort();
  if (owned.length === 0) {
    return `nothing — 0 rows across all ${tables.length} project-owned cascading tables`;
  }

  const detail = owned.map((t) => `${counts.byTable[t]} ${t}`).join(', ');
  return `${counts.total} owned rows (${detail}) across ${tables.length} project-owned cascading tables`;
}
