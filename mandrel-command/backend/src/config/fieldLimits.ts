/**
 * fieldLimits (Command backend) — field-size caps DERIVED FROM THE COLUMN, not typed by
 * hand into a zod schema (Phase 1 item 2).
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────
 * `tasks.assigned_to` is `character varying(200)`
 * (`mcp-server/database/migrations/000_baseline_schema.sql:5109`). The MCP surface caps it
 * at the column (`mcp-server/src/config/fieldLimits.ts` `'tasks.assigned_to'`). This
 * backend's zod schemas capped it at a bare literal `100` in two places
 * (`validation/schemas.ts` CreateTaskSchema / UpdateTaskSchema). So a 101..200-char
 * assignee that MCP accepts and Postgres stores was rejected by the Command UI — two
 * surfaces over one column disagreeing, with the tighter one inventing a limit the DB does
 * not have.
 *
 * ── WHY THIS IS NOT JUST "CHANGE 100 TO 200" ──────────────────────────────────────────
 * A literal `200` is the same defect one digit over: the next reader has no way to know
 * whether it still matches the column. So the cap is DERIVED — `varcharColumn()` sets
 * `max === length`, leaving no free number to get wrong — and the declared column shape is
 * asserted against the LIVE `information_schema` of the real migrated database by
 * `__tests__/assignedToFieldLimit.db.test.ts`. That is the lowest rung of the instrument
 * ladder: if someone ALTERs the column, this file goes RED and names it.
 *
 * The mcp-server's registry asserts ITSELF against the same `information_schema` (its
 * `tests/fieldLimits.schema.test.ts`). Both surfaces therefore derive from the column
 * rather than from each other, which is why this is one source of truth and not two
 * copies: there is no number here that can drift without the column moving.
 *
 * SCOPE: this module holds only the caps this backend actually enforces. It is
 * deliberately NOT a mirror of the mcp-server's ~30-entry registry — an unused mirrored
 * entry is a copy with nothing exercising it.
 */

/** The shape a column really has, as asserted against information_schema. */
export interface VarcharColumnShape {
  /** Postgres table name (information_schema.columns.table_name). */
  readonly table: string;
  /** Postgres column name (information_schema.columns.column_name). */
  readonly column: string;
  /** The column's DECLARED length — asserted against the live schema by the DB test. */
  readonly length: number;
  /** The cap the validator enforces. DERIVED from `length` — never typed separately. */
  readonly max: number;
  /** Why this field is capped at all / what the cap protects. */
  readonly why: string;
}

/**
 * A varchar(N) column: the cap IS the column length. Using the full column is the only
 * non-arbitrary choice — anything smaller invents a limit the DB does not have (and
 * disagrees with the MCP surface over the same row), anything larger hands Postgres a
 * value it rejects with a raw 22001 surfaced as a 500.
 */
function varcharColumn(
  table: string,
  column: string,
  length: number,
  why: string
): VarcharColumnShape {
  return { table, column, length, max: length, why };
}

/** `tasks.assigned_to` — free-form assignee string (NOT a uuid FK; no registry, no enum). */
export const TASKS_ASSIGNED_TO = varcharColumn(
  'tasks',
  'assigned_to',
  200,
  'Free-form assignee. Capped at the column so the Command UI accepts exactly what the ' +
    'MCP surface and Postgres accept — no tighter (a silent rejection of a legal value) ' +
    'and no looser (a raw Postgres 22001 surfaced as a 500).'
);


/**
 * `tasks.title` — the task's headline. varchar(500), like the assignee: the cap IS the
 * column. Declared here so the Command UI's title-preview slice can be DERIVED from the
 * column instead of carrying a hand-copied number (batch 6 / lane M-10 — this was the
 * SEVENTH hand-copied `titlePreviewChars: 140` in the client).
 */
export const TASKS_TITLE = varcharColumn(
  'tasks',
  'title',
  500,
  'A task title is a short identifier, but the column affords 500 and no layer has any ' +
    'business inventing a tighter limit than the schema has — the MCP validator already ' +
    'uses the whole column.'
);

