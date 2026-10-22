/**
 * SettingsContext — the user's own settings, with the DEFAULT PROJECT as its
 * load-bearing value (epic 41293984 §A).
 *
 * ── WHAT CHANGED AND WHY ─────────────────────────────────────────────────────────────
 * This context used to hold `defaultProject`: a project NAME, seeded by fetching
 * `/api/projects` and looking for the instance-wide `metadata.is_primary` flag, and
 * written by POSTing `set-primary` / `clear-primary`. Two defects were baked into that:
 *
 *   1. IT WAS NOT PER-USER. `is_primary` is a flag on the shared `projects` table, and
 *      `clearPrimary` clears it with no user scoping at all — one user clearing their
 *      default cleared it for EVERYONE on the instance.
 *   2. IT WAS A NAME. Renaming a project silently broke the saved default, because the
 *      stored string stopped resolving.
 *
 * Now it holds `defaultProjectId` — a UUID, read from and written to the per-user
 * `PATCH/GET /api/users/preferences`. The rename bug is gone by construction. The
 * instance-level `set-primary`/`clear-primary` endpoints are LEFT ALONE (they have
 * non-UI consumers, e.g. mcp-server bootstrap); this file simply stops depending on them.
 *
 * ── LOCALSTORAGE IS A CACHE, NEVER THE SOURCE OF TRUTH ───────────────────────────────
 * The stored value exists only so a reload paints the right project name before the
 * network answers. The server always wins on arrival, including when the server says
 * "no default" — otherwise a default cleared on another device would resurrect itself
 * here forever. The one thing the cache is NOT allowed to do is override a fetched
 * answer; see the reconcile in the seeding effect.
 *
 * ── WHY THE NAME IS DERIVED HERE AND NOT IN ProjectContext ───────────────────────────
 * ProjectContext consumes THIS context (it derives its pinned project from
 * `defaultProjectId`), so it cannot be the source of the display name without a cycle.
 * This provider therefore keeps its own lightweight project-list read — the same
 * `/api/projects` fetch it already performed before this change — purely to turn the id
 * into a label. `defaultProjectName` is DERIVED on every render and never persisted:
 * a persisted name is the rename bug coming back in through the cache.
 */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
} from 'react';
import { UserSettings } from '../types/settings';
import { useAuthContext } from './AuthContext';
import { logger } from '../utils/logger';
import { isValidUuid } from '../utils/uuid';
import { isAuthedByToken, AUTH_TOKEN_CHANGED_EVENT } from '../utils/authToken';
import { api } from '../api';

const SETTINGS_STORAGE_KEY = 'aidis_user_settings';

interface UseSettingsReturn {
  /** The user's default project as a UUID. `undefined` = none set. */
  defaultProjectId: string | undefined;
  /**
   * Display name for `defaultProjectId`, derived from the project list. `undefined`
   * when no default is set OR while the list is still loading — a consumer must render
   * an explicit affordance for that, never a blank (see pages/settings/ProjectsSection).
   */
  defaultProjectName: string | undefined;
  /** Persist the user's default project (UUID), or `null` to clear it. */
  setDefaultProjectId: (projectId: string | null) => Promise<void>;
  /** Convenience alias for `setDefaultProjectId(null)`. */
  clearDefaultProject: () => Promise<void>;
  /** True until the server's answer for this login has arrived (or failed). */
  loadingDefaultProject: boolean;
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => void;
}

const SettingsContext = createContext<UseSettingsReturn | undefined>(undefined);

/**
 * Read the cached settings. A cached `defaultProjectId` that is not a real UUID is
 * DISCARDED rather than trusted — the old cache shape stored a project NAME under
 * `defaultProject`, and letting that through would put a name where every consumer now
 * expects an id (and would send it as X-Project-ID). This is the upgrade path for a
 * browser that has the pre-41293984 cache.
 */
const readStoredSettings = (): UserSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<UserSettings> & { defaultProject?: unknown };
      const cachedId = parsed?.defaultProjectId;
      return {
        darkMode: parsed?.darkMode,
        defaultProjectId: isValidUuid(cachedId) ? (cachedId as string) : undefined,
      };
    }
  } catch (error) {
    logger.warn('Failed to load user settings from localStorage:', error);
  }
  return { defaultProjectId: undefined };
};

interface ProjectLite {
  id: string;
  name: string;
}

