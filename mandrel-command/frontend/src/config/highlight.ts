/**
 * Search-term highlight configuration (Feature B) — named tunables, no magic numbers.
 *
 * Governs how a search term (from a `?q=` deep-link, or the active Context/Decision
 * search) is highlighted inside an opened record, and how the view scrolls to the
 * first match. Standing rule (configs-not-hardcoded): tunables live in organized
 * named config, env-overridable, never inline literals.
 *
 * The VISUAL style of a highlight lives in CSS (styles/searchHighlight.css) as
 * `<mark>` rules with CSS custom-property fallbacks (`--ra-highlight-bg` /
 * `--ra-highlight-fg`) so a theme can retune the colors without a rebuild — that is
 * the correct home for presentation. This module holds the BEHAVIORAL tunables the
 * runtime code reads: scroll behavior/alignment and the shared mark class name.
 */

/**
 * Takes the env VALUE (a static `import.meta.env.VITE_X` read at the call site),
 * never the env NAME — a dynamic `import.meta.env[name]` read defeats Vite's
 * static replacement and inlines the ENTIRE env object into the bundle.
 * Banned by the `.eslintrc.cjs` env-access rule and RED-gated by
 * scripts/check-frontend-bundle-env.sh.
 */
function strFromEnv(raw: string | undefined, fallback: string): string {
  return raw === undefined || raw === '' ? fallback : raw;
}

export const highlightConfig = {
  /**
   * Class applied to every non-markdown `<mark>` we create (LinkifiedText + the
   * list-card excerpts). The markdown pipeline emits a BARE `<mark>` (the sanitize
   * schema is widened for the tag only, not attributes — see MarkdownContent), so
   * both are styled by the element selector in searchHighlight.css; this class is a
   * convenience hook for the React-rendered marks and future targeting.
   */
  markClassName: strFromEnv(import.meta.env.VITE_HIGHLIGHT_MARK_CLASS, 'ra-search-highlight'),

  /**
   * How the view scrolls the first match into view when a record opens from a
   * search. `smooth` glides (no jank); `auto` jumps. `block` aligns the match in
   * the viewport ('center' keeps it comfortably away from either edge).
   */
  scrollBehavior: strFromEnv(import.meta.env.VITE_HIGHLIGHT_SCROLL_BEHAVIOR, 'smooth') as ScrollBehavior,
  scrollBlock: strFromEnv(import.meta.env.VITE_HIGHLIGHT_SCROLL_BLOCK, 'center') as ScrollLogicalPosition,
} as const;

export default highlightConfig;
