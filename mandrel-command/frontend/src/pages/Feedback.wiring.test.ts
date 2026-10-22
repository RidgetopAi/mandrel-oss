/**
 * Feedback rebuild pattern guard (an earlier task — follows the Settings/Decisions/Contexts
 * screen-rebuild guards). Asserts the rebuilt page + its `feedback/` module:
 *   1. import ZERO antd;
 *   2. write through the UNIFIED `api` client — no axios, no legacy client, no raw fetch,
 *      and NO hand-read bearer token out of localStorage;
 *   3. carry no hardcoded colour / font-size literals in the stylesheet (tokens only);
 *   4. keep tunables in config.ts (configs-not-hardcoded);
 *   5. never render the UNSCOPED feedback list;
 *   6. never re-introduce the `window.location.pathname`-at-submit-time page capture.
 *
 * SCOPE OF THIS GUARD, stated explicitly (C3): it enumerates EXACTLY the files this task
 * created or rewrote — pages/Feedback.tsx plus every .ts/.tsx under pages/feedback/ (read
 * from the directory, so a file added there later is covered automatically). It says
 * nothing about any other screen; the app-wide "is antd gone" question is a different
 * guard and is deliberately NOT claimed here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { FEEDBACK_CONFIG } from './feedback/config';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'feedback');

/**
 * These are BYTE-level scans of source, so they must scan CODE — not prose. The header of
 * Feedback.tsx documents the very patterns being banned ("the old page hand-rolled
 * `fetch(...)`", "`window.location.pathname`", "`api.feedback.list()` exists but…"), and a
 * naive scan flagged all three: the guard fired on the explanation of the fix rather than on
 * a regression. Stripping comments is also the CONSERVATIVE direction — it can only remove
 * prose, never code, so it cannot introduce a blind spot in the ban itself.
 *
 * Only block comments and WHOLE-LINE line-comments are removed. A trailing `//` is left in
 * place on purpose: stripping to end-of-line would eat real code after a `//` inside a
 * string (e.g. a URL), which WOULD create a blind spot.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const pageSrcRaw = readFileSync(resolve(here, 'Feedback.tsx'), 'utf8');
const pageSrc = stripComments(pageSrcRaw);
const modFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f));
const allTsSrcs = [
  { f: 'Feedback.tsx', src: pageSrc },
  ...modFiles.map((f) => ({ f, src: stripComments(readFileSync(resolve(modDir, f), 'utf8')) })),
];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RAW_COLOUR = /\b(?:rgb|rgba|hsl|hsla)\(/g;
const PX_FONT_SIZE = /font-size:\s*\d+px/g;

describe('Feedback rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Feedback rebuild — unified client only', () => {
  it('the hook writes through api.feedback', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toContain('api.feedback.submit');
  });

  it.each(allTsSrcs)('$f uses no axios / legacy client / raw fetch', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]axios['"]/);
    expect(src).not.toMatch(/services\/api['"]/);
    // The legacy page hand-rolled fetch(`${apiBaseUrl}/feedback`).
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/import\.meta\.env\.VITE_API_URL/);
  });

  it.each(allTsSrcs)('$f never reads the bearer token itself', ({ src }) => {
    // The shared axios instance attaches auth; a page doing it by hand is how the old
    // page bypassed the 401 force-logout interceptor.
    expect(src).not.toMatch(/localStorage\s*\.\s*getItem\s*\(\s*['"]aidis_token['"]\s*\)/);
    expect(src).not.toMatch(/Authorization/);
  });
});

describe('Feedback rebuild — tunables live in config (configs-not-hardcoded)', () => {
  it('the option sets + the length cap are defined in config.ts', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/FEEDBACK_TYPES/);
    expect(config).toMatch(/FEEDBACK_SEVERITIES/);
    expect(config).toMatch(/maxMessageLength/);
  });

  it('the page reads the cap from config rather than hardcoding the number', () => {
    expect(pageSrc).toMatch(/FEEDBACK_CONFIG\.maxMessageLength/);
    // Derived from the same source the product reads — never a literal in a test.
    expect(pageSrc).not.toMatch(new RegExp(`\\b${FEEDBACK_CONFIG.maxMessageLength}\\b`));
  });
});

describe('Feedback rebuild — token-driven stylesheet', () => {
  it('carries no hardcoded colour or font-size literals', () => {
    const css = readFileSync(resolve(modDir, 'Feedback.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
    expect(css.match(RAW_COLOUR) ?? []).toEqual([]);
    expect(css.match(PX_FONT_SIZE) ?? []).toEqual([]);
  });
});

describe('Feedback rebuild — the UNSCOPED list is not rendered', () => {
  /**
   * GET /api/feedback selects the whole `feedback` table with no `WHERE username = …`
   * and no admin check, so it hands EVERY user's reports to ANY authenticated caller.
   * Until that route is scoped, no UI may call it — a client-side filter would still
   * ship other people's feedback to the browser. Asserted as an ABSENCE, scoped to this
   * screen (the client method itself still exists and is legitimately callable by an
   * admin surface once the route is scoped).
   */
  it.each(allTsSrcs)('$f never calls api.feedback.list', ({ src }) => {
    expect(src).not.toMatch(/api\.feedback\.list/);
  });
});

describe('Feedback rebuild — the page capture is the PREVIOUS screen', () => {
  it('reads the tracked last-visited path, not window.location at submit time', () => {
    expect(pageSrc).toMatch(/getLastVisitedPath/);
    // The defect: `page: window.location.pathname` always evaluated to '/feedback'.
    expect(pageSrc).not.toMatch(/window\.location\.pathname/);
  });

  it('the shell mounts the tracker (otherwise nothing is ever recorded)', () => {
    const shell = readFileSync(
      resolve(here, '..', 'components', 'shell', 'AppShell.tsx'),
      'utf8',
    );
    expect(shell).toMatch(/useTrackVisitedPath/);
  });
});
