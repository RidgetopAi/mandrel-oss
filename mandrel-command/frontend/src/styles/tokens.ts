/**
 * Command UI — canonical design-token SOURCE OF TRUTH (P0.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Before P0.2, tokens were scattered as inline hex across ThemeContext.tsx,
 * chartTheme.ts and surveyor/config/colors.ts — JS and CSS drifting apart with
 * no single source. This module is now the ONE place every design token is
 * defined. Everything else derives from it:
 *
 *   • `tokens.css`  — the CSS custom-property layer every stylesheet + primitive
 *                     (P0.3), the app shell (P0.4) and CSS files read via
 *                     `var(--teal)` etc. It is a GENERATED artifact: run
 *                     `npm run tokens:css` (→ scripts/generate-tokens-css.ts) to
 *                     rebuild it from this module. A vitest drift-guard
 *                     (`tokens.test.ts`) asserts the committed CSS byte-matches
 *                     what this source renders, so the two can NEVER diverge.
 *   • charts (P0.6) / JS-computed styles — import the typed `dark` / `light`
 *                     maps (resolved hex) or `cssVar('teal')` from here.
 *
 * Result: exactly ONE copy of every hex value (here). The CSS is derived, not a
 * hand-maintained duplicate. No magic numbers, no drift. (tests-are-the-rock +
 * configs-not-hardcoded.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE — every token traces to the LOCKED design language
 * ─────────────────────────────────────────────────────────────────────────────
 * DARK is the authoritative, locked theme. Color/line/font/radii values are
 * transcribed VERBATIM from the design-language doc
 *   riverbend/docs/command-design-language.html  (:root block)
 * cross-checked against command-{dashboard,contexts,analytics}-mock.html — all
 * four agree, zero discrepancy.
 *
 * TYPE SCALE — formalized from the doc's "Type" reference section
 * (Display/24 · Title/17 · Body/15.5 · Label/11 · Data/14). Traceable to the doc.
 *
 * DERIVED (NOT from the locked doc, but APPROVED 2026-07-14 — an earlier decision:
 * dark default, light optional):
 *   • the entire LIGHT theme palette. The doc is dark-first and specifies no
 *     light values, so the light ramp below is a principled derivation (proper
 *     contrast on a light ground, teal kept legible — NOT a naive invert).
 *   • the SPACING scale. The doc expresses spacing as ad-hoc px in components,
 *     not as tokens; the 8pt rhythm below is derived from the observed values.
 * Both remain flagged `DERIVED` (provenance: derived, not from the dark-first
 * doc) in this file and in the generated CSS — the flag now reads APPROVED, not
 * pending.
 */

/** A token whose value is the same in every theme (radii, fonts, type, spacing). */
export interface BaseToken {
  /** CSS custom-property name WITHOUT the leading `--`. */
  name: string;
  value: string;
  /** Human role — doubles as the documentation of the token catalog. */
  role: string;
}

/** A token whose value differs per theme (colors). */
export interface ThemedToken {
  name: string;
  dark: string;
  light: string;
  role: string;
}

export interface BaseCategory {
  title: string;
  themed: false;
  /** Optional provenance note rendered as a comment in the generated CSS. */
  note?: string;
  tokens: BaseToken[];
}

export interface ThemedCategory {
  title: string;
  themed: true;
  note?: string;
  tokens: ThemedToken[];
}

export type TokenCategory = BaseCategory | ThemedCategory;

/**
 * The ordered token catalog. Order here == order in the generated CSS.
 * DARK values are verbatim from the design-language doc unless flagged DERIVED.
 */
