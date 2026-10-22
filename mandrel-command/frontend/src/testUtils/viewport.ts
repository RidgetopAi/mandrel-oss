/**
 * mockMatchMedia — jsdom has NO `window.matchMedia`, so every hook built on
 * it (`useMediaQuery`, `useIsMobile`, `useIsStackedRecordLayout`) degrades to its "unknown
 * environment" fallback: unconditionally `false` (`components/shell/hooks.ts`). That is why
 * all 72 pre-existing Contexts/Decisions tests exercised only the INLINE branch of the
 * mobile-overlay switch — the OVERLAY branch (`isStacked === true`) was structurally
 * unreachable in the test environment, so a revert of it could not have failed anything.
 *
 * This installs a REAL, controllable `matchMedia`: it parses the one query shape this
 * codebase emits — `(max-width: Npx)` (`RECORD_LAYOUT_STACK_MAX_WIDTH`,
 * `shellConfig.mobileMediaQuery`) — against a settable `viewportWidth`, and answers
 * `.matches` (plus fires `change` on every tracked `MediaQueryList`, mirroring a real
 * resize) accordingly. `installMatchMediaMock` is called ONCE per test file from
 * `setupTests.ts`; `resetViewportWidth` runs before every test so no test's width choice
 * leaks into the next one. The default width (`DEFAULT_VIEWPORT_WIDTH`, above every
 * breakpoint in this codebase) reproduces the SAME "everything is desktop" answer jsdom's
 * missing `matchMedia` used to produce — so the 72 pre-existing tests keep exercising
 * exactly the branch they always did, for the same reason (desktop-width), not by
 * accident (no `matchMedia` at all).
 */
import { vi } from 'vitest';

/** Wide enough to be on the desktop side of every `max-width` breakpoint in this app. */
export const DEFAULT_VIEWPORT_WIDTH = 1280;

const MAX_WIDTH_RE = /\(max-width:\s*(\d+(?:\.\d+)?)px\)/;

type ChangeListener = (ev: MediaQueryListEvent) => void;

interface TrackedQuery {
  maxWidth: number;
  media: string;
  listeners: Set<ChangeListener>;
}

let viewportWidth = DEFAULT_VIEWPORT_WIDTH;
const tracked = new Set<TrackedQuery>();

function matchesAt(maxWidth: number, width: number): boolean {
  return width <= maxWidth;
}

/** Install the shim on `window.matchMedia`. Safe to call once per test file. */
export function installMatchMediaMock(): void {
  if (typeof window === 'undefined') return;
  window.matchMedia = vi.fn().mockImplementation((query: string): MediaQueryList => {
    const parsed = MAX_WIDTH_RE.exec(query);
    const maxWidth = parsed ? Number(parsed[1]) : Number.POSITIVE_INFINITY;
    const entry: TrackedQuery = { maxWidth, media: query, listeners: new Set() };
    tracked.add(entry);
    const mql = {
      get media() {
        return query;
      },
      get matches() {
        return matchesAt(maxWidth, viewportWidth);
      },
      onchange: null,
      addEventListener: (type: string, listener: ChangeListener) => {
        if (type === 'change') entry.listeners.add(listener);
      },
      removeEventListener: (type: string, listener: ChangeListener) => {
        if (type === 'change') entry.listeners.delete(listener);
      },
      // Older Safari API, which `useMediaQuery` falls back to.
      addListener: (listener: ChangeListener) => entry.listeners.add(listener),
      removeListener: (listener: ChangeListener) => entry.listeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
    return mql;
  });
}

/**
 * Set the width every tracked `MediaQueryList` measures against and fire `change` on each
 * of them (mirrors a real browser resize). Call BEFORE mounting to choose which side of a
 * breakpoint the component sees at mount, or AFTER mounting to prove the hook responds live.
 */
export function setViewportWidth(width: number): void {
  viewportWidth = width;
  for (const entry of tracked) {
    const event = { matches: matchesAt(entry.maxWidth, width), media: entry.media } as MediaQueryListEvent;
    entry.listeners.forEach((listener) => listener(event));
  }
}

/** Back to the desktop default, and forget every query tracked by the previous test. */
export function resetViewportWidth(): void {
  viewportWidth = DEFAULT_VIEWPORT_WIDTH;
  tracked.clear();
}
