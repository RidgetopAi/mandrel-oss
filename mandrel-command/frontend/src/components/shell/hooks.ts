/**
 * App-shell hooks (P0.4).
 *
 *  • useSidebarCollapse — the rail-collapsed state, persisted to localStorage so
 *    it survives reloads (reference: "state persists per user (localStorage)").
 *  • useMediaQuery — SSR/jsdom-safe matchMedia subscription; returns false when
 *    matchMedia is unavailable (test env) so the shell defaults to desktop.
 */
import { useCallback, useEffect, useState } from 'react';
import { logger } from '../../utils/logger';
import { shellConfig } from './shellConfig';

export function useSidebarCollapse(): {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
} {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(shellConfig.collapseStorageKey) === '1';
    } catch (error) {
      logger.error('Failed to read sidebar state from localStorage:', error);
      return false;
    }
  });

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(shellConfig.collapseStorageKey, v ? '1' : '0');
    } catch (error) {
      logger.error('Failed to persist sidebar state to localStorage:', error);
    }
  }, []);

  const toggle = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  return { collapsed, toggle, setCollapsed };
}

export function useMediaQuery(query: string): boolean {
  const getMatch = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  }, [query]);

  const [matches, setMatches] = useState<boolean>(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    // addEventListener is the modern API; guard for older Safari (addListener).
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/** Convenience: true when the viewport is at/below the shell's mobile breakpoint. */
export function useIsMobile(): boolean {
  return useMediaQuery(shellConfig.mobileMediaQuery);
}