export const TOKEN_CATEGORIES: TokenCategory[] = [
  {
    title: 'Ground & surfaces — the calm dark base',
    themed: true,
    note: 'DARK verbatim from design-language doc. LIGHT is DERIVED (APPROVED 2026-07-14).',
    tokens: [
      { name: 'bg', dark: '#0A0C10', light: '#F7F8FA', role: 'app background / ground' },
      { name: 'bg-2', dark: '#0D1015', light: '#FFFFFF', role: 'shell / topbar ground (elevated)' },
      { name: 's1', dark: '#111419', light: '#FFFFFF', role: 'surface 1 — panels, reader' },
      { name: 's2', dark: '#161A21', light: '#F1F3F6', role: 'surface 2 — rows, hover, selected' },
      { name: 's3', dark: '#1C222B', light: '#E8EBEF', role: 'surface 3 — nested/raised' },
      { name: 's-hover', dark: '#20272F', light: '#E4E8ED', role: 'interactive hover surface' },
    ],
  },
  {
    title: 'Lines & borders — hairlines over heavy containers',
    themed: true,
    note: 'DARK verbatim. LIGHT is DERIVED (APPROVED 2026-07-14).',
    tokens: [
      { name: 'line', dark: '#20262F', light: '#DCE0E6', role: 'default border / divider' },
      { name: 'line-2', dark: '#2A323D', light: '#C7CDD6', role: 'stronger border (ghost btn, emphasis)' },
      { name: 'line-soft', dark: '#181D24', light: '#EAEDF1', role: 'soft rule (nav, topbar underline)' },
    ],
  },
  {
    title: 'Text ramp — primary → faintest',
    themed: true,
    note: 'DARK verbatim. LIGHT is DERIVED inverse ramp (APPROVED 2026-07-14).',
    tokens: [
      { name: 'tx', dark: '#E8ECF2', light: '#12151A', role: 'primary text' },
      { name: 'tx-2', dark: '#9AA6B4', light: '#48515D', role: 'muted text' },
      { name: 'tx-3', dark: '#616C7B', light: '#6B7480', role: 'faint text / sublabels' },
      { name: 'tx-4', dark: '#454F5C', light: '#98A0AB', role: 'faintest — counts, timestamps' },
    ],
  },
  {
    title: 'Brand — teal leads',
    themed: true,
    note: 'DARK verbatim. LIGHT teal is DERIVED deeper so it stays legible as text/accent on a light ground (APPROVED 2026-07-14).',
    tokens: [
      { name: 'teal', dark: '#2ED9C6', light: '#159B8B', role: 'brand — primary action, active, links (sparingly)' },
      { name: 'teal-dim', dark: '#1FA99A', light: '#0E8073', role: 'brand dim — gradients, bullets' },
      { name: 'teal-glow', dark: '#2ed9c626', light: '#159b8b1f', role: 'brand glow — tinted backgrounds/shadows' },
    ],
  },
  {
    title: 'Accents — complements carry meaning (color encodes, never decorates)',
    themed: true,
    note: 'DARK verbatim. LIGHT accents DERIVED darker for contrast on a light ground (APPROVED 2026-07-14).',
    tokens: [
      { name: 'violet', dark: '#9B87FA', light: '#6D4FE0', role: 'milestones, memory' },
      { name: 'blue', dark: '#4C9DFF', light: '#2F7FE6', role: 'decisions, info' },
      { name: 'green', dark: '#3ED08A', light: '#1FA968', role: 'completion, healthy' },
      { name: 'amber', dark: '#F3B24C', light: '#C77F16', role: 'dormant, warning' },
      { name: 'rose', dark: '#F2606A', light: '#DB3B47', role: 'critical, alerts' },
      { name: 'violet-glow', dark: '#9b87fa22', light: '#6d4fe01f', role: 'violet tint background' },
      { name: 'blue-glow', dark: '#4c9dff22', light: '#2f7fe61f', role: 'blue tint background' },
      { name: 'green-glow', dark: '#3ed08a22', light: '#1fa9681f', role: 'green tint background' },
    ],
  },
  {
    title: 'Semantic — status mapped onto the accent hues',
    themed: true,
    note: 'DARK verbatim (ok=green, warn=amber, crit=rose). LIGHT mirrors the DERIVED accents.',
    tokens: [
      { name: 'ok', dark: '#3ED08A', light: '#1FA968', role: 'healthy / success' },
      { name: 'warn', dark: '#F3B24C', light: '#C77F16', role: 'warning / dormant' },
      { name: 'crit', dark: '#F2606A', light: '#DB3B47', role: 'critical / error' },
    ],
  },
  {
    title: 'Ink-on-accent — legible text/glyph colour on a filled accent surface',
    themed: true,
    note:
      'DARK --on-accent is VERBATIM from the design-language doc (.btn.primary color:#04110f). ' +
      'The doc uses white ink on danger/rose, so --on-crit is near-white both themes. ' +
      'LIGHT --on-accent is DERIVED dark ink (#04110f, ~6.6:1 AA on the deepened light teal #159B8B, ' +
      'brand-consistent dark-ink-on-teal) — APPROVED 2026-07-14. These decouple ' +
      'button ink from --bg (a coincidence that would drift if the ground or teal moved).',
    tokens: [
      {
        name: 'on-accent',
        dark: '#04110f',
        light: '#04110f',
        role: 'ink on a filled teal/primary surface (primary button)',
      },
      {
        name: 'on-crit',
        dark: '#FFFFFF',
        light: '#FFFFFF',
        role: 'ink on a filled danger/rose surface (danger button)',
      },
    ],
  },
  {
    title: 'Radii',
    themed: false,
    note: 'Verbatim from design-language doc. Theme-invariant.',
    tokens: [
      { name: 'r', value: '12px', role: 'default radius — cards, panels' },
      { name: 'r-sm', value: '8px', role: 'small radius — buttons, chips, nav' },
      { name: 'r-xs', value: '6px', role: 'extra-small radius — tags, badges' },
    ],
  },
  {
    title: 'Fonts',
    themed: false,
    note: 'Verbatim from design-language doc. Theme-invariant.',
    tokens: [
      {
        name: 'font',
        value: '-apple-system,system-ui,"SF Pro Display","Segoe UI",Roboto,sans-serif',
        role: 'system UI face',
      },
      {
        name: 'mono',
        value: 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace',
        role: 'mono — data, ids, code',
      },
    ],
  },
  {
    title: 'Type scale — from the doc\'s "Type" reference (Display/Title/Body/Label/Data)',
    themed: false,
    note: 'Sizes/weights/tracking transcribed from the doc\'s Type reference + component rules. Theme-invariant.',
    tokens: [
      { name: 'fs-display', value: '1.5rem', role: 'Display / ~24px' },
      { name: 'fw-display', value: '660', role: 'Display weight' },
      { name: 'tracking-display', value: '-0.025em', role: 'Display letter-spacing' },
      { name: 'fs-title', value: '1.05rem', role: 'Title / ~17px' },
      { name: 'fw-title', value: '620', role: 'Title weight' },
      { name: 'tracking-title', value: '-0.01em', role: 'Title letter-spacing' },
      { name: 'fs-body', value: '0.95rem', role: 'Body / ~15.5px' },
      { name: 'lh-body', value: '1.6', role: 'Body line-height (reader uses up to 1.72)' },
      { name: 'fs-label', value: '0.7rem', role: 'Label / ~11px caps' },
      { name: 'fw-label', value: '600', role: 'Label weight' },
      { name: 'tracking-label', value: '0.08em', role: 'Label letter-spacing (uppercase)' },
      { name: 'fs-data', value: '0.9rem', role: 'Data / mono ~14px' },
    ],
  },
  {
    title: 'Spacing scale — DERIVED 8pt rhythm (APPROVED 2026-07-14)',
    themed: false,
    note: 'DERIVED: the doc uses ad-hoc px spacing (not tokens). This 8pt-ish scale captures the observed rhythm. Theme-invariant.',
    tokens: [
      { name: 'sp-1', value: '4px', role: 'hairline gap' },
      { name: 'sp-2', value: '8px', role: 'tight gap' },
      { name: 'sp-3', value: '12px', role: 'compact padding' },
      { name: 'sp-4', value: '16px', role: 'default padding/gap' },
      { name: 'sp-5', value: '20px', role: 'roomy padding' },
      { name: 'sp-6', value: '24px', role: 'section gap' },
      { name: 'sp-8', value: '32px', role: 'block separation' },
      { name: 'sp-10', value: '40px', role: 'large separation' },
    ],
  },
  {
    title: 'Layout geometry — the shared record-screen skeleton (rail + reader)',
    themed: false,
    note:
      'DERIVED from the locked record-screen mocks, canonicalised on the Decisions screen\'s ' +
      'live geometry (2026-07-17). These exist because the rail/reader ' +
      'widths were per-page hardcodes and DRIFTED — Contexts shipped 300px/68ch while ' +
      'Decisions ran 320px/70ch, so the two record screens no longer lined up. Defined ONCE ' +
      'here and consumed by EVERY list+reader screen; a page stylesheet must never restate ' +
      'them as a literal (configs-not-hardcoded + fix the class, not the ' +
      'instance). Theme-invariant. rail-max-h joined them for the same reason and was ' +
      'ALREADY drifting when it did (Contexts 640px vs Decisions 660px): a value only looks ' +
      'like local ornament until you notice the other screen has to match it. The test for ' +
      '"ornament" is not "it looks incidental" — it is "no other screen has to match it".',
    tokens: [
      {
        name: 'rail-width',
        value: '320px',
        role: 'record-list rail (left column) track width — Contexts, Decisions',
      },
      {
        name: 'reader-width',
        value: '70ch',
        role: 'reader body max measure (line length) — Contexts, Decisions',
      },
      {
        name: 'rail-max-h',
        value: '660px',
        role: 'record-list rail scroll cap — Contexts, Decisions',
      },
    ],
  },
];

