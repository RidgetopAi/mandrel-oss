/**
 * lastVisitedPath — "which screen was the user actually on?"
 *
 * WHY THIS EXISTS (the defect it fixes)
 *   The Feedback form auto-captures a `page` so a report is actionable. It used to read
 *   `window.location.pathname` AT SUBMIT TIME — but by then the user has already navigated
 *   to /feedback, so EVERY row landed with `page = '/feedback'`. The one field whose whole
 *   job is to say where the problem was recorded the form itself, on every submission.
 *
 * THE FIX
 *   The shell records each route the user lands on, EXCLUDING the reporting route itself,
 *   and the Feedback page reads that instead. So "I was on /sessions, something looked
 *   wrong, I clicked Feedback" writes `/sessions`.
 *
 *   Mirrored into sessionStorage so a hard reload of /feedback (or the lazy chunk loading
 *   after a refresh) doesn't lose it. sessionStorage, not localStorage: it is per-tab and
 *   dies with the tab, which is exactly the lifetime of "where I just was". Every access is
 *   try/caught — a storage-denied browser degrades to the in-memory value, never throws.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { logger } from './logger';

/** The route that DOES the reporting — never itself a useful answer to "where were you?". */
export const FEEDBACK_PATH = '/feedback';

/** sessionStorage key (per tab). */
export const LAST_VISITED_PATH_KEY = 'mandrel_last_visited_path';

let inMemoryPath: string | null = null;

/** Record a visited path. `/feedback` (and any empty value) is ignored by design. */
export function recordVisitedPath(pathname: string | null | undefined): void {
  if (!pathname) return;
  if (pathname === FEEDBACK_PATH || pathname.startsWith(`${FEEDBACK_PATH}/`)) return;
  inMemoryPath = pathname;
  try {
    sessionStorage.setItem(LAST_VISITED_PATH_KEY, pathname);
  } catch (error) {
    // Storage denied (private mode / blocked cookies) — the in-memory value still works.
    logger.error('Failed to persist last visited path:', error);
  }
}

/**
 * The last non-feedback path this tab visited, or null when there isn't one (the user
 * deep-linked straight to /feedback). Callers must handle null — an honest "no page"
 * beats a fabricated one.
 */
export function getLastVisitedPath(): string | null {
  if (inMemoryPath) return inMemoryPath;
  try {
    return sessionStorage.getItem(LAST_VISITED_PATH_KEY);
  } catch (error) {
    logger.error('Failed to read last visited path:', error);
    return null;
  }
}

/**
 * DROP EVERY COPY. Call this when the identity behind the path changes — i.e. on logout,
 * from `resetAuthState`.
 *
 * ── THE DEFECT THIS CLOSES (Reviewer B1, reject round 1 of an earlier task) ───────────
 * The tracked path is IDENTITY-BEARING and this module did not know it. `AuthContext.logout`
 * is `navigate('/login', { replace: true })` — a react-router navigation with NO page
 * reload — so the module stays loaded across a user switch. `resetAuthState` cleared the
 * token, the store, the query cache and the ambient project rungs, and knew nothing about
 * the two copies here. Measured after logout: both `inMemoryPath` AND the sessionStorage
 * mirror still held user A's path, and the in-memory copy survived a full
 * `localStorage.clear()` (it is not in localStorage at all).
 *
 * Our routes are id-bearing (`contexts/:id`, `tasks/:id`, `decisions/:id`, `projects/:id`,
 * `sessions/:id`), so user B opening Feedback would SEE user A's path rendered on screen
 * and submit it as B's row — and the headline fix of this task (report where you actually
 * were) would then be reporting where someone ELSE was. Both failures at once.
 *
 * ── WHY IT LIVES HERE, NEXT TO THE STATE ─────────────────────────────────────────────
 * Same reason `clearAmbientProjectState` lives beside its rung ladder: a clear-function
 * written anywhere else is a second copy of the list of copies, and the two drift the
 * first time a copy is added. A third copy must be added to `recordVisitedPath` AND to
 * this function, and they are thirty lines apart so that is hard to miss.
 */
export function clearLastVisitedPath(): void {
  inMemoryPath = null;
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(LAST_VISITED_PATH_KEY);
  } catch (error) {
    // A storage-denied browser never had a mirror to clear; memory is already dropped.
    logger.error('Failed to clear last visited path:', error);
  }
}

/**
 * Test seam: drop ONLY the in-memory copy, so a suite can prove the sessionStorage
 * mirror survives a page reload. NOT the logout teardown — that is
 * {@link clearLastVisitedPath}, which drops both. Named `__`-prefixed to mirror
 * `__resetRememberedAmbientProject` and to make a production call site look wrong.
 */
export function __resetInMemoryPathForTest(): void {
  inMemoryPath = null;
}

/**
 * Mount ONCE, inside the router — the app shell does it. Records every route change so
 * the Feedback form can report the screen the user came from rather than itself.
 */
export function useTrackVisitedPath(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    recordVisitedPath(pathname);
  }, [pathname]);
}
