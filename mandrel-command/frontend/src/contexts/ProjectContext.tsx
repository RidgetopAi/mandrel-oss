import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  ReactNode,
} from 'react';
import type { Project } from '../types/project';
import { useProjects, useAllSessions } from '../hooks/useProjects';
import { useAuthContext } from './AuthContext';
import { useErrorHandler } from '../hooks/useErrorHandler';
import { useSettings } from '../hooks/useSettings';
import { logger } from '../utils/logger';
import { isValidUuid } from '../utils/uuid';
import { sortProjectsByRecentActivity } from '../utils/projectSort';
import { selectFallbackProject } from './projectResolution';
import {
  rememberAmbientProject,
  __resetRememberedAmbientProject,
} from '../api/http/projectHeaders';
import { useProjectSelectionStore, currentSelection } from '../stores/projectSelectionStore';

const UNASSIGNED_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
const STORED_PROJECT_KEY = 'aidis_selected_project';
const LEGACY_STORED_PROJECT_KEY = 'aidis_current_project';

/**
 * ProjectContext — the AMBIENT project scope: the topbar switch's selection, falling
 * back to the user's default project (an earlier punch over epic 41293984 §C).
 *
 * ── WHAT THIS CONTEXT IS ─────────────────────────────────────────────────────────────
 * It is not a UI widget's state. The project it holds is written to localStorage
 * (`aidis_selected_project`) and that value IS the `X-Project-ID` header on every API
 * call (api/http/projectHeaders.ts), and it drives the SSE subscription
 * (contexts/SseContext.tsx). It is the app's ambient scope.
 *
 * ── ONE SWITCH, IN THE SHELL ─────────────────────────────────────────────────────────
 * Epic 41293984 replaced the topbar switcher with a selector on every page, because two
 * competing mechanisms (ambient + per-page) left users unable to tell which governed the
 * page in front of them. an earlier Punch (the operator) settles it the OTHER
 * way: there is exactly ONE switch, in the topbar (shell/ProjectSwitch), and every page
 * reads it through `usePageProject`. The selection lives in
 * `stores/projectSelectionStore` (localStorage, owned by the username that picked it): it
 * holds across tabs and reloads, and a logout or a fresh login drops it back to the
 * Settings default. Nothing else moves the ambient scope — a `?project=` deep link SETS
 * the switch rather than bypassing it.
 *
 * ── THE INVARIANT THIS FILE EXISTS TO HOLD ───────────────────────────────────────────
 *     WHILE ANY REAL PROJECT EXISTS, THE AMBIENT HEADER RESOLVES TO ONE.
 *
 * The failure mode being closed is the whole app silently going Mandrel-wide: several
 * backend controllers treat a MISSING project as "all projects", so a resolver returning
 * `undefined` does not error — it quietly widens every unscoped read to every project's
 * records. That is exactly what the deleted global "All Projects" sentinel did, and its
 * mechanism was *removing the localStorage keys*. There is no longer any code path in
 * this provider that removes them while a real project is resolvable.
 *
 * ── THE THIRD STATE (C1) ─────────────────────────────────────────────────────────────
 * "The project list has not loaded yet" is NOT "there are no projects". The persist
 * effect below branches on those separately: it only clears the cached keys once the
 * list has positively loaded and still yields nothing. Collapsing the two would clear
 * the header on every cold start — the exact silent widening above, on every reload.
 *
 * ── NO "ALL PROJECTS" ON THE SWITCH ──────────────────────────────────────────────────
 * The switch offers ONE project at a time (walkthrough ed6ae449 F2): the punch did not
 * ask for a global "all", and a page that cannot render it would silently show the
 * default under a topbar saying "All". The old localStorage-key-removing sentinel is
 * gone too; `currentProject` is always a real project while one exists.
 */

