/**
 * fieldLimits (Command frontend) — the client-side field-size caps, MIRRORED from the
 * backend's column-derived declaration (Phase 2 item 2).
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────
 * `tasks.assigned_to` is `character varying(200)`. Phase 1 made the MCP surface and the
 * Command BACKEND both derive their cap from that column. This layer did not move: it was
 * a bare literal `optionalString(100)` in `validation/schemas.ts`. Live effect — an agent
 * writes a 101..200-char assignee through MCP, Postgres stores it, the backend accepts it,
 * and then the BROWSER refuses to accept or even re-save that task. A third representation
 * of one truth, disagreeing with the other two.
 *
 * ── WHY THIS IS NOT "CHANGE 100 TO 200" ───────────────────────────────────────────────
 * A literal `200` is the same defect one digit over: the next reader has no way to know
 * whether it still matches the column. `varcharColumn()` sets `max === length`, so there
 * is no free number here to get wrong, and the length itself is pinned to the backend's
 * declaration by `__tests__/fieldLimitsDrift.test.ts` — which is in turn pinned to the LIVE
 * `information_schema` by the backend's own `assignedToFieldLimit.db.test.ts`. The chain
 * bottoms out at the column, which is the only rung that cannot be confidently wrong.
 *
 * ── WHY A MIRROR AND NOT AN IMPORT (MEASURED, NOT ASSUMED) ────────────────────────────
 * `mandrel-command/frontend/Dockerfile` copies `frontend/` into the builder stage and, of
 * the backend, only `backend/package.json` — the backend's `src/` is never in the frontend
 * build context. An `import` of `../../backend/src/config/fieldLimits` therefore compiles
 * here and FAILS the container build, which is the worst possible place to find out. (The
 * `shared/` workspace member is not an escape hatch: its source is not copied either, and
 * nothing in `frontend/src` imports `@shared/*` today.)
 *
 * So the anti-drift job moves from discipline to a GUARD, the same technique Phase 1 used
 * for the actor registry: the guard parses the backend file off disk and compares in BOTH
 * directions, and refuses to pass if it cannot find that file.
 */

/** The shape a column really has. Kept structurally identical to the backend's. */
export interface VarcharColumnShape {
  /** Postgres table name (information_schema.columns.table_name). */
  readonly table: string;
  /** Postgres column name (information_schema.columns.column_name). */
  readonly column: string;
  /** The column's DECLARED length — pinned to the backend's declaration by the drift guard. */
  readonly length: number;
  /** The cap the validator enforces. DERIVED from `length` — never typed separately. */
  readonly max: number;
  /** Why this field is capped at all / what the cap protects. */
  readonly why: string;
}

/**
 * A varchar(N) column: the cap IS the column length. Anything smaller invents a limit the
 * DB does not have and rejects a value the other two surfaces accept; anything larger just
 * moves the rejection to a worse place (a backend 400, or a raw Postgres 22001).
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
  'Free-form assignee. Capped at the column so the browser accepts exactly what the ' +
    'Command backend, the MCP surface and Postgres accept — no tighter (a client-side ' +
    'rejection of a value the server already stored) and no looser.'
);


/**
 * `tasks.title` — the task's headline. varchar(500); the cap IS the column, same as the
 * assignee above. Mirrored here (batch 6 / lane M-10) so `TASKS_CONFIG.titlePreviewChars`
 * is DERIVED rather than being the seventh hand-copied `140` in this client.
 */
export const TASKS_TITLE = varcharColumn(
  'tasks',
  'title',
  500,
  'A task title is a short identifier, but the column affords 500 and no layer has any ' +
    'business inventing a tighter limit than the schema has.'
);

/** Every column-backed limit this client declares. The drift guard iterates THIS. */
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
 * `docker-compose.build.yml:58-59` builds this image with build context `./mandrel-command`
 * and dockerfile `frontend/Dockerfile`. `mcp-server/` is therefore NOT IN THE BUILD CONTEXT
 * AT ALL, and `frontend/Dockerfile:50` copies only `frontend/`. An
 * `import ... from '../../../mcp-server/src/config/fieldLimits'` compiles on a dev box and
 * FAILS the container build — the worst place to learn it. `shared/` is not an escape
 * hatch either: `frontend/Dockerfile:44` copies `shared/package.json` and never `shared/`'s
 * source, so a constant placed there is equally absent at build time.
 *
 * So the anti-drift job is a GUARD, not discipline — exactly the technique this file's
 * column-backed half already uses. `config/tagLimits.drift.test.ts` parses the mcp-server
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
  why: 'Tags are handles, not prose. Mirrors the MCP surface exactly so the browser neither ' +
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