/** Every column-backed limit this backend declares. The DB test iterates THIS. */
export const COLUMN_BACKED_LIMITS: ReadonlyArray<VarcharColumnShape> = [
  TASKS_ASSIGNED_TO,
  TASKS_TITLE,
];

// ═════════════════════════════════════════════════════════════════════════════════════
// TRANSIENT LIMITS — caps on inputs with NO column beneath them
// ═════════════════════════════════════════════════════════════════════════════════════
/**
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────
 * `contexts/tasks/decisions.tags` is an unbounded `TEXT[]`
 * (`mcp-server/database/migrations/002_create_contexts_and_sessions.sql:47`). So the tag
 * caps are DELIBERATE PRODUCT POLICY with no column forcing them, and their one home is
 * `mcp-server/src/config/fieldLimits.ts` `TRANSIENT_LIMITS`, which says so in its own `why`.
 * This package restated those numbers by hand in `validation/schemas.ts` and they had
 * ALREADY DRIFTED: the tag COUNT cap was a bare `.max(10)` against a source of truth of 20,
 * so this surface rejected an 11..20-tag record that MCP accepts and Postgres stores — the
 * identical user-visible defect the `assigned_to` 100-vs-200 mismatch produced one field over.
 *
 * ── WHY A MIRROR AND NOT AN IMPORT (MEASURED, NOT ASSUMED) ────────────────────────────
 * `docker-compose.build.yml:49-50` builds this image with build context `./mandrel-command`
 * and dockerfile `backend/Dockerfile`. `mcp-server/` is therefore NOT IN THE BUILD CONTEXT
 * AT ALL, and `backend/Dockerfile:43` copies only `backend/`. An
 * `import ... from '../../../mcp-server/src/config/fieldLimits'` compiles on a dev box and
 * FAILS the container build — the worst place to learn it. `shared/` is not an escape
 * hatch either: `backend/Dockerfile:37` copies `shared/package.json` and never `shared/`'s
 * source, so a constant placed there is equally absent at build time.
 *
 * So the anti-drift job is a GUARD, not discipline — exactly the technique this file's
 * column-backed half already uses. `__tests__/tagLimitsDrift.test.ts` parses the mcp-server
 * declaration off disk and compares in BOTH directions, and REFUSES TO PASS if it cannot
 * find that file (a "could not measure" must never read as "no drift").
 *
 * ── SCOPE: ONLY WHAT THIS PACKAGE ENFORCES ────────────────────────────────────────────
 * Deliberately not a mirror of the upstream ~15-entry transient registry. An entry mirrored
 * here with nothing consuming it is a copy that can rot unobserved, which is the class this
 * file exists to close.
 */
export interface TransientLimitShape {
  /** The key this entry mirrors in the mcp-server `TRANSIENT_LIMITS` registry. */
  readonly key: string;
  /** The cap, pinned to the upstream declaration by the drift guard. */
  readonly max: number;
  /** Why the cap exists at all. */
  readonly why: string;
}

/** A single tag element. Upstream `TRANSIENT_LIMITS.tagLength`. */
export const TAG_LENGTH: TransientLimitShape = {
  key: 'tagLength',
  max: 50,
  why: 'Tags are handles, not prose. Mirrors the MCP surface exactly so this client neither ' +
    'rejects a tag the server stores nor accepts one the server will 400.',
};

/** Max tags on one record. Upstream `TRANSIENT_LIMITS.tagCount`. */
export const TAG_COUNT: TransientLimitShape = {
  key: 'tagCount',
  max: 20,
  why: 'Anti-abuse fan-out guard. Was a hand-typed 10 here against an upstream 20 — this ' +
    'surface silently refused to save an 11..20-tag record that MCP had already accepted.',
};

/** Every transient limit this package mirrors. The drift guard iterates THIS. */
export const TRANSIENT_LIMITS: ReadonlyArray<TransientLimitShape> = [TAG_LENGTH, TAG_COUNT];