interface ProjectContextType {
  /**
   * The ambient project: the topbar selection when it names a real project the user
   * can see, else DERIVED from the user's default project, else a durable real-UUID
   * fallback. `null` only when no real project exists at all.
   */
  currentProject: Project | null;
  /**
   * The topbar selection as THIS login may see it: a project UUID, or `undefined`
   * (nothing picked — the default governs). Never a sentinel.
   */
  selectedProjectId: string | undefined;
  /** THE ONE WRITER of the ambient scope — the topbar switch, and `?project=` adoption. */
  setSelectedProjectId: (projectId: string) => void;
  allProjects: Project[];
  loading: boolean;
  /**
   * THE THIRD STATE (C1): the project list could not be READ, as distinct from "this
   * user has no projects". `loading` is false in both, and `allProjects` is empty in
   * both, so a consumer that branches only on those two spells could-not-measure the
   * same way as a measured zero — which is how a selector ends up offering a scope the
   * user never asked for while the server is unreachable.
   */
  projectsUnavailable: boolean;
  refreshProjects: () => Promise<Project[]>;
  error: unknown;
  clearError: () => void;
  hasError: boolean;
  /**
   * The real-UUID project id a project-specific page uses when it has nothing more
   * specific. Identical to `currentProject?.id` now that the scope is pinned; kept as a
   * named concept because ~10 pages read it and it states the guarantee the raw field
   * does not: NEVER a sentinel, ALWAYS a real UUID or `undefined`.
   */
  defaultScopedProjectId: string | undefined;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

interface ProjectProviderProps {
  children: ReactNode;
}

export const ProjectProvider: React.FC<ProjectProviderProps> = ({ children }) => {
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { defaultProjectId } = useSettings();
  // Owner-checked: a pick made under another login reads as "nothing picked".
  const selectedProjectId = useProjectSelectionStore(currentSelection);
  const setSelectedProjectId = useProjectSelectionStore((s) => s.select);

  const {
    data: projectsResponse,
    isLoading: projectsLoading,
    error: projectsError,
    refetch: refetchProjects,
  } = useProjects({}, { enabled: isAuthenticated && !authLoading });

  const {
    data: sessionsResponse,
    isLoading: sessionsLoading,
    error: sessionsError,
  } = useAllSessions();

  // The list is ordered most-recently-active first here — the ONE central sort, so every
  // selector reading `allProjects` (the shared ProjectSelect on every page) inherits the
  // ordering without re-sorting.
  const allProjects = useMemo(() => {
    if (!projectsResponse) {
      return [];
    }
    const projects =
      projectsResponse.projects && projectsResponse.projects.length > 0
        ? projectsResponse.projects
        : projectsResponse.data?.projects || [];
    return sortProjectsByRecentActivity(projects);
  }, [projectsResponse]);

  const allSessions = useMemo(() => sessionsResponse?.data?.sessions || [], [sessionsResponse]);
  const loading = projectsLoading || sessionsLoading;

  const errorHandler = useErrorHandler({
    componentName: 'ProjectProvider',
    enableAutoRetry: true,
    maxRetries: 3,
    showUserMessages: false,
    // Do NOT write 'error' telemetry contexts from this always-mounted provider.
    // Doing so is a feedback loop by construction: the write emits a `contexts`
    // SSE event → invalidate → the Contexts page refetches → if that errors again
    // → another error context → … never settles (the Contexts flashing bug).
    reportToAidis: false,
  });

  /**
   * THE DERIVATION. Three rungs, all guaranteed to yield a real UUID:
   *   0. the topbar selection, matched BY ID against the loaded list. A selection that
   *      no longer resolves (deleted / access revoked) falls through — an unresolvable
   *      pick must not be able to widen the app to every project;
   *   1. the user's default project, matched BY ID against the loaded list;
   *   2. the durable fallback (last-active session → most-recently-active → bootstrap →
   *      first real project), which is also what a user with no default set gets.
   * `null` only when rung 2 finds no real project either — i.e. genuinely no projects.
   */
  const currentProject = useMemo<Project | null>(() => {
    if (selectedProjectId && isValidUuid(selectedProjectId)) {
      const picked = allProjects.find(
        (p) => p.id === selectedProjectId && p.id !== UNASSIGNED_PROJECT_ID,
      );
      if (picked) {
        return picked;
      }
    }
    if (defaultProjectId) {
      const pinned = allProjects.find(
        (p) => p.id === defaultProjectId && p.id !== UNASSIGNED_PROJECT_ID && isValidUuid(p.id),
      );
      if (pinned) {
        return pinned;
      }
      // The default no longer resolves (project deleted, or access revoked). Fall
      // through rather than going unscoped: an unresolvable preference must not be able
      // to widen the app to every project.
      if (allProjects.length > 0) {
        logger.warn(
          'Default project did not resolve in the project list; falling back',
          defaultProjectId,
        );
      }
    }
    return selectFallbackProject(allProjects, allSessions, defaultProjectId);
  }, [allProjects, allSessions, defaultProjectId, selectedProjectId]);

  /**
   * Persist the ambient project so `resolveProjectHeader()` can read it synchronously on
   * the very next request.
   *
   * THE CLEAR BRANCH IS THE DANGEROUS ONE and is deliberately narrow: the keys are
   * removed ONLY when the project list has positively LOADED and contains no real
   * project. While the list is still loading, or a fetch failed, the previous cached id
   * is left in place — a "could not measure" must not be spelled the same way as
   * "there are none", or every cold start would briefly send no header and read
   * Mandrel-wide.
   */
  useEffect(() => {
    if (currentProject && currentProject.id !== UNASSIGNED_PROJECT_ID) {
      // The in-memory rung of the resolver's ladder. It is what answers when storage is
      // wiped mid-session — a case this effect CANNOT detect, because its dependencies
      // do not change when localStorage does, so nothing re-runs and the app would
      // otherwise sit unscoped (measured; see projectHeaders.ts rung 4).
      rememberAmbientProject(currentProject.id);
      const payload = JSON.stringify(currentProject);
      localStorage.setItem(STORED_PROJECT_KEY, payload);
      // Legacy key kept in sync — api/embeddingsClient.ts and older readers still look
      // at it, and a half-updated pair is how the two disagree.
      localStorage.setItem(LEGACY_STORED_PROJECT_KEY, payload);
      return;
    }

    const listHasLoaded = !projectsLoading && !projectsError;
    if (listHasLoaded && allProjects.length === 0) {
      // Positively measured: this user has no projects. A stale cached id here would be
      // a project they can no longer see, which the backend now 403s (F-04). The
      // resolver's in-memory rung is dropped with them — otherwise it would helpfully
      // re-seat the very id we just decided is not valid for this user.
      //
      // A USER SWITCH IS HANDLED ELSEWHERE — and this comment used to claim, wrongly,
      // that it needed no handling at all. The claim was true of ONE path and false of
      // the other: the 401 self-heal does `window.location.href = '/login'`
      // (services/api.ts), a real page load that drops module memory — but the Logout
      // button does `navigate('/login', { replace: true })` (AuthContext), a react-router
      // navigation with NO reload, so module memory and every storage rung survived it
      // and user B inherited user A's project. That is now cleared in
      // `clearAmbientProjectState()`, called from `resetAuthState()` — the one place both
      // logout paths go through. Do not re-derive the rung list here.
      __resetRememberedAmbientProject();
      localStorage.removeItem(STORED_PROJECT_KEY);
      localStorage.removeItem(LEGACY_STORED_PROJECT_KEY);
    }
  }, [currentProject, projectsLoading, projectsError, allProjects.length]);

  const refreshProjects = useCallback(async (): Promise<Project[]> => {
    try {
      const result = await refetchProjects();
      // No reconciliation needed: `currentProject` is derived from this same list, so it
      // re-derives on its own. (The old implementation had to hand-patch the selected
      // project here, and that hand-patch is where it could set it to null.)
      return result.data?.projects || [];
    } catch (error) {
      logger.error('Failed to refresh projects:', error);
      return [];
    }
  }, [refetchProjects]);

  const value: ProjectContextType = {
    currentProject,
    selectedProjectId,
    setSelectedProjectId,
    allProjects,
    loading,
    // Only when the read FAILED and left us with nothing. A stale-but-present list from
    // a previous successful fetch is still a usable answer, so it is not "unavailable";
    // narrowing on `allProjects.length` keeps a background refetch error from blanking a
    // working selector. `sessionsError` is deliberately not consulted — it does not
    // govern the project list.
    projectsUnavailable: !!projectsError && allProjects.length === 0,
    refreshProjects,
    error: errorHandler.error || projectsError || sessionsError,
    clearError: errorHandler.clearError,
    hasError: errorHandler.hasError || !!projectsError || !!sessionsError,
    defaultScopedProjectId: currentProject?.id,
  };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProjectContext = (): ProjectContextType => {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    throw new Error('useProjectContext must be used within a ProjectProvider');
  }
  return context;
};

/**
 * The real-UUID ambient project id. NEVER a sentinel; `undefined` only when no real
 * project exists (→ the page shows its honest empty state). A project-scoped page should
 * use `usePageProject()` instead — it adds `scope()`, `ready`, and the "all" handling.
 */
export const useEffectiveProjectId = (): string | undefined =>
  useProjectContext().currentProject?.id;

export default ProjectContext;
