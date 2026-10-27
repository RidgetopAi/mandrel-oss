/**
 * projectScope — THE way a page scopes a request to ITS OWN project (an earlier epic §A1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE BUG THIS EXISTS TO CLOSE — READ THIS BEFORE WRITING A PAGE
 * ════════════════════════════════════════════════════════════════════════════════════
 * "Pass the project as a query param" is correct FOR READS ONLY. Writes carry no query
 * params, and the backend resolver's precedence for a write is HEADER > BODY
 * (services/projectScopeResolver.ts — the winner is candidates[0]). Two conventions live
 * in the backend today:
 *
 *   • subject-of-write controllers read the BODY and ignore the header — safe
 *     (controllers/task.ts, controllers/context.ts);
 *   • `requireWriteProjectId` controllers use the RESOLVED WINNER, i.e. the HEADER —
 *     `decision_record`, `decision_update`, `context_store`.
 *
 * That was invisible while the ambient header always equalled what the page displayed.
 * This design breaks that equality ON PURPOSE: the page selector says project A, the
 * pinned ambient header says the user's default B. Create a decision from that page and
 * it is written to **B**. It does not appear in the list you are looking at. Nothing
 * errors — both projects authorize, so the backend guard passes legitimately. A record
 * silently filed in the wrong project is the worst class of bug this UI can produce:
 * no exception, no red, and no way for the user to know.
 *
 * So: a page does not merely SEND a query param. It scopes the REQUEST.
 *
 *     const project = usePageProject();
 *     api.decisions.create(body, project.scope())      // header pinned to the page
 *     api.contexts.search({ project_id: project.projectId }, project.scope())
 *
 * ── WHY THIS IS IN THE FOUNDATION AND NOT IN EACH PAGE ───────────────────────────────
 * Three page streams build on top of this in parallel. A convention that is not a shared
 * primitive gets solved three different ways, or missed once — and the one that misses it
 * produces the silent-misplacement bug above. The only version of this rule that holds is
 * the one where the page cannot express scope any other way.
 *
 * ── FAIL LOUD, NEVER SILENTLY UNSCOPED (A2) ──────────────────────────────────────────
 * `scopedRequestConfig` THROWS when it has no project. It never falls back to the ambient
 * header and never quietly omits the header: several backend controllers read a missing
 * project as "every project", so a silent omission does not fail — it WIDENS. An error a
 * developer sees in the first minute is strictly better than a record filed in the wrong
 * project six weeks later.
 */
import type { AxiosRequestConfig } from 'axios';
import { apiConfig } from '../../config/apiConfig';
import { isValidUuid } from '../../utils/uuid';

/** The value a page uses to mean "every project" (see components/ui/ProjectSelect). */
export const ALL_PROJECTS_SCOPE = 'all';

export class UnscopedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnscopedRequestError';
  }
}

/**
 * Build an axios config that pins `X-Project-ID` to `projectId` for THIS request.
 *
 * The shared request interceptor only fills the header in when it is absent
 * (services/api.ts), so a pre-set header always wins — this is an override, not a race.
 *
 * @throws UnscopedRequestError when `projectId` is absent or not a real UUID. That is
 *   deliberate: see the header. The ONE exception is the "all projects" scope, which is
 *   an explicit, chosen widening rather than an accidental one — it sends NO header, so
 *   the backend's unscoped path is reached on purpose and only from a page that offered
 *   the option.
 */
export function scopedRequestConfig(
  projectId: string | undefined,
  base?: AxiosRequestConfig
): AxiosRequestConfig {
  if (projectId === ALL_PROJECTS_SCOPE) {
    // Chosen, explicit widening. Blank the header rather than leaving it to the
    // interceptor, or the ambient default would narrow an "all projects" view back down
    // to one project — the same disagreement in the other direction.
    return {
      ...base,
      headers: { ...(base?.headers ?? {}), [apiConfig.projectHeader]: undefined },
    };
  }

  if (!isValidUuid(projectId)) {
    throw new UnscopedRequestError(
      'Refusing to send an unscoped request: this page has no project selected yet. ' +
        'Guard the call on `project.projectId` (e.g. react-query `enabled: !!project.projectId`). ' +
        'Falling back to the ambient project here would file writes in the wrong project ' +
        'and silently widen reads to every project (an earlier epic §A1).'
    );
  }

  return {
    ...base,
    headers: { ...(base?.headers ?? {}), [apiConfig.projectHeader]: projectId },
  };
}

/**
 * THE GLOBAL READ. A request that must see EVERY project the caller may see, regardless
 * of which project the page (or the pinned ambient header) is on.
 *
 * ── THE DEFECT THIS CLOSES (Reviewer B4, reject round 1) ────────────────────────────
 * `GET /api/projects` is ITSELF project-scoped: `resolveListScope` reads the request's
 * project and, when one is named, narrows the list to exactly that project. Pinning the
 * ambient header to the user's default therefore made `allProjects` a ONE-ELEMENT list —
 * so every `<ProjectSelect>` on all ten pages offered exactly one option, the project you
 * were already on, and the entire rework was inert. Measured as admin with two seeded
 * projects: scoped → hasA true / hasB false; unscoped → hasA true / hasB true.
 *
 * ── WHY THE SENTINEL AND NOT "NO HEADER" ─────────────────────────────────────────────
 * Letting the header resolve to `undefined` would be the permanently-unscoped state §A2
 * exists to make unreachable, and it re-opens the ladder this work closed. Instead this
 * sends the resolver's OWN sentinel, `project_id=all`, from a QUERY source — the one
 * source that accepts it (`services/projectScopeResolver.ts` PROJECT_SCOPE_SOURCES). The
 * resolver reads it as EXPLICITLY UNSCOPED, `resolveListScope` then falls through to
 * "admin → every project, everyone else → their grants", and the F-04 authorization is
 * untouched: the sentinel controls the PROJECT FILTER, never the AUTHORIZATION. A
 * zero-grant non-admin still gets an empty list.
 *
 * Use it ONLY for a read whose whole job is to be global: the project picker's options,
 * and the `/r/<id8>` short-link resolver (a navigation surface that must reach a record
 * outside your default project, §A4). NOT for page data — that is the widening this
 * epic exists to remove.
 */
export const globalReadConfig = (base?: AxiosRequestConfig): AxiosRequestConfig => ({
  ...base,
  params: { ...((base?.params as Record<string, unknown>) ?? {}), project_id: ALL_PROJECTS_SCOPE },
});

/**
 * The non-throwing probe, for code that must ASK rather than act — e.g. a guard test, or
 * a component deciding whether to render a disabled state. Never use it to decide
 * "send unscoped instead": that is the exact fallback this module exists to remove.
 */
export const isScopable = (projectId: string | undefined): boolean =>
  projectId === ALL_PROJECTS_SCOPE || isValidUuid(projectId);