export const SettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuthContext();
  const [settings, setSettings] = useState<UserSettings>(readStoredSettings);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loadingDefaultProject, setLoadingDefaultProject] = useState(true);
  const seededRef = useRef(false);

  // Persist to localStorage — CACHE ONLY (fast first paint on the next load).
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      logger.error('Failed to save user settings to localStorage:', error);
    }
  }, [settings]);

  /**
   * DROP THE DEFAULT PROJECT WHEN THE TOKEN GOES AWAY (the reviewer B3).
   *
   * `resetAuthState` clears the four storage/memory rungs, but THIS provider holds a
   * FIFTH copy in React state, and the persist effect above would write user A's id
   * straight back into `aidis_user_settings` on the next settings change. Until user B's
   * preference fetch returns, `defaultProjectId` would still be A's — which is what
   * `ProjectContext` derives its pinned project from.
   *
   * KEYED ON THE TOKEN-CHANGED EVENT, NOT ON `isAuthenticated`. `isAuthenticated` is
   * false transiently on every COLD BOOT while the profile query resolves, so resetting
   * on it would wipe the cache on every page load — destroying the fast-first-paint the
   * cache exists for and knocking out resolver rung 3 at exactly the moment nothing else
   * has answered yet. The event fires only when a token is actually written or removed;
   * on removal (logout) we reset, on a write (login) we do not.
   */
  useEffect(() => {
    const onTokenChanged = () => {
      if (isAuthedByToken()) {
        return;
      }
      setSettings((prev) =>
        prev.defaultProjectId === undefined ? prev : { ...prev, defaultProjectId: undefined },
      );
      // The label list belongs to the previous user too.
      setProjects((prev) => (prev.length === 0 ? prev : []));
    };
    window.addEventListener(AUTH_TOKEN_CHANGED_EVENT, onTokenChanged);
    return () => window.removeEventListener(AUTH_TOKEN_CHANGED_EVENT, onTokenChanged);
  }, []);

  // Seed from the SERVER once per authenticated session: the per-user preference is the
  // source of truth, the cache is only a paint optimisation.
  useEffect(() => {
    if (!isAuthenticated) {
      seededRef.current = false;
      setLoadingDefaultProject(true);
      return;
    }
    if (seededRef.current) {
      return;
    }
    seededRef.current = true;

    let cancelled = false;

    (async () => {
      // The project list — for the DISPLAY NAME only. Never for the id itself.
      try {
        const list = await api.projects.list();
        if (!cancelled) {
          setProjects(list.map((p) => ({ id: p.id as string, name: p.name as string })));
        }
      } catch (error) {
        logger.warn('Failed to load projects for default-project label:', error);
      }

      // The per-user preference — the source of truth for the id.
      try {
        const prefs = await api.users.getPreferences();
        if (cancelled) {
          return;
        }
        // The server WINS, including when it says null — that is how a default cleared
        // on another device stops resurrecting from this browser's cache.
        setSettings((prev) => {
          const next = prefs.defaultProjectId ?? undefined;
          if (prev.defaultProjectId === next) {
            return prev;
          }
          return { ...prev, defaultProjectId: next };
        });
      } catch (error) {
        // COULD NOT MEASURE. Deliberately distinct from "the server says none": the
        // cached id is NOT cleared here, because a transient 5xx must not look like the
        // user deleting their own preference (C1 — an instrument has three states).
        logger.warn('Could not read user preferences; keeping cached default project', error);
      } finally {
        if (!cancelled) {
          setLoadingDefaultProject(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  /**
   * THE ONE WRITER for the default project. Everything that changes it (the Settings
   * control, ProjectDetail's "set as my default") calls this, so there is a single
   * place that talks to the endpoint and a single place that updates local state.
   *
   * The write RE-THROWS on failure. The default project is an authorization-checked
   * value — the backend refuses a project this user cannot see — so a caller must be
   * able to show that refusal rather than optimistically painting a change that did
   * not happen.
   */
  const setDefaultProjectId = useCallback(async (projectId: string | null) => {
    // Explicit null = clear. Omitting the key would mean "leave it alone".
    const prefs = await api.users.updatePreferences({ defaultProjectId: projectId });
    // Trust the SERVER's echo, not the value we sent — the backend is what authorized it.
    setSettings((prev) => ({ ...prev, defaultProjectId: prefs.defaultProjectId ?? undefined }));
  }, []);

  const clearDefaultProject = useCallback(async () => {
    await setDefaultProjectId(null);
  }, [setDefaultProjectId]);

  const updateSettings = useCallback((updates: Partial<UserSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const defaultProjectName = useMemo(() => {
    if (!settings.defaultProjectId) {
      return undefined;
    }
    return projects.find((p) => p.id === settings.defaultProjectId)?.name;
  }, [projects, settings.defaultProjectId]);

  const value: UseSettingsReturn = {
    defaultProjectId: settings.defaultProjectId,
    defaultProjectName,
    setDefaultProjectId,
    clearDefaultProject,
    loadingDefaultProject,
    settings,
    updateSettings,
  };

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

export const useSettings = (): UseSettingsReturn => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};

export default SettingsContext;
