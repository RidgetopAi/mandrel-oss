/**
 * Sessions rebuild pattern guard (P1 — follows the Dashboard screen-rebuild
 * pattern). Asserts the rebuilt Sessions page + its `sessions/` module:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated);
 *   3. carry no hardcoded hex colours in the stylesheet (token-driven).
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'sessions');

const pageSrc = readFileSync(resolve(here, 'Sessions.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Sessions.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * ── THE AXIOS BAN IS A LINT RULE NOW, NOT A REGEX HERE ───────────────
 * It used to be a hand-written matcher (`src/testSupport/axiosValueImport.ts`) fed the
 * TEXT of the files each wiring suite happened to list. That was a TypeScript import
 * parser written in regex: "completed" three times and still holed (it false-REDs on the
 * inline `import { type X } from 'axios'` idiom and missed `import 'axios';`), and its
 * population was three remembered lists — a page in none of them was invisible to it.
 * Deleted. `@typescript-eslint/no-restricted-imports` in `.eslintrc.cjs` now bans axios
 * value imports across ALL of src/ (see that file for the exemption + the probe).
 */


describe('Sessions rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Sessions rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.(sessions|projects)\./);
  });

  it('no part imports the generated service clients directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/services\/api['"]/);
      expect(src).not.toMatch(/api\/sessionsClient['"]/);
    }
  });
});

describe('Sessions rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'Sessions.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});

describe('Sessions — the page owns its project scope, and does not re-invent it', () => {
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
