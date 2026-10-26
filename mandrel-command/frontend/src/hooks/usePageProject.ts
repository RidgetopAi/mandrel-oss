/**
 * usePageProject — a page's project scope, read from THE ONE SWITCH in the topbar
 * (supersedes the per-page selectors of an earlier epic
 * §D).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  HOW TO USE THIS. This hook is the entire API for a scoped page.
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 *     const project = usePageProject();                    // the topbar's project
 *
 *     // READS — name the project in the query AND scope the request:
 *     useQuery({
 *       queryKey: ['contexts', project.projectId],
 *       enabled: project.ready,
 *       queryFn: () => api.contexts.search({ project_id: project.projectId }, project.scope()),
 *     });
 *
 *     // WRITES — the scope() is NOT optional. See "WRITES" below.
 *     api.decisions.create(body, project.scope());
 *
 * A page renders NO project selector of its own. The switch lives in
 * `components/shell/ProjectSwitch` and every page reads it here; a wiring guard
 * (`pages/noPageProjectSelect.guard.test.ts`) fails the build if a page grows one back.
 *
 * ── FOUR RULES, AND NOTHING ELSE ─────────────────────────────────────────────────────
 *
 * 1. ALWAYS PASS `project.scope()` — on reads and, especially, on WRITES.
 *    A query param scopes a READ. It does nothing for a write: writes carry no query
 *    params, and the backend's write precedence is HEADER > body. `scope()` pins
 *    `X-Project-ID` to THIS page's project for THAT request, which is what keeps an
 *    "All projects" page's write from landing wherever the ambient header points.
 *
 * 2. GUARD ON `project.ready`. `scope()` THROWS when there is no project rather than
 *    falling back to ambient — a silent fallback is the bug in rule 1. `ready` is the
 *    non-throwing way to ask.
 *
 * 3. PUT `project.projectId` IN THE QUERY KEY. It is state; a cache keyed without it
 *    serves the previous project's rows after a switch.
 *
 * 4. A PAGE ALWAYS SHOWS ONE PROJECT. There is no "All projects" on the switch
 *    (an earlier walkthrough F2), and a `?project=all` deep link is ignored like any other
 *    unselectable value. Endpoints that accept the `all` sentinel still do — nothing on a
 *    page hands it to them any more. Print `projectName` in the page header: it is the
 *    truth line for what the page is showing.
 *
 * ── WHERE THE SELECTION LIVES ────────────────────────────────────────────────────────
 * In `stores/projectSelectionStore` (localStorage, owned by the username that picked
 * it), surfaced by ProjectContext as `selectedProjectId`. It holds across tabs,
 * navigation and reload; logout and a fresh login reset it to the Settings default.
 *
 * ── `?project=` IS A DEEP LINK, AND IT SETS THE SWITCH (§A4, amended) ────────────────
 * A URL carrying `?project=<id>` wins for that page load — the `/r/<id8>` short-link
 * case, a shared link, a bookmark — and is ADOPTED into the switch once the project list
 * confirms it names something this user can select, so the topbar never shows one
 * project while the page renders another. Any later switch (topbar, or a record page
 * following its record via `setProjectId`) drops the param from the URL so the two
 * cannot disagree afterwards. A stale or hand-typed id is IGNORED (falling through to
 * the selection / default) rather than sent: the backend would 403 it under the F-04
 * access check, wedging the page on every request with an error the user cannot act on.
 */
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProjectContext } from '../contexts/ProjectContext';
import { useSettings } from './useSettings';
import type { ProjectSelectItem } from '../components/ui/ProjectSelect';
import { scopedRequestConfig, isScopable } from '../api/http/projectScope';
import { isValidUuid } from '../utils/uuid';
import type { AxiosRequestConfig } from 'axios';

/** The URL param a deep link may carry. One name, everywhere. */
export const PROJECT_URL_PARAM = 'project';

export interface UsePageProject {
  /**
   * The project this page is scoped to: a UUID, or `undefined` while the project list
   * is still loading (or could not be read).
   */
  projectId: string | undefined;
  /** The selected project's display name — print it in the page header. */
  projectName: string | undefined;
  /**
   * Move THE switch (and drop any `?project=` override from the URL). Used by record
   * pages following the record they show (`useRecordProjectSync`); the topbar has its
   * own path to the same store.
   */
  setProjectId: (projectId: string) => void;
  /** True while the project list is loading. */
  loading: boolean;
  /**
   * The project list could not be READ, so this page has no resolved scope and cannot
   * get one. A page must render this as its own state: `ready` is false here for the
   * same reason it is false while loading, and a page that only checks `ready` shows an
   * empty result set — which reads as "your project has nothing in it".
   */
  unavailable: boolean;
  /**
   * True when `scope()` will succeed. Use it as the `enabled` guard on every query and
   * to disable write actions — it is the non-throwing form of the same question.
   */
  ready: boolean;
  /**
   * The axios config that pins `X-Project-ID` to THIS page's project for one request.
   * Pass it to every `api.*` call this page makes. THROWS when the page has no project
   * (guard on `ready`) — deliberately, because the alternative is a silent write into
   * the wrong project.
   */
  scope: (base?: AxiosRequestConfig) => AxiosRequestConfig;
  /** The selectable projects (id + name), in the ONE central order. For labels/forms. */
  projects: ProjectSelectItem[];
}

