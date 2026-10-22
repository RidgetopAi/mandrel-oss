/**
 * Route-Layer Contract Drift Guard (Guard 1 — the permanent class guard)
 *
 * THE BUG CLASS (route-layer drift — distinct from boundary drift):
 *   A zod schema declares a param, the validator accepts it, but the ROUTE HANDLER
 *   never forwards it to the domain handler — so the param is validated then
 *   SILENTLY DROPPED. The tool returns success while writing/using nothing. Two real
 *   instances this guards against:
 *     A4: task_update's zod declared priority/progress but handleUpdate forwarded only
 *         status/assignedTo/metadata → priority/progress writes were no-ops.
 *     A6: decision_search's zod declared status/includeOutcome but handleSearch never
 *         forwarded them → a status-filtered search silently ignored the filter.
 *
 * THE FIX (class fix, not instance):
 *   For EVERY tool, assert that every param the tool's zod schema declares is
 *   referenced (as `args.<param>`) in that tool's SPECIFIC route handler method body.
 *   If a future edit adds a zod param but forgets to forward it in the route — or
 *   removes a forward while leaving the param declared — this test goes RED at the gate.
 *
 * WHY PER-METHOD (not per-file): A4's dropped `priority` WAS referenced elsewhere in
 *   tasks.routes.ts (handleCreate/handleBulkUpdate) — a whole-file scan would have
 *   falsely passed. We extract the exact handler method body and scan only that.
 *
 * DB-free + deterministic: pure source inspection. No Postgres, no network.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validationSchemas } from '../middleware/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(__dirname, '../routes');

/** Extract the top-level zod object key set (unwraps a ZodEffects/.refine wrapper). */
function zodKeys(schema: any): string[] {
  let s = schema;
  while (s?._def?.schema) s = s._def.schema; // ZodEffects (.refine/.transform)
  const shape = s?.shape ?? s?._def?.shape?.();
  return shape ? Object.keys(shape) : [];
}

/**
 * Map every routed tool to the (routeFile, handlerMethod) that serves it — mirrors
 * the switch in routes/index.ts. System tools (no params) and tools whose handler
 * lives outside the routes/*.routes.ts files are intentionally excluded; the
 * EXEMPT_PARAMS map below carves out params consumed indirectly (not via args.<x>).
 */
