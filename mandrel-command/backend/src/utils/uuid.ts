/**
 * UUID validation — SINGLE SOURCE OF TRUTH (backend).
 *
 * CANONICAL REGEX DECISION
 * ------------------------
 * The validator must accept EXACTLY what PostgreSQL's `uuid` type accepts, no
 * more and no less. Postgres accepts any case-insensitive `8-4-4-4-12` hex
 * string (e.g. `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` and
 * `12345678-1234-1234-1234-123456789012` both cast cleanly to `uuid`). It does
 * NOT enforce the RFC 4122 version nibble (`[1-5]`) or variant nibble
 * (`[89ab]`).
 *
 * Therefore the canonical regex is the LOOSE hex form:
 *
 *     /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
 *
 * We deliberately do NOT use a stricter RFC version/variant regex (the form in
 * the old `middleware/project.ts`, `^...-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-...`).
 * A stricter regex REJECTS real ids that the DB stored and accepts — it would
 * 400 a user out of a perfectly valid project (the over-rejection / "M1 in
 * reverse" bug). We also do NOT rely on zod's `.uuid()`: its strictness is
 * version-dependent (zod 4.x rejects non-RFC-version uuids that Postgres
 * accepts), so leaning on it makes correctness a function of the resolved zod
 * version. An explicit regex is version-independent and byte-identical to the
 * frontend (`frontend/src/utils/uuid.ts`) and mcp-server (`mcp-server/src/utils/uuid.ts`)
 * copies.
 */

export const UNASSIGNED_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

// Case-insensitive 8-4-4-4-12 hex == exactly what Postgres `uuid` accepts.
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for any string Postgres's `uuid` type would accept. The all-zero
 * UNASSIGNED sentinel is a syntactically valid uuid and returns TRUE here on
 * purpose: at the DB boundary it is a real, castable value (route handlers
 * decide separately whether it is a *selectable* entity). This differs from the
 * frontend's `isValidUuid`, which excludes the sentinel because there the
 * question is "is this a selectable project?" — a product question, not a
 * "will Postgres throw?" question. Keeping the DB-boundary check permissive is
 * what prevents the over-rejection bug.
 */
export function isValidUuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return UUID_REGEX.test(value);
}
