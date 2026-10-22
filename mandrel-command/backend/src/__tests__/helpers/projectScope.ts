/**
 * Test helper: attach a project scope to a hand-built request the way
 * projectContextMiddleware would.
 *
 * WHY THIS EXISTS. Controllers no longer read `req.query.project_id` / `req.body.projectId`
 * — those were the un-authorized doors. They call `getRequestProjectId(req)`, which reads
 * `req.projectScope` and THROWS when it is absent, deliberately: a handler running without
 * the middleware is a wiring bug, and answering "no project" for it is how an ambient write
 * happens silently. That fail-loud behaviour means every unit test that drives a controller
 * with a hand-built `req` must attach a scope.
 *
 * WHY IT USES THE REAL EXTRACTOR. It calls services/projectScopeResolver's
 * `extractProjectCandidates`, so the SOURCE PRECEDENCE a test observes is the shipping
 * rule, not a fixture's idea of it. A helper that just set `req.projectScope = { projectId }`
 * would make every precedence assertion vacuous.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: authorization. Attaching a scope here means "assume the
 * caller is authorized for it" — the authorization itself is exercised end-to-end in
 * projectScopeEnforcement.test.ts, against the real middleware and the real
 * ProjectAccessService seam. Do not use this helper to test authorization.
 */
import {
  extractProjectCandidates,
  type ResolvedProjectScope,
} from '../../services/projectScopeResolver';

/** Mutates and returns `req` with `projectScope` + `projectId` attached. */
export function attachResolvedScope<T extends Record<string, unknown>>(req: T): T {
  const extracted = extractProjectCandidates(req as never);
  if (!extracted.ok) {
    throw new Error(
      `attachResolvedScope: this fixture would be a ${extracted.failure.status} in production ` +
        `(${extracted.failure.message}). Fix the fixture, do not bypass the resolver.`
    );
  }
  const winner = extracted.candidates[0];
  const scope: ResolvedProjectScope = {
    projectId: winner && winner.kind === 'project' ? winner.value : undefined,
    explicitlyUnscoped: !!winner && winner.kind === 'unscoped',
    sourceKey: winner?.sourceKey,
    authorizedProjectIds: extracted.candidates
      .filter((c) => c.kind === 'project')
      .map((c) => c.value as string),
  };
  (req as Record<string, unknown>).projectScope = scope;
  (req as Record<string, unknown>).projectId = scope.projectId;
  return req;
}

/**
 * Valid uuids for fixtures. The resolver rejects non-uuid project ids with a 400, so the
 * old `'header-proj-id'`-style placeholders are no longer legal values anywhere.
 */
export const TEST_PROJECT_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
export const TEST_PROJECT_B = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
