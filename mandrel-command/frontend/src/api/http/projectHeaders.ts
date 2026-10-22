/**
 * projectHeaders — the ONE place that decides the AMBIENT `X-Project-ID` header
 * (fix the class, centralize the check — no N drifting copies).
 *
 * Both ambient call sites delegate here: the axios request interceptor
 * (services/api.ts) and the generated-OpenAPI header resolver (api/client.ts). They must
 * agree exactly — attaching a corrupt/synthetic/UNASSIGNED id makes the backend project
 * middleware 400 EVERY /api call and wedge the app.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THIS IS THE AMBIENT FALLBACK. IT IS NOT HOW A PAGE SCOPES A REQUEST.
 * ════════════════════════════════════════════════════════════════════════════════════
 * A project-scoped page pins the header per request via `scopedRequestConfig`
 * (api/http/projectScope.ts) from its OWN selection. This resolver only answers for
 * requests nobody scoped, and it is TRANSITIONAL: the end state is deleting it and the
 * localStorage keys entirely. Its remaining consumers are the checklist for that job —
 * the SSE subscription, `api/embeddingsClient.ts`, every `requireWriteProjectId` write
 * that nobody scoped, and both client interceptors.
 *
 * ── THE FALLBACK LADDER (epic 41293984 §A2) ──────────────────────────────────────────
 * The old implementation had ONE rung — the `aidis_selected_project` key — and returned
 * `undefined` the moment that key was missing or corrupt. That is not a safe default: a
 * missing project is read by several backend controllers as "EVERY project", so an
 * absent header does not fail, it silently WIDENS the whole app. The sentinel that used
 * to do this deliberately is deleted; what remained were three accidental routes to the
 * same state — the corrupt-value self-heal below, the current project being nulled when
 * a project is deleted, and the bootstrap error path.
 *
 * Key absence is therefore the wrong enforcement point, and pinning at the React layer
 * cannot fix it because this function runs BELOW React, synchronously, inside an
 * interceptor. So the ladder is here, where the decision actually happens:
 *
 *   1. `aidis_selected_project`   — the ambient project ProjectContext derives.
 *   2. `aidis_current_project`    — the legacy mirror. An independent rung in practice:
 *                                   it survives a purge of (1) and is what
 *                                   embeddingsClient historically read.
 *   3. `aidis_user_settings.defaultProjectId` — the SETTINGS CACHE. Genuinely
 *                                   independent: it is written by SettingsContext from
 *                                   the server's per-user preference, it is not touched
 *                                   by any project-key purge, and it is the value the
 *                                   whole app is pinned to anyway.
 *   4. THE IN-MEMORY MIRROR         — the last ambient project ProjectContext derived,
 *                                   held in this module. See below; this rung is not
 *                                   redundant, it is the only one that survives the
 *                                   failure the other three share.
 *
 * A rung is taken only if it holds a REAL UUID. Corrupt values are still purged (that
 * self-heal is why a wedged dashboard recovers without the user clearing site data) —
 * but purging rung 1 now falls THROUGH to the rungs below instead of going unscoped.
 *
 * ── WHY RUNG 4 EXISTS (MEASURED, not anticipated) ────────────────────────────────────
 * Rungs 1-3 are all localStorage, so they share a single point of failure: anything that
 * wipes storage mid-session takes out the entire ladder at once. That is not theoretical
 * — the §A2 mutation test (`localStorage.clear()` mid-session, then assert the next
 * request still names a project) FAILED against the three-rung version, and it failed in
 * a way React cannot fix: the provider's persist effect is dependency-gated on values
 * that did not change, so a storage wipe is completely invisible to it and nothing
 * re-runs. The app sat unscoped indefinitely.
 *
 * So the last rung deliberately lives OUTSIDE storage, in module memory, written by
 * ProjectContext each time it derives the ambient project (`rememberAmbientProject`).
 * It cannot be purged by the self-heal, cleared by a user, or missed by an effect that
 * did not fire. When it is used, it RE-SEATS the storage keys, so the app heals rather
 * than limping on memory for the rest of the session.
 *
 * ── WHEN EVERY RUNG IS EMPTY ─────────────────────────────────────────────────────────
 * `undefined`, loudly. There is a real, legitimate case (a user with no projects at all),
 * so throwing here would break a valid app state — but it is also indistinguishable at
 * this layer from "the storage was wiped before anything resolved", so it is logged as an
 * error rather than passing quietly. The place that DOES fail loud is
 * `scopedRequestConfig`, which is what every project-scoped page uses; unscoped is
 * unreachable there by construction.
 */