const TOOL_TO_HANDLER: Record<string, { file: string; method: string }> = {
  // Context
  context_store:        { file: 'context.routes.ts',  method: 'handleStore' },
  context_search:       { file: 'context.routes.ts',  method: 'handleSearch' },
  context_get_recent:   { file: 'context.routes.ts',  method: 'handleGetRecent' },
  // Soft-delete / archive
  context_delete:       { file: 'context.routes.ts',  method: 'handleDelete' },
  context_restore:      { file: 'context.routes.ts',  method: 'handleRestore' },
  // Project
  project_create:       { file: 'project.routes.ts',  method: 'handleCreate' },
  project_update:       { file: 'project.routes.ts',  method: 'handleUpdate' },
  project_delete:       { file: 'project.routes.ts',  method: 'handleDelete' },
  project_switch:       { file: 'project.routes.ts',  method: 'handleSwitch' },
  project_info:         { file: 'project.routes.ts',  method: 'handleInfo' },
  project_list:         { file: 'project.routes.ts',  method: 'handleList' },
  // Decisions
  decision_record:      { file: 'decisions.routes.ts', method: 'handleRecord' },
  decision_search:      { file: 'decisions.routes.ts', method: 'handleSearch' },
  decision_get:         { file: 'decisions.routes.ts', method: 'handleGet' },
  decision_update:      { file: 'decisions.routes.ts', method: 'handleUpdate' },
  decision_delete:      { file: 'decisions.routes.ts', method: 'handleDelete' },
  decision_restore:     { file: 'decisions.routes.ts', method: 'handleRestore' },
  // Tasks
  task_create:          { file: 'tasks.routes.ts',    method: 'handleCreate' },
  task_list:            { file: 'tasks.routes.ts',    method: 'handleList' },
  task_update:          { file: 'tasks.routes.ts',    method: 'handleUpdate' },
  task_bulk_update:     { file: 'tasks.routes.ts',    method: 'handleBulkUpdate' },
  task_details:         { file: 'tasks.routes.ts',    method: 'handleDetails' },
  task_delete:          { file: 'tasks.routes.ts',    method: 'handleDelete' },
  task_restore:         { file: 'tasks.routes.ts',    method: 'handleRestore' },
  cancel_task:          { file: 'tasks.routes.ts',    method: 'handleCancel' },
  // Smart search
  smart_search:         { file: 'search.routes.ts',   method: 'handleSmartSearch' },
  get_recommendations:  { file: 'search.routes.ts',   method: 'handleRecommendations' },
  // Typed-edge graph (T2a)
  link:                 { file: 'links.routes.ts',    method: 'handleLink' },
  unlink:               { file: 'links.routes.ts',    method: 'handleUnlink' },
  get_links:            { file: 'links.routes.ts',    method: 'handleGetLinks' },
  // recall_thread (T3)
  recall_thread:        { file: 'recall.routes.ts',   method: 'handleRecallThread' },
  // Branch position (PHASE 1 positional membership).
  branch_open:          { file: 'branch.routes.ts',   method: 'handleOpen' },
  branch_current:       { file: 'branch.routes.ts',   method: 'handleCurrent' },
  branch_close:         { file: 'branch.routes.ts',   method: 'handleClose' },
  // DEPRECATED anchor alias (delegates to branch_open). thread_current/thread_clear
  // take no id params (per-connection state), like the system tools — excluded.
  thread_set:           { file: 'thread.routes.ts',   method: 'handleSet' },
  // Session lifecycle (SR-2). session_start forwards title/goal/project;
  // session_end/session_status take NO params (operate on the connection's current
  // session), so they're excluded here exactly like the param-less system/thread tools.
  session_start:        { file: 'session.routes.ts',  method: 'handleStart' },
};

/**
 * Params consumed by a handler WITHOUT a literal `args.<param>` reference, and why.
 * Keeping this list tiny + documented means a genuinely-dropped param can't hide
 * behind a blanket exemption. (`sessionId` on context tools is read inside the
 * domain handler from the validated args object that the route forwards wholesale.)
 */
const EXEMPT_PARAMS: Record<string, Set<string>> = {
  // context_store/search forward the whole validated args object to contextRoutes,
  // which reads sessionId internally; the route references the rest via args.<x>.
  // noAutoThread (T5b opt-out): read via the CONFIG-named key
  // `args[AUTO_THREAD_CONFIG.optOutFlag]` (Operator's no-hardcoded-variable rule), NOT a
  // literal `args.noAutoThread` — so it's exempt from the literal-reference scan here.
  context_store:  new Set(['sessionId', 'noAutoThread']),
  context_search: new Set(['sessionId']),

  // ── DRIFT-CLEANUP (an earlier task — the two known-drift exemptions below were
  //    RESOLVED, so they are no longer exempt; advertised == accepted == actually-works: ──
  //
  // decision_record.metadata — RESOLVED via IMPLEMENT. Migration 047 adds a real
  //   technical_decisions.metadata (jsonb, default {}), the handler (recordDecision)
  //   now persists it and decision_get reads it back, and handleRecord forwards
  //   args.metadata. The drift guard now ENFORCES that forward (no exemption) — the
  //   `decisionMetadataRoundTrips` contract proves the end-to-end persist/read-back.
  //
  // smart_search.scope — RESOLVED via DEPRECATE. `scope` was a redundant, singular-form
  //   duplicate of includeTypes that the handler never read and that named DROPPED sources
  //   (naming registry / agent system). It was REMOVED from smartSearchSchemas.search, so
  //   it no longer appears in the zod keyset at all — nothing left to exempt. The
  //   `smartSearchScopeDeprecated` assertion below proves it's no longer advertised.
};

/**
 * Extract a single class-method body by brace-matching from `<method>(` to its
 * matching close brace. Robust to nested braces/strings well enough for our handlers
 * (which contain no unbalanced braces inside string literals).
 */
