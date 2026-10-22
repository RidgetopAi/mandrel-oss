import { lazy, ComponentType } from 'react';

/**
 * Self-healing lazy loader for code-split route chunks.
 *
 * Problem: after a frontend redeploy, CRA produces new chunk hashes. A browser
 * that already loaded an OLD bundle will try to lazy-load a route chunk whose
 * hash no longer exists on the server -> "Loading chunk N failed" / ChunkLoadError,
 * and the user sees a broken page.
 *
 * Fix: when a dynamic import fails with a ChunkLoadError, reload the page ONCE to
 * pull the fresh index.html + bundle. A sessionStorage guard prevents reload loops
 * (e.g. a genuinely missing chunk would otherwise reload forever).
 */

const RELOAD_GUARD_KEY = 'chunk-reload-attempted';

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { name?: string; message?: string };
  const name = err.name || '';
  const message = err.message || '';
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk [\w-]+ failed/i.test(message) ||
    /Loading CSS chunk [\w-]+ failed/i.test(message) ||
    // Vite/dynamic-import variants, harmless to also catch:
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message)
  );
}

/**
 * Reload the page exactly once for a stale-chunk situation. Returns true if it
 * triggered a reload (caller can stop further handling), false if the guard was
 * already set (avoid loop).
 */
export function reloadOnceForStaleChunk(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      return false;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode / blocked) — fall through and
    // still reload; worst case is a single extra reload, not a loop, because
    // most such cases also disable the loop differently. Be conservative:
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Clear the reload guard once the app has successfully mounted, so a *future*
 * stale-chunk error (after the next redeploy) can self-heal again.
 */
export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    /* ignore */
  }
}

type ImportFn<T extends ComponentType<any>> = () => Promise<{ default: T }>;

/**
 * Drop-in replacement for React.lazy that self-heals stale-chunk errors.
 * On the first ChunkLoadError it reloads the page once; on a subsequent failure
 * (after reload) it rethrows so the error boundary can render a real error.
 */
export function lazyWithRetry<T extends ComponentType<any>>(importFn: ImportFn<T>) {
  return lazy(async () => {
    try {
      return await importFn();
    } catch (error) {
      if (isChunkLoadError(error)) {
        // If we have NOT reloaded yet this session, reload to get fresh chunks.
        if (reloadOnceForStaleChunk()) {
          // Return a never-resolving promise; the page is reloading anyway.
          return await new Promise<{ default: T }>(() => {});
        }
      }
      // Already reloaded once, or not a chunk error — let it propagate.
      throw error;
    }
  });
}

/**
 * Install a global safety net for ChunkLoadErrors that escape the lazy wrapper
 * (e.g. chunks imported outside React.lazy, or unhandled promise rejections).
 * Reloads once per session via the same guard.
 */
export function installChunkErrorAutoReload(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    if (isChunkLoadError(event.error) || isChunkLoadError(event)) {
      reloadOnceForStaleChunk();
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event.reason)) {
      reloadOnceForStaleChunk();
    }
  });
}
