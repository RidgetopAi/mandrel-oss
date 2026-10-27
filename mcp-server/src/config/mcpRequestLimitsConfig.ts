/**
 * MCP REQUEST LIMITS — how much an MCP request may carry, on both MCP surfaces
 * (security sweep).
 *
 * WHY THIS EXISTS: @modelcontextprotocol/sdk ≤ 1.30.0 read request bodies with no size or
 * batch bound (GHSA-f897-62hf-6gxq) and one request could exhaust server memory
 * (GHSA-46jr-4wx8-v453). On top of the SDK, this server parsed EVERY body with an app-wide
 * `express.json({limit:'10mb'})` that ran BEFORE any route's auth guard, so an
 * unauthenticated caller could make the process parse 10 MB of JSON per request on /mcp.
 * The routes now authenticate first and parse second, each with its own bound from here.
 *
 * configs-not-hardcoded: every tunable is here, env-overridable, and read once at import.
 */

/** Read a positive integer env var, falling back on missing/invalid. */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MIB = 1024 * 1024;

/**
 * Largest request body, in bytes, accepted on the streamable MCP surface (`POST /mcp`, the
 * gateway). Parsed only AFTER the route's auth guard has passed; a bigger body is answered
 * 413 without being parsed.
 *
 * Default 4 MiB = the SDK's own DEFAULT_MAX_REQUEST_BODY_SIZE (sdk/server/requestBody.js),
 * down from the 10 MB this route used to inherit. Real tool calls are measured in kilobytes
 * (a ~23k-char conversational turn is the largest legitimate write fieldLimits.ts names).
 * Note it sits BELOW fieldLimits' TEXT_ANTI_ABUSE_CEILING (5,000,000 chars): on this surface
 * the body limit, not the field cap, is the binding bound.
 *
 * The same number is handed to the SDK transport as `maxRequestBodySize`. That option only
 * governs a body the SDK reads ITSELF; this server passes the express-parsed body to
 * `handleRequest`, so the express parser is the enforcing bound and the SDK option is the
 * bound for any path that stops passing one.
 *
 * env: MCP_MAX_REQUEST_BODY_BYTES
 */
export const MCP_MAX_REQUEST_BODY_BYTES = envPositiveInt('MCP_MAX_REQUEST_BODY_BYTES', 4 * MIB);

/**
 * Largest request body, in bytes, accepted on the flat MCP surface (`POST /mcp/tools/:tool`).
 * Parsed only AFTER bridgeAuth has passed. Default 10 MiB = the value this route inherited
 * from the old app-wide parser, kept unchanged so no existing on-box caller is newly refused;
 * fieldLimits.ts's TEXT_ANTI_ABUSE_CEILING rationale is written against it.
 *
 * env: MCP_FLAT_MAX_REQUEST_BODY_BYTES
 */
export const MCP_FLAT_MAX_REQUEST_BODY_BYTES = envPositiveInt('MCP_FLAT_MAX_REQUEST_BODY_BYTES', 10 * MIB);

/**
 * Largest request body, in bytes, accepted by the small authenticated REST mutations that
 * HealthServer mounts directly (today: POST /api/v2/projects/:id/set-primary). Same 1 MB the
 * /api/v2/sessions and /api/decisions routers apply to themselves.
 *
 * env: MCP_REST_MAX_REQUEST_BODY_BYTES
 */
export const MCP_REST_MAX_REQUEST_BODY_BYTES = envPositiveInt('MCP_REST_MAX_REQUEST_BODY_BYTES', 1 * MIB);

/**
 * Largest combined number of array elements and object members one tool call's `arguments`
 * may contain — the server-side equivalent of the SDK 1.32 `McpServer` option
 * `maxToolInputElements`. This server registers its handlers on the low-level SDK `Server`,
 * which does not offer that option, so the same count is enforced by
 * `assertToolInputWithinLimit` (utils/toolInputLimit.ts) on every tool-call surface.
 *
 * Default 10,000: twenty times the largest declared array a tool accepts (TASK_BULK_MAX_IDS =
 * 500), and far below what a 4 MiB body can encode (~2 million elements of `[0,0,…]`).
 *
 * env: MCP_MAX_TOOL_INPUT_ELEMENTS
 */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = envPositiveInt('MCP_MAX_TOOL_INPUT_ELEMENTS', 10_000);
