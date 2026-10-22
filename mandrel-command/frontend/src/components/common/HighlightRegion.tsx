import React, { createContext, useContext, useEffect, useRef } from 'react';
import { highlightConfig } from '../../config/highlight';
import '../../styles/searchHighlight.css';

/**
 * Feature B — the highlight REGION: one wrapper a record-detail view puts around
 * its content to (1) make the active search term AMBIENT to every nested
 * MarkdownContent / LinkifiedText (via context, so we don't thread a prop through
 * a dozen call sites), (2) preserve Feature A's `data-highlight-query` marker on
 * the region root, and (3) own the SCROLL-to-first-match behavior.
 *
 * Only ONE region is open at a time (a detail drawer / detail page), so a single
 * shared context value is unambiguous.
 */

/** Ambient highlight term for the current detail region (undefined = no highlight). */
export const HighlightContext = createContext<string | undefined>(undefined);

/**
 * Resolve the term a highlight-aware component should use: an explicit prop wins
 * (direct/testable usage), otherwise the ambient region term. Blank is normalized
 * to undefined so a bare `?q=` never highlights.
 */
export function useHighlightTerm(override?: string): string | undefined {
  const ambient = useContext(HighlightContext);
  const term = override ?? ambient;
  const trimmed = term?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Find the first highlight `<mark>` inside a container — the scroll target. Pure +
 * testable (jsdom). Returns null when there is no container or no match, so the
 * caller degrades cleanly (no term / no match → no scroll).
 */
export function findFirstHighlight(container: HTMLElement | null): HTMLElement | null {
  if (!container) return null;
  return container.querySelector('mark');
}

export interface HighlightRegionProps {
  /** The active search term (from `?q=` or the live search); blank = no highlight. */
  term?: string;
  children: React.ReactNode;
  /** Optional extra class on the region wrapper div. */
  className?: string;
}

/**
 * Wrap detail content: provides `term` to nested content and, on open (or when the
 * term changes), smoothly scrolls the first match into view. Degrades cleanly —
 * blank term or no match → no scroll, no crash.
 */
const HighlightRegion: React.FC<HighlightRegionProps> = ({ term, children, className }) => {
  const trimmed = term?.trim();
  const active = trimmed && trimmed.length > 0 ? trimmed : undefined;
  const regionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    // The marks are committed with the children (same render), so they exist by the
    // time this effect runs. rAF defers to after layout/paint so scrollIntoView has
    // final geometry (and, for smooth, does not fight the mount transition).
    const raf = requestAnimationFrame(() => {
      const target = findFirstHighlight(regionRef.current);
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({
          behavior: highlightConfig.scrollBehavior,
          block: highlightConfig.scrollBlock,
          inline: 'nearest',
        });
      }
    });
    return () => cancelAnimationFrame(raf);
    // Re-run if the term changes (a new search opens the same record differently).
  }, [active]);

  return (
    <div ref={regionRef} className={className} data-highlight-query={active}>
      <HighlightContext.Provider value={active}>{children}</HighlightContext.Provider>
    </div>
  );
};

export default HighlightRegion;