import { isValidUuid, clearStoredProject } from '../../utils/uuid';
import { logger } from '../../utils/logger';
import { resetProjectSelection } from '../../stores/projectSelectionStore';

const STORED_PROJECT_KEY = 'aidis_selected_project';
const LEGACY_PROJECT_KEY = 'aidis_current_project';
const SETTINGS_STORAGE_KEY = 'aidis_user_settings';

/**
 * Rung 4 — the in-memory mirror of the last ambient project ProjectContext derived.
 * Module-scoped on purpose: it must survive a localStorage wipe, and it must NOT survive
 * a page load (on a fresh load the server-backed rungs are authoritative again).
 */
let rememberedAmbientProjectId: string | undefined;

/**
 * Record the ambient project. Called by ProjectContext whenever it derives one.
 *
 * This is the app telling the resolver what it believes, so the resolver has an answer
 * that does not depend on storage still being intact. Passing a non-UUID is a no-op
 * rather than an error: the caller is an effect, and a bad value here should degrade to
 * "no memory rung", never throw inside a render pass.
 */
export const rememberAmbientProject = (projectId: string | undefined): void => {
  if (isValidUuid(projectId)) {
    rememberedAmbientProjectId = projectId;
  }
};

/** Test seam: drop the in-memory rung so a suite can probe the storage rungs alone. */
export const __resetRememberedAmbientProject = (): void => {
  rememberedAmbientProjectId = undefined;
};

/**
 * CLEAR EVERY RUNG OF THE LADDER. Call this when the identity behind the ambient project
 * changes — i.e. on logout, from `resetAuthState`.
 *
 * ── THE DEFECT THIS CLOSES (the reviewer B3, reject round 1) ────────────────────────────
 * `ProjectContext` claimed a user switch needed no handling because "the 401 path
 * navigates to /login, and a real page load drops module memory outright." That is true
 * of the 401 SELF-HEAL (services/api.ts does `window.location.href = '/login'`). It is
 * FALSE of the Logout button: `AuthContext.logout` does
 * `navigate('/login', { replace: true })` — a react-router navigation with NO reload. The
 * module stays loaded, and `resetAuthState` cleared `aidis_token` / `aidis_user` /
 * `aidis-auth` and the query cache but NONE of the four project rungs.
 *
 * Measured consequence: after logout, `resolveProjectHeader()` still returned user A's
 * project id, and rung 4 RE-SEATED it even after a full `localStorage.clear()`. For a
 * non-admin user B every ambient call then 403s under F-04 with no recovery path (this
 * work deleted the switcher, which was the only control that could unwedge it); for an
 * admin B, reads and unscoped writes land in A's project. The localStorage half was
 * pre-existing — what the foundation commit ADDED was two more leaking rungs plus a
 * mechanism that survives `localStorage.clear()`, i.e. it made the stale value STICKIER.
 *
 * ── WHY IT LIVES HERE, NEXT TO THE LADDER ────────────────────────────────────────────
 * The rungs are DEFINED in this file. A clear-function written anywhere else is a second
 * copy of that list, and the two drift the first time a rung is added — which is exactly
 * how this bug was born (rungs 3 and 4 were added and nothing that clears state was told).
 * A fifth rung must be added to `resolveProjectHeader` AND to this function, and they are
 * fifteen lines apart so that is hard to miss.
 */
