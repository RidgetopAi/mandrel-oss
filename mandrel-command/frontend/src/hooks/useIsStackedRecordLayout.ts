/**
 * useIsStackedRecordLayout — true when the viewport is at/below the width
 * where a rail+reader record screen (Contexts, Decisions) collapses its two-column grid to
 * ONE column: `@media (max-width: 960px)` in both Contexts.module.css and
 * Decisions.module.css (`.layout { grid-template-columns: 1fr; }`).
 *
 * Below that width the reader can no longer sit BESIDE the list — the list is often long,
 * so a reader rendered inline underneath it lands far off-screen and the user has to scroll
 * past the whole list to read the very record they just selected. The page uses this hook to
 * switch the reader from an inline second column to an overlay `Drawer` instead (fixed,
 * portal-rendered, anchored at the top of the viewport, with its own close control) — see
 * Contexts.tsx / Decisions.tsx.
 *
 * `RECORD_LAYOUT_STACK_MAX_WIDTH` MUST stay in lockstep with the `960px` literal in both
 * stylesheets. This hook decides which MARKUP renders (inline column vs. Drawer); the media
 * query decides how the remaining single column lays out. A mismatch between the two would
 * reopen the "buried below the list" bug in the gap between whichever breakpoint is smaller
 * and whichever is larger.
 */
import { useMediaQuery } from '../components/shell/hooks';

export const RECORD_LAYOUT_STACK_MAX_WIDTH = 960;

export function useIsStackedRecordLayout(): boolean {
  return useMediaQuery(`(max-width: ${RECORD_LAYOUT_STACK_MAX_WIDTH}px)`);
}