/** Theme identifiers. Dark is the locked/authoritative theme. */
export type ThemeName = 'dark' | 'light';

/** Flat resolved map: token name (no `--`) → value, for a given theme. */
export type TokenMap = Record<string, string>;

function buildMap(theme: ThemeName): TokenMap {
  const map: TokenMap = {};
  for (const cat of TOKEN_CATEGORIES) {
    if (cat.themed) {
      for (const t of cat.tokens) map[t.name] = theme === 'dark' ? t.dark : t.light;
    } else {
      for (const t of cat.tokens) map[t.name] = t.value;
    }
  }
  return map;
}

/**
 * Resolved token values for the DARK (authoritative) theme.
 * Import for charts / JS-computed styles that need a concrete hex.
 * e.g. `dark.teal` → '#2ED9C6'. Hyphenated names use bracket access: `dark['bg-2']`.
 */
export const dark: TokenMap = buildMap('dark');

/** Resolved token values for the DERIVED light theme (APPROVED 2026-07-14). */
export const light: TokenMap = buildMap('light');

/** Both themes, keyed by name. */
export const themes: Record<ThemeName, TokenMap> = { dark, light };

/**
 * Reference a token as a live CSS custom property, e.g. `cssVar('teal')` →
 * `'var(--teal)'`. Use in inline styles / styled JS that should react to the
 * active `data-theme` (NOT for <canvas> charts, which need a resolved hex — use
 * the `dark` / `light` maps there).
 */
