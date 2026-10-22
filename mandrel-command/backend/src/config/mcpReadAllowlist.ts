/**
 * mcpReadAllowlist — the ONLY MCP tools the hosted browser UI may invoke through the
 * authenticated /api/mcp passthrough (the durable F-01/F-04 fix), plus
 * each tool's PROJECT-SCOPE classification (the ambient-read closure).
 *
 * ── WHY AN ALLOW-LIST, AND WHY IT IS SMALL ───────────────────────────────────────────
 * The browser makes only MCP *READS* — that invariant is enforced on the frontend by
 * mandrelApiClient.identity.test.ts (which derives the rejectable-op set from the
 * mcp-server's opRegistry). The passthrough is the SERVER-side half of the same
 * invariant: deny-by-default, so a tool name this list has never seen is 403 — including
 * every write, every scope-switch, and every tool added to the mcp-server tomorrow.
 * A newly added READ tool is deliberately NOT callable until a human adds it here:
 * fail-closed beats convenient.
 *
 * The contents are exactly the wrapper surface MandrelApiClient exposes today
 * (frontend/src/api/mandrelApiClient.ts) — measured, not guessed:
 *   grep -rn "mandrelApi\.\|callTool(" frontend/src --include=*.ts*  → one live call
 *   site (ping) plus the wrapper methods below.
 *
 * ── THE SCOPE CLASSIFICATION (an earlier task — why every tool carries one) ────────────
 * The mcp-server scopes a call that names no project to the caller's CONNECTION SLOT —
 * and the passthrough deliberately sends no X-Connection-ID, so every forwarded ref-less
 * call landed in the shared header-less slot: a zero-grant authenticated user calling
 * `context_get_recent {}` read whatever project that slot pointed at. Deny-by-default
 * did not cover the AMBIENT path.
 *
 * The closure: the route resolves the caller's effective project and BINDS the upstream
 * call to it (X-Mandrel-Project — the mcp-server's rung-1 authoritative binding, which
 * covers tools with AND without a declared project param via the accessor choke point,
 * services/effectiveProjectScope.ts). A `project-scoped` tool that arrives ref-less and
 * cannot be bound to exactly one authorized project is REFUSED, never forwarded ambient.
 * A `global` tool carries no project-slot-dependent data and may forward unbound.
 *
 * Classification is a JUDGMENT made by reading each handler (never the tool's name):
 *   - mandrel_ping    → global: echo + timestamp (system.routes.ts handlePing — no
 *     project resolution on any path).
 *   - mandrel_status  → global: version/uptime/pid only (system.routes.ts handleStatus —
 *     no project resolution on any path).
 *   - everything else → project-scoped. context_search / context_get_recent declare a
 *     projectId param that DEFAULTS to the ambient project; project_current reads the
 *     ambient slot itself (the literal leak); project_list marks the ambient slot's
 *     "current" project and enumerates cross-project metadata; session_status resolves
 *     the caller's session, which carries its project.
 *
 * ── DRIFT GUARD (the copy problem) ───────────────────────────────────────
 * This is a hand-kept list and hand-kept lists drift. The teeth are in
 * __tests__/mcpReadAllowlist.guard.test.ts, which parses the mcp-server's own
 * opRegistry.ts off disk (the product's single source for op effects — same technique
 * as the frontend identity guard) and FAILS if any tool named here is not a registered
 * 'read'. So a read→write reclassification on the mcp-server side turns this list RED
 * instead of silently widening the browser's reach.
 *
 * The SCOPE classification is drift-pinned the same way, in both checkable directions:
 *   (a) any allow-listed tool whose opRegistry entry declares a project-reference param
 *       MUST be classified 'project-scoped' (machine-derived from the registry source);
 *   (b) the 'global' set is pinned value-by-value in the guard test (the
 *       opEffectClassification pattern: a widening is a deliberate two-file diff, and a
 *       test that only re-read this file could not detect a change to it).
 * The judgment half (an ambient reader that declares NO param, e.g. project_current)
 * cannot be machine-derived — it is written above with its reasons, per entry.
 */

/** How a read tool relates to project data — decides the ambient-scope rule for it. */
export type McpReadToolScope = 'project-scoped' | 'global';

/**
 * The allow-list WITH its scope classification — one object so a tool cannot be
 * admitted without the classification being made (totality by construction: adding a
 * key forces a value; there is no "unclassified" state to fall through).
 */
export const MCP_READ_TOOL_SCOPES: Readonly<Record<string, McpReadToolScope>> = {
  mandrel_ping: 'global',
  mandrel_status: 'global',
  project_current: 'project-scoped',
  project_list: 'project-scoped',
  context_search: 'project-scoped',
  context_get_recent: 'project-scoped',
  session_status: 'project-scoped',
};

export const MCP_READ_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(
  Object.keys(MCP_READ_TOOL_SCOPES)
);

/** Is this tool callable through the browser passthrough? Deny-by-default. */
export function isAllowedReadTool(toolName: string): boolean {
  return MCP_READ_TOOL_ALLOWLIST.has(toolName);
}

/**
 * Must this tool's forwarded call carry an explicit project binding?
 * FAIL CLOSED: a tool with no classification (unreachable while the allow-list is
 * derived from the same object, but stated anyway — C3: the absent population) is
 * treated as project-scoped, never as global.
 */
export function isProjectScopedReadTool(toolName: string): boolean {
  return MCP_READ_TOOL_SCOPES[toolName] !== 'global';
}
