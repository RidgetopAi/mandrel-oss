/**
 * projectSelectionStore — the ONE project switch.
 *
 * ── WHAT THIS HOLDS ──────────────────────────────────────────────────────────────────
 * The project the user picked in the topbar switch: a project UUID, or `undefined`
 * meaning "nothing picked — use the Settings default". Every project-scoped page reads
 * its scope from this (via `usePageProject`), and the ambient `X-Project-ID` header
 * follows it (contexts/ProjectContext).
 *
 * ── WHY localStorage, KEYED TO THE LOGIN (an earlier walkthrough F1) ───────────────────
 * The operator's done-when: "Once selected it stays showing that project's data until logged
 * back in where it goes back to 'Default' project from Settings or user re-selects."
 * The first cut used sessionStorage and a NEW TAB in the same login reverted to the
 * default — that is not "until logged back in". So the pick lives in localStorage and is
 * bounded by the login two ways:
 *   • `resetProjectSelection()` runs on logout (`clearAmbientProjectState`) AND on login
 *     success (`useLogin.onSuccess`, which also covers the 401 self-heal reload);
 *   • the pick is stored WITH the username that made it (`owner`), and `currentSelection`
 *     only honours it for that same user — so even a tab that missed the reset (opened
 *     before another user logged in elsewhere) never inherits a different user's project.
 * A zustand `persist` store like `authStore.ts`.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────
 * Not the ambient header ladder (api/http/projectHeaders.ts) — that ladder only holds
 * REAL UUIDs and is what the interceptor reads synchronously; ProjectContext derives its
 * `currentProject` from this selection and the header is pinned to that. There is no
 * "All projects" entry on the switch (walkthrough F2): a pick is always ONE project.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { isValidUuid } from '../utils/uuid';

/** The localStorage key. One name, referenced by the logout/login teardown tests. */
export const PROJECT_SELECTION_STORAGE_KEY = 'mandrel-project-selection';

/** Where the logged-in identity lives (utils/authToken USER_KEY) — read, never written here. */
const USER_STORAGE_KEY = 'aidis_user';

export interface ProjectSelectionState {
  /** A project UUID, or `undefined` (= the Settings default governs). */
  selectedProjectId: string | undefined;
  /** The username that made the pick. A pick is only honoured for its owner. */
  owner: string | undefined;
  /** The topbar switch's onChange. Records the current user as owner. */
  select: (projectId: string) => void;
  /** Drop the selection: logout, and a fresh login. */
  reset: () => void;
}

const localStorageOrNoop = (): Storage => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    /* storage unavailable (privacy mode) — fall through to the no-op */
  }
  const noop: Storage = {
    length: 0,
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: () => undefined,
  };
  return noop;
};

/** The logged-in username, from the same storage key the auth layer writes. */
export const readCurrentUsername = (): string | undefined => {
  try {
    const raw = localStorageOrNoop().getItem(USER_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { username?: unknown } | null;
    return typeof parsed?.username === 'string' ? parsed.username : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The selection THIS user may see: a real UUID picked by the current username, else
 * `undefined`. This is the ONE read path — ProjectContext subscribes with it — so a pick
 * made by a different login (or with no login recorded) is never a scope.
 */
export const currentSelection = (state: ProjectSelectionState): string | undefined => {
  if (!isValidUuid(state.selectedProjectId)) {
    return undefined;
  }
  const user = readCurrentUsername();
  if (!user || state.owner !== user) {
    return undefined;
  }
  return state.selectedProjectId;
};

export type ProjectSelectionStore = UseBoundStore<StoreApi<ProjectSelectionState>>;

/**
 * Build a store instance over the shared localStorage key. The app uses the singleton
 * below; a test creates a second instance to stand in for a NEW TAB, which is exactly
 * a fresh instance rehydrating from the same storage.
 */
export const createProjectSelectionStore = (): ProjectSelectionStore =>
  create<ProjectSelectionState>()(
    persist(
      (set) => ({
        selectedProjectId: undefined,
        owner: undefined,
        select: (projectId: string) =>
          set({ selectedProjectId: projectId, owner: readCurrentUsername() }),
        reset: () => set({ selectedProjectId: undefined, owner: undefined }),
      }),
      {
        name: PROJECT_SELECTION_STORAGE_KEY,
        storage: createJSONStorage(localStorageOrNoop),
        partialize: (state) => ({ selectedProjectId: state.selectedProjectId, owner: state.owner }),
      },
    ),
  );

export const useProjectSelectionStore: ProjectSelectionStore = createProjectSelectionStore();

/**
 * Non-React entry point for the teardown paths (`resetAuthState`, `useLogin.onSuccess`).
 * Clears the in-memory state AND the persisted copy, so neither a same-tab logout (a
 * react-router navigation, no reload) nor the next login can read the previous pick.
 */
export const resetProjectSelection = (): void => {
  useProjectSelectionStore.getState().reset();
  try {
    localStorageOrNoop().removeItem(PROJECT_SELECTION_STORAGE_KEY);
  } catch {
    /* best effort */
  }
};