export function cssVar(name: string): string {
  return `var(--${name})`;
}

/**
 * Inline-style object that REDECLARES every token as a CSS custom property for a
 * given theme, e.g. `{ '--s1': '#111419', '--teal': '#2ED9C6', … }`. Applying it
 * to a wrapper element creates a self-contained "theme island" whose descendants
 * resolve `var(--…)` to THIS theme regardless of the document root's
 * `data-theme` — because the tokens.css theme blocks are `:root[data-theme=…]`
 * (root-scoped only), a nested `data-theme` attribute alone can't re-theme a
 * subtree, but these inline custom properties cascade and do. Used by the
 * `/dev/ui` gallery to show dark AND light charts on one page at once.
 */
export function tokenStyleVars(theme: ThemeName): Record<string, string> {
  const map = themes[theme];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[`--${k}`] = v;
  return out;
}

// ── CSS generation (used by scripts/generate-tokens-css.ts + the drift-guard test) ──

/** Deterministic banner — NO timestamp, so the drift-guard stays stable. */
export const GENERATED_BANNER =
  '/* AUTO-GENERATED from src/styles/tokens.ts — DO NOT EDIT BY HAND.\n' +
  '   Edit tokens.ts, then run `npm run tokens:css`. A vitest drift-guard\n' +
  '   (tokens.test.ts) fails CI if this file and tokens.ts diverge. */';

function renderThemeBlock(selector: string, theme: ThemeName): string {
  const lines: string[] = [`${selector} {`, `  color-scheme: ${theme};`];
  for (const cat of TOKEN_CATEGORIES) {
    if (!cat.themed) continue;
    lines.push(`  /* ${cat.title} */`);
    for (const t of cat.tokens) {
      lines.push(`  --${t.name}: ${theme === 'dark' ? t.dark : t.light};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

function renderBaseBlock(): string {
  const lines: string[] = [
    '/* Theme-invariant tokens (radii, fonts, type, spacing, layout geometry) */',
    ':root {',
  ];
  for (const cat of TOKEN_CATEGORIES) {
    if (cat.themed) continue;
    lines.push(`  /* ${cat.title} */`);
    for (const t of cat.tokens) {
      lines.push(`  --${t.name}: ${t.value};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Render the FULL tokens.css content. Dark-first: dark values live on both the
 * bare `:root` and `:root[data-theme="dark"]`, so with no attribute set the app
 * renders dark — the LOCKED, authoritative default — regardless of the OS
 * `prefers-color-scheme`. Light is opt-in ONLY via `data-theme="light"`.
 */
export function renderTokensCss(): string {
  const parts = [
    GENERATED_BANNER,
    '',
    renderBaseBlock(),
    '',
    '/* DARK — the LOCKED, authoritative theme (default, dark-first) */',
    renderThemeBlock(':root,\n:root[data-theme="dark"]', 'dark'),
    '',
    '/* LIGHT — DERIVED, APPROVED 2026-07-14; NOT from the locked doc */',
    renderThemeBlock(':root[data-theme="light"]', 'light'),
    '',
  ];
  return parts.join('\n');
}