export function usePageProject(): UsePageProject {
  // Relies on an invariant enforced OUTSIDE this file: no scoped page mounts while
  // authentication is unresolved (components/ProtectedRoute.tsx), which is what stops
  // the projects query's disabled state from being read here as an unreadable list.
  const { allProjects, loading, projectsUnavailable, selectedProjectId, setSelectedProjectId } =
    useProjectContext();
  const { defaultProjectId } = useSettings();
  const [searchParams, setSearchParams] = useSearchParams();

  const projects = React.useMemo<ProjectSelectItem[]>(
    () => allProjects.map((p) => ({ id: p.id, name: p.name })),
    [allProjects],
  );

  const fromUrl = searchParams.get(PROJECT_URL_PARAM) ?? undefined;

  /**
   * "The list has answered" — positively (rows) or negatively (unreadable). While it is
   * still loading, or has loaded EMPTY without an error, a URL value cannot be told
   * apart from "not loaded yet" and is held provisionally (C1 — do not spell "could not
   * measure" the same way as "no").
   */
  const listSettled = !loading && (projects.length > 0 || projectsUnavailable);

  /** The `?project=` value, validated: a selectable id, or `undefined`. */
  const urlSelection = React.useMemo<string | undefined>(() => {
    if (!fromUrl) {
      return undefined;
    }
    // Unvalidatable, and nothing on this page can succeed anyway. Honouring it would let
    // a `?project=all` written during an earlier outage present itself as a resolved
    // scope on every subsequent load.
    if (projectsUnavailable) {
      return undefined;
    }
    if (!isValidUuid(fromUrl)) {
      return undefined;
    }
    if (!listSettled) {
      return fromUrl; // provisional
    }
    return projects.some((p) => p.id === fromUrl) ? fromUrl : undefined;
  }, [fromUrl, listSettled, projects, projectsUnavailable]);

  /**
   * ADOPT the deep link into the switch, once the list can vouch for it. The param is
   * left in the URL (a reload of a shared link must still land on that project); the
   * next explicit switch removes it (see `setProjectId` and shell/ProjectSwitch).
   *
   * ONCE PER URL VALUE. A switch to B writes the store first and drops the param second,
   * and those two updates are not guaranteed to land in one render: in between, the URL
   * still says A while the store says B, and an effect that re-adopts whenever they
   * differ would put A straight back — the user's pick discarded on the next tick
   * (measured in Decisions.scope.test "FOLLOWS it"). So each URL value is decided about
   * exactly once; after that the store owns the selection until the param changes.
   */
  const adoptedUrl = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!fromUrl) {
      adoptedUrl.current = undefined; // the param is gone; a later one adopts afresh
      return;
    }
    if (!listSettled || adoptedUrl.current === fromUrl) {
      return;
    }
    adoptedUrl.current = fromUrl;
    if (urlSelection && urlSelection !== selectedProjectId) {
      setSelectedProjectId(urlSelection);
    }
  }, [fromUrl, listSettled, urlSelection, selectedProjectId, setSelectedProjectId]);

  /**
   * The switch's selection, validated the same way. A UUID that the list does not
   * contain (deleted, access revoked, or a leftover from another login) falls through to
   * the default rather than being sent.
   */
  const storeSelection = React.useMemo<string | undefined>(() => {
    if (!selectedProjectId || projectsUnavailable) {
      return undefined;
    }
    return projects.some((p) => p.id === selectedProjectId) ? selectedProjectId : undefined;
  }, [selectedProjectId, projects, projectsUnavailable]);

  const fallback = React.useMemo<string | undefined>(() => {
    if (defaultProjectId && projects.some((p) => p.id === defaultProjectId)) {
      return defaultProjectId;
    }
    // No default set, or it no longer resolves: the first project in the centrally
    // sorted list (most recently active). Never `undefined` while a project exists —
    // a page sitting on "no project" is what reads Mandrel-wide. An unreadable list
    // yields `undefined` here by construction, which is why this needs no branch of
    // its own: every rung above is a lookup INTO that list.
    return projects[0]?.id;
  }, [defaultProjectId, projects]);

  const projectId = urlSelection ?? storeSelection ?? fallback;

  const setProjectId = React.useCallback(
    (next: string) => {
      setSelectedProjectId(next);
      // The URL override must not outlive the switch that replaced it.
      if (searchParams.has(PROJECT_URL_PARAM)) {
        setSearchParams(
          (prev) => {
            const params = new URLSearchParams(prev);
            params.delete(PROJECT_URL_PARAM);
            return params;
          },
          { replace: true },
        );
      }
    },
    [setSelectedProjectId, searchParams, setSearchParams],
  );

  const projectName = React.useMemo(
    () => projects.find((p) => p.id === projectId)?.name,
    [projectId, projects],
  );

  const ready = isScopable(projectId);

  const scope = React.useCallback(
    (base?: AxiosRequestConfig) => scopedRequestConfig(projectId, base),
    [projectId],
  );

  return {
    projectId,
    projectName,
    setProjectId,
    loading,
    unavailable: projectsUnavailable,
    ready,
    scope,
    projects,
  };
}

export default usePageProject;
