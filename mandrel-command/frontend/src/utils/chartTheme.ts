/**
 * Single source of truth for dark-mode-aware @ant-design/plots (G2 v5) chart
 * styling.
 *
 * Why this exists: G2 v5 renders charts to <canvas>, so chart text (axis labels,
 * legend, data labels) CANNOT inherit the page's CSS color. In dark mode the
 * default near-black text becomes illegible on the dark background. Each chart
 * must therefore set its theme + text fill explicitly. Rather than copy-paste
 * the `themeMode === 'dark' ? ... : ...` ternaries into every chart (where they
 * drift), every chart imports these tokens from here.
 *
 *  - `theme`     → the built-in G2 v5 theme name. 'classicDark' makes the library
 *                  render axis/legend/grid in light-on-dark automatically; this is
 *                  the load-bearing lever. (Note: 'dark'/'light' are NOT valid v5
 *                  theme keys — use these.)
 *  - `textColor` → explicit fill for data labels / axis titles the theme doesn't
 *                  fully cover (label.style.fill, axis labelFill/titleFill, legend
 *                  itemLabelFill).
 *  - `gridColor` → stroke for axis grid lines.
 */

export type ChartThemeMode = 'light' | 'dark';

export interface ChartThemeTokens {
  theme: 'classicDark' | 'classic';
  textColor: string;
  gridColor: string;
}

export function chartTheme(themeMode: ChartThemeMode): ChartThemeTokens {
  const isDark = themeMode === 'dark';
  return {
    theme: isDark ? 'classicDark' : 'classic',
    textColor: isDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)',
    gridColor: isDark ? '#434343' : '#f0f0f0',
  };
}
