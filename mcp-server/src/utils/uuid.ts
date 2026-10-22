/**
 * UUID validation — SINGLE SOURCE OF TRUTH (mcp-server).
 *
 * Byte-identical to the backend (`mandrel-command/backend/src/utils/uuid.ts`)
 * and frontend (`mandrel-command/frontend/src/utils/uuid.ts`) copies. See the
 * backend file for the full rationale; in short:
 *
 *   The validator accepts EXACTLY what PostgreSQL's `uuid` type accepts — any
 *   case-insensitive `8-4-4-4-12` hex string. We deliberately do NOT enforce the
 *   RFC 4122 version (`[1-5]`) or variant (`[89ab]`) nibbles, because a stricter
 *   regex would reject real ids the DB stored and accepts (over-rejection), and
 *   we do NOT rely on a library `.uuid()` whose strictness is version-dependent.
 *
 *   /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
 */

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for any string Postgres's `uuid` type would accept. Used at the v2 REST
 * boundary so a malformed id returns a clean 400/404 instead of reaching a uuid
 * query column and making Postgres throw `invalid input syntax for type uuid`
 * (an unhandled 500).
 */
export function isValidUuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return UUID_REGEX.test(value);
}