function extractMethodBody(source: string, method: string): string {
  const sigIdx = source.search(new RegExp(`\\b${method}\\s*\\(`));
  if (sigIdx === -1) return '';
  // Find the opening brace of the method body.
  let i = source.indexOf('{', sigIdx);
  if (i === -1) return '';
  let depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

const fileCache = new Map<string, string>();
function readRoute(file: string): string {
  if (!fileCache.has(file)) {
    fileCache.set(file, readFileSync(resolve(ROUTES_DIR, file), 'utf8'));
  }
  return fileCache.get(file)!;
}

describe('route-layer contract drift class guard (every zod param is forwarded in its handler)', () => {
  for (const [toolName, { file, method }] of Object.entries(TOOL_TO_HANDLER)) {
    test(`${toolName}: ${file}#${method} references every zod-declared param`, () => {
      const schema = (validationSchemas as any)[toolName];
      expect(schema, `validation schema for ${toolName}`).toBeDefined();
      const keys = zodKeys(schema);
      expect(keys.length, `${toolName} should declare at least one param`).toBeGreaterThan(0);

      const body = extractMethodBody(readRoute(file), method);
      expect(body, `handler ${method} must be found in ${file}`).not.toBe('');

      const exempt = EXEMPT_PARAMS[toolName] ?? new Set<string>();
      const dropped = keys.filter(
        k => !exempt.has(k) && !new RegExp(`\\bargs\\.${k}\\b`).test(body)
      );
      expect(
        dropped,
        `${toolName}: these zod params are declared but NOT referenced as args.<param> ` +
          `in ${file}#${method} (route-layer drift — they would be validated then ` +
          `silently dropped): ${dropped.join(', ')}`
      ).toEqual([]);
    });
  }

  // ── DRIFT-CLEANUP: assert the two formerly-exempt lies are gone ──

  test('smart_search.scope is DEPRECATED — no longer advertised (removed from the zod schema)', () => {
    // DEPRECATE call: `scope` was a redundant duplicate of includeTypes naming dropped
    // sources. Removing it from the validator means it's gone from the derived,
    // model-facing inputSchema too (toolDefinitions buildInputSchema reads the same zod
    // schema). Guard that it never silently creeps back as an advertised-but-ignored lie.
    const keys = zodKeys((validationSchemas as any).smart_search);
    expect(keys).not.toContain('scope');
    // includeTypes IS the real, honored source filter — it must remain.
    expect(keys).toContain('includeTypes');
  });

  test('decision_record.metadata is IMPLEMENTED — forwarded in handleRecord (no exemption)', () => {
    // IMPLEMENT call: metadata now has a backing column (migration 047) and is persisted.
    // The route MUST forward it; with no exemption, the generic per-tool guard above
    // already enforces `args.metadata` is referenced in decisions.routes#handleRecord.
    // This is a focused, self-documenting restatement of that expectation.
    const body = extractMethodBody(readRoute('decisions.routes.ts'), 'handleRecord');
    expect(body).not.toBe('');
    expect(/\bargs\.metadata\b/.test(body)).toBe(true);
    // And it must NOT be exempt anymore (the lie is gone).
    expect(EXEMPT_PARAMS.decision_record).toBeUndefined();
  });

  test('FUSE: the guard FAILS when a param is dropped (proves it actually guards)', () => {
    // Simulate the A4/A6 bug: a schema declares `priority` but the (fake) handler body
    // never forwards it. The same detection logic must flag it.
    const fakeBody = `async handleUpdate(args) {
      await handler.update(args.taskId, args.status, args.assignedTo, args.metadata);
    }`;
    const declared = ['taskId', 'status', 'assignedTo', 'metadata', 'priority', 'progress'];
    const dropped = declared.filter(k => !new RegExp(`\\bargs\\.${k}\\b`).test(fakeBody));
    // priority + progress are the silently-dropped params the real bug had.
    expect(dropped).toEqual(['priority', 'progress']);
  });
});
