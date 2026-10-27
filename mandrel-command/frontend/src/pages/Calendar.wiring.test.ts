/**
 * Calendar rebuild pattern guard (P1 — follows the Dashboard/Sessions screen-rebuild
 * pattern). Asserts the Calendar page + its `calendar/` module:
 *   1. import ZERO antd;
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated);
 *   3. carry no hardcoded hex colours in the stylesheet (token-driven).
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'calendar');

const pageSrc = readFileSync(resolve(here, 'Calendar.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Calendar.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * ── THE AXIOS BAN IS A LINT RULE NOW ─────────────────────────────────
 * `@typescript-eslint/no-restricted-imports` in `.eslintrc.cjs` bans axios value imports
 * across ALL of src/, in every import spelling, with the type-only exclusion handled by
 * the rule itself. It replaced a hand-written regex matcher that this suite used to feed
 * file text — see that config for why, and for the one exemption.
 */


describe('Calendar rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Calendar rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.(sessions|projects|tasks)\./);
  });

  // The axios ban itself is `@typescript-eslint/no-restricted-imports` in .eslintrc.cjs
  // (src-wide, every import spelling) — not a regex here. See that file.
  it('no part imports the generated service clients directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/services\/api['"]/);
      expect(src).not.toMatch(/api\/sessionsClient['"]/);
    }
  });
});

describe('Calendar rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'Calendar.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});

describe('Calendar — the page owns its project scope, and does not re-invent it', () => {
  /**
   * Source-level DRIFT guards only. They cannot prove the request is scoped correctly —
   * that is what the behavioural suites do, against the header a request would actually
   * carry, and what `backend/src/__tests__/pageScopedProjectScope.db.test.ts` does against
   * rows planted in a second project. What these DO catch is the specific regression this
   * migration is exposed to: a later edit re-introducing page-local project state, or a
   * second hand-rolled selector, either of which puts the screen back into the
   * two-competing-scopes state the whole epic exists to remove.
   */
  it('takes its project from the shared usePageProject hook', () => {
    expect(pageSrc).toMatch(/usePageProject/);
  });

  it('keeps NO local project state — the URL param is the source of truth', () => {
    expect(pageSrc).not.toMatch(/useState[^\n]*projectId/i);
    expect(pageSrc).not.toMatch(/setProjectId/);
  });

  it('renders NO project filter of its own — the ONE switch is in the shell', () => {
    // PRODUCT files only — the module's own tests also contain that query string, and a
    // guard whose population accidentally includes its own tests measures itself.
    const productSrcs = partSrcs.filter(({ f }) => !/\.test\.tsx?$/.test(f));
    const toolbars = productSrcs.filter(({ src }) => /aria-label="Filter by project"/.test(src));
    expect(toolbars.length, 'no page-level project filter control').toBe(0);
    expect(productSrcs.some(({ src }) => /sortProjectsByRecentActivity/.test(src))).toBe(false);
  });
});
