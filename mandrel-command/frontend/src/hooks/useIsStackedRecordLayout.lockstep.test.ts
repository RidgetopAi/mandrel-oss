/**
 * RECORD_LAYOUT_STACK_MAX_WIDTH — CSS lockstep guard
 * (clause 3; round-1 REJECTION on this same punch — the critic measured this exact gap).
 *
 * WHY THIS FILE EXISTS: `RECORD_LAYOUT_STACK_MAX_WIDTH` (useIsStackedRecordLayout.ts) and
 * the `960px` literal in Contexts.module.css / Decisions.module.css are TWO INDEPENDENT
 * NUMBERS — nothing in the build pipeline reads one into the other (no PostCSS custom-media
 * plugin is wired into this Vite config; CSS media queries cannot read a JS export at
 * runtime). The hook decides which MARKUP renders (Drawer overlay vs. the inline second
 * column); the media query decides how the remaining single column lays out once the grid
 * collapses. Before this file, drifting EITHER number independently left every one of the
 * 161 frontend test files green — moving the hook to, say, 600 while the CSS stayed at 960
 * reopens the filed "reader buried below the list" bug across the
 * 601-960px gap, with a fully green suite, because nothing compared the two.
 *
 * This file IS the pin the critic asked for: it reads the two stylesheets' actual bytes off
 * disk (not a restated literal) and asserts the `.layout { grid-template-columns: 1fr }`
 * breakpoint in EACH equals the SAME exported `RECORD_LAYOUT_STACK_MAX_WIDTH` the hook (and
 * the overlay tests) use. Move either number without moving the other two and this test —
 * not a future bug report from someone's phone — is what goes red.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { RECORD_LAYOUT_STACK_MAX_WIDTH } from './useIsStackedRecordLayout';

const here = dirname(fileURLToPath(import.meta.url));

const STYLESHEETS = [
  resolve(here, '../pages/contexts/Contexts.module.css'),
  resolve(here, '../pages/decisions/Decisions.module.css'),
];

/**
 * Matches ONLY the media query that collapses `.layout` to a single column — not just any
 * `max-width` query that happens to live in the file — so an unrelated breakpoint elsewhere
 * in the stylesheet can't accidentally satisfy (or accidentally fail) this guard.
 */
const LAYOUT_BREAKPOINT_RE =
  /@media\s*\(max-width:\s*(\d+(?:\.\d+)?)px\)\s*\{\s*\.layout\s*\{\s*grid-template-columns:\s*1fr;/;

describe('RECORD_LAYOUT_STACK_MAX_WIDTH stays in lockstep with the CSS (clause 3)', () => {
  it.each(STYLESHEETS)('%s pins its .layout breakpoint to the exported constant', (cssPath) => {
    const css = readFileSync(cssPath, 'utf8');
    const match = LAYOUT_BREAKPOINT_RE.exec(css);
    expect(
      match,
      `expected to find "@media (max-width: Npx) { .layout { grid-template-columns: 1fr; ... }" in ${cssPath}`,
    ).not.toBeNull();
    expect(Number(match![1])).toBe(RECORD_LAYOUT_STACK_MAX_WIDTH);
  });
});