export const clearAmbientProjectState = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  // Rungs 1 + 2.
  clearStoredProject();

  // Rung 3 — the settings cache. Only `defaultProjectId` is dropped: the rest of the
  // blob (theme, etc.) is not identity-bearing and wiping it would log the next user out
  // of their display preferences for no reason.
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        delete parsed.defaultProjectId;
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(parsed));
      } else {
        localStorage.removeItem(SETTINGS_STORAGE_KEY);
      }
    }
  } catch {
    // Unparseable cache: remove it outright rather than leave a value we cannot inspect.
    try {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch {
      /* storage unavailable — best effort */
    }
  }

  // Rung 4 — the in-memory mirror. THE ONE THAT SURVIVES `localStorage.clear()`, so
  // omitting it here would leave logout strictly worse than it was before rung 4 existed.
  __resetRememberedAmbientProject();

  // UPSTREAM of the ladder: the topbar switch's selection (stores/projectSelectionStore,
  // sessionStorage). Not a rung — the ladder is derived FROM it — but it is identity-
  // bearing state that survives a same-tab logout, so it is cleared from the same place.
  resetProjectSelection();
};

/** Read a `{ id }` blob from a storage key. `'corrupt'` is distinct from `'absent'`. */
const readProjectIdFrom = (key: string): string | undefined | 'corrupt' => {
  const stored = localStorage.getItem(key);
  if (!stored) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stored) as { id?: string } | null;
    if (isValidUuid(parsed?.id)) {
      return parsed!.id as string;
    }
    return 'corrupt';
  } catch {
    return 'corrupt';
  }
};

/** Rung 3: the settings cache, written from the server's per-user preference. */
const readCachedDefaultProjectId = (): string | undefined => {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) {
      return undefined;
    }
    const parsed = JSON.parse(stored) as { defaultProjectId?: string } | null;
    return isValidUuid(parsed?.defaultProjectId) ? parsed!.defaultProjectId : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Resolve the AMBIENT project id for `X-Project-ID`, or `undefined` when no rung of the
 * ladder yields a real UUID. SIDE EFFECT (unchanged, deliberate): purges the stored
 * project keys when they hold a corrupt/unparseable value, so a wedged dashboard heals
 * itself — but the purge now falls through to the remaining rungs rather than leaving
 * the app unscoped.
 */
export const resolveProjectHeader = (): string | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    // Rung 1 — the ambient project.
    const primary = readProjectIdFrom(STORED_PROJECT_KEY);
    if (typeof primary === 'string' && primary !== 'corrupt') {
      return primary;
    }

    // Rung 2 — the legacy mirror. Read BEFORE the purge, since the purge clears both.
    const legacyRaw = readProjectIdFrom(LEGACY_PROJECT_KEY);
    const legacy = typeof legacyRaw === 'string' && legacyRaw !== 'corrupt' ? legacyRaw : undefined;

    if (primary === 'corrupt') {
      // Self-heal: a corrupt stored id would 400 every request. Discard it.
      clearStoredProject();
      if (legacy) {
        // Re-seat the healthy legacy value so the next load starts on rung 1 again.
        localStorage.setItem(STORED_PROJECT_KEY, JSON.stringify({ id: legacy }));
        return legacy;
      }
    } else if (legacy) {
      return legacy;
    }

    // Rung 3 — the settings cache (the user's default project).
    const cachedDefault = readCachedDefaultProjectId();
    if (cachedDefault) {
      return cachedDefault;
    }

    // Rung 4 — the in-memory mirror. The only rung that survives a storage wipe.
    if (rememberedAmbientProjectId) {
      // HEAL, don't limp: re-seat the keys so rungs 1/2 answer next time and every other
      // storage reader (SSE, embeddingsClient) sees a scope again too.
      const payload = JSON.stringify({ id: rememberedAmbientProjectId });
      localStorage.setItem(STORED_PROJECT_KEY, payload);
      localStorage.setItem(LEGACY_PROJECT_KEY, payload);
      logger.warn(
        'resolveProjectHeader: storage rungs were empty; restored the ambient project ' +
          'from the in-memory mirror. Storage was likely cleared mid-session.',
      );
      return rememberedAmbientProjectId;
    }

    logger.error(
      'resolveProjectHeader: NO ambient project on any rung — this request will be ' +
        'sent unscoped, and several backend controllers read that as EVERY project. ' +
        'Expected only when the user genuinely has no projects.'
    );
    return undefined;
  } catch (error) {
    logger.warn('resolveProjectHeader: purging corrupt stored project', error);
    clearStoredProject();
    return readCachedDefaultProjectId() ?? rememberedAmbientProjectId;
  }
};
