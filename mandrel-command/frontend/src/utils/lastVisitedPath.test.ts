/**
 * lastVisitedPath — the tracker that fixes the `page = '/feedback'` defect.
 *
 * These are the assertions that matter for the defect: the feedback route is NEVER what
 * gets reported, the previous screen IS, and an absent value stays absent (null) rather
 * than being fabricated. Also probes the EMPTY / ABSENT populations (C3): no prior route,
 * empty string, and a throwing sessionStorage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_PATH,
  LAST_VISITED_PATH_KEY,
  clearLastVisitedPath,
  getLastVisitedPath,
  recordVisitedPath,
  __resetInMemoryPathForTest,
} from './lastVisitedPath';
import { resetAuthState } from '../hooks/useAuth';

beforeEach(() => {
  clearLastVisitedPath();
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearLastVisitedPath();
  sessionStorage.clear();
  localStorage.clear();
});

describe('lastVisitedPath', () => {
  it('records a normal app route and reads it back', () => {
    recordVisitedPath('/sessions');
    expect(getLastVisitedPath()).toBe('/sessions');
  });

  it('keeps the LATEST route (the one the user was actually on)', () => {
    recordVisitedPath('/dashboard');
    recordVisitedPath('/tasks/abc-123');
    expect(getLastVisitedPath()).toBe('/tasks/abc-123');
  });

  it('NEVER records the feedback route itself — the whole point of the fix', () => {
    recordVisitedPath('/sessions');
    recordVisitedPath(FEEDBACK_PATH);
    expect(getLastVisitedPath()).toBe('/sessions');
  });

  it('never records a feedback SUB-route either', () => {
    recordVisitedPath('/analytics');
    recordVisitedPath('/feedback/anything');
    expect(getLastVisitedPath()).toBe('/analytics');
  });

  it('returns null when nothing was visited (deep-link straight to /feedback)', () => {
    expect(getLastVisitedPath()).toBeNull();
  });

  it('ignores empty / null / undefined paths rather than storing a blank', () => {
    recordVisitedPath('');
    recordVisitedPath(null);
    recordVisitedPath(undefined);
    expect(getLastVisitedPath()).toBeNull();
    expect(sessionStorage.getItem(LAST_VISITED_PATH_KEY)).toBeNull();
  });

  it('survives a reload: the value is mirrored into sessionStorage', () => {
    recordVisitedPath('/decisions');
    expect(sessionStorage.getItem(LAST_VISITED_PATH_KEY)).toBe('/decisions');
    // Simulate a fresh module instance (page reload) — memory is empty, storage is not.
    __resetInMemoryPathForTest();
    expect(getLastVisitedPath()).toBe('/decisions');
  });

  it('degrades to the in-memory value when sessionStorage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(() => recordVisitedPath('/projects')).not.toThrow();
    expect(getLastVisitedPath()).toBe('/projects');
  });

  it('returns null (not a throw) when sessionStorage reads throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(getLastVisitedPath()).toBeNull();
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE IDENTITY SWITCH (Reviewer B1, reject round 1) — user A's path must not reach B
 * ════════════════════════════════════════════════════════════════════════════════════
 * Logout is `navigate('/login', { replace: true })` (contexts/AuthContext.tsx) — a
 * react-router navigation with NO page reload — so this module stays loaded across a user
 * switch. Before the fix, BOTH copies survived: `inMemoryPath` and the sessionStorage
 * mirror. The in-memory one survived even a full `localStorage.clear()`, because it is
 * not in localStorage at all.
 *
 * Our routes are id-bearing, so the leak is not abstract: user B opens Feedback and the
 * UI RENDERS `/contexts/<A's context id>` and submits it as B's row.
 *
 * ── WHY THE ASSERTION IS `getLastVisitedPath()` AND NOT "the key is gone" ────────────
 * Same anchor as hooks/logoutClearsProjectScope.test.ts: asserting the storage key is
 * absent would pass while the in-memory copy quietly answered — which IS the defect.
 * So the anchor is the value the FORM would read, checked after logout and again after
 * `localStorage.clear()` to prove no copy is out of reach of a storage wipe.
 *
 * ── THE POPULATION ───────────────────────────────────────────────────────────────────
 * Both copies, seeded individually AND together, through the REAL `resetAuthState` —
 * the single teardown both logout paths delegate to — not a stub of it.
 */
describe('lastVisitedPath — logout teardown (identity-bearing state)', () => {
  /** An id-bearing route of user A's — the value that must NOT survive into B's session. */
  const PATH_A = '/contexts/aaaaaaaa-1111-4111-8111-111111111111';
  const PATH_B = '/sessions/bbbbbbbb-2222-4222-8222-222222222222';

  it('resetAuthState drops the path — both copies, and it stays dropped', () => {
    recordVisitedPath(PATH_A);
    expect(getLastVisitedPath()).toBe(PATH_A);
    expect(sessionStorage.getItem(LAST_VISITED_PATH_KEY)).toBe(PATH_A);

    resetAuthState(new QueryClient());

    expect(getLastVisitedPath()).toBeNull();
    expect(sessionStorage.getItem(LAST_VISITED_PATH_KEY)).toBeNull();
    // And nothing re-seats it from a copy a storage wipe cannot reach.
    localStorage.clear();
    expect(getLastVisitedPath()).toBeNull();
  });

  it('the IN-MEMORY copy alone cannot survive logout (the storage-wipe-proof one)', () => {
    recordVisitedPath(PATH_A);
    // Storage mirror gone, module memory still holding A — the pre-fix survivor.
    sessionStorage.clear();
    expect(getLastVisitedPath()).toBe(PATH_A);

    resetAuthState(new QueryClient());
    expect(getLastVisitedPath()).toBeNull();
  });

  it('the sessionStorage copy alone cannot survive logout', () => {
    recordVisitedPath(PATH_A);
    __resetInMemoryPathForTest(); // memory dropped (e.g. a reload), mirror still holds A
    expect(getLastVisitedPath()).toBe(PATH_A);

    resetAuthState(new QueryClient());
    expect(getLastVisitedPath()).toBeNull();
  });

  it('user B, after a real logout, gets B’s own path and never A’s', () => {
    recordVisitedPath(PATH_A);
    resetAuthState(new QueryClient()); // A logs out
    recordVisitedPath(PATH_B); // B logs in and browses
    expect(getLastVisitedPath()).toBe(PATH_B);
    expect(getLastVisitedPath()).not.toBe(PATH_A);
  });

  it('clearing when nothing was recorded is a no-op, not a throw (empty population)', () => {
    expect(() => resetAuthState(new QueryClient())).not.toThrow();
    expect(getLastVisitedPath()).toBeNull();
  });

  it('clearLastVisitedPath survives a storage-denied browser', () => {
    recordVisitedPath(PATH_A);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(() => clearLastVisitedPath()).not.toThrow();
    // Memory is dropped first, so the read no longer answers A even though the mirror
    // could not be removed.
    vi.restoreAllMocks();
    sessionStorage.clear();
    expect(getLastVisitedPath()).toBeNull();
  });
});
