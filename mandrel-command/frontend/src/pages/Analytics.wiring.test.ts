/**
 * Analytics rebuild pattern guard (P3 — follows the Decisions/Contexts screen-rebuild
 * pattern). Source-level invariants — cheap, deterministic, drift-proof:
 *   1. import ZERO antd (the legacy Code-Health/AI/System/Task tabs + antd are CUT);
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated), and ONLY to
 *      live/built endpoints — never a fabricated "actor" read (data-gap policy 10397f65);
 *   3. REUSE the shared P0.6 charting module (components/charts) — no new chart component,
 *      no chart library imported directly (recharts/plotly/@ant-design/plots);
 *   4. carry no hardcoded hex colours in the stylesheet (token-driven).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'analytics');

const pageSrc = readFileSync(resolve(here, 'Analytics.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Analytics.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * ── THE AXIOS BAN IS A LINT RULE NOW (epic 41293984) ─────────────────────────────────
 * `@typescript-eslint/no-restricted-imports` in `.eslintrc.cjs` bans axios value imports
 * across ALL of src/, in every import spelling, with the type-only exclusion handled by
 * the rule itself. It replaced a hand-written regex matcher that this suite used to feed
 * file text — see that config for why, and for the one exemption.
 */


describe('Analytics rebuild — no antd anywhere (legacy tabs cut)', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/plots['"]/);
  });

  it('the page does not carry the cut placeholder tabs', () => {
    expect(pageSrc).not.toMatch(/Code Health|AI Insights|renderComingSoonTab|TabPane/);
  });
});

describe('Analytics rebuild — unified client, live/built endpoints only', () => {
  const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');

  it('hooks read through the unified api client', () => {
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
  });

  it('wires exactly the live/built endpoints (trends, task stats, productive, token-patterns, by-actor)', () => {
    expect(hooks).toMatch(/api\.sessions\.trends\(/);
    expect(hooks).toMatch(/api\.tasks\.stats\(/);
    expect(hooks).toMatch(/api\.sessions\.productive\(/);
    expect(hooks).toMatch(/api\.sessions\.tokenPatterns\(/);
    expect(hooks).toMatch(/api\.sessions\.contextsByActor\(/);
  });

  it('does NOT fetch its own project list — that is contexts/ProjectContext\'s job', () => {
    // The page used to run a per-page `api.projects.list()` purely to fill its own filter.
    // The filter's options now come from `usePageProject`, which reads the ONE central
    // list and the ONE central sort (contexts/ProjectContext). A second copy of a list is
    // how two screens end up ordering the same projects differently, so the absence is
    // the assertion — the deleted read must not creep back (epic 41293984 §D).
    expect(hooks).not.toMatch(/api\.projects\.list\(/);
  });

  /**
   * ── THIS ASSERTION WAS INVERTED ────────────────────────────────────
   * It used to require the actor panel to render "Not yet available" and carry the `wire`
   * provenance, because the actor dimension did not exist on the read path. It does now
   * (prod `sessions.actor`: 137 of 540 non-null, measured 2026-08-10), so the old form
   * asserted a gap that had closed — a guard holding a screen at a state the product had
   * moved past. The invariant worth keeping is not "no actor read" but "the actor read is
   * REAL and its coverage is STATED", which is what replaces it.
   */
  it('the actor panel reads the real by-actor endpoint and states its coverage', () => {
    const actor = readFileSync(resolve(modDir, 'ActorBars.tsx'), 'utf8');
    expect(actor).not.toMatch(/Not yet available/);
    expect(actor).toMatch(/CoverageNote/);
    expect(actor).toMatch(/contexts-by-actor/);
    // Fed by the hook, not by its own fetch: the page owns the ONE scope object.
    expect(actor).not.toMatch(/useQuery|api\.sessions\./);
  });

  it('the provenance KIND vocabulary is gone — no kind, no meta, no legend', () => {
    // Three kinds were deleted one at a time (`wire`, then `built`, then `live` with the
    // legend itself — an earlier task item 2). Asserted across the WHOLE module rather than
    // on the two files that happened to hold them, because a kind left behind anywhere
    // re-introduces a footer claim about which panels are real. Sensitive to a
    // reintroduction under any of the three names it has had.
    for (const { f, src } of allTsSrcs) {
      expect(src, f).not.toMatch(/kind="(wire|built|live)"/);
      // Named in prose is fine (config.ts explains the deletion); DECLARED or IMPORTED
      // is not — that is what would make it reachable again.
      expect(src, f).not.toMatch(/(export\s+const|import[^;]*)\s+PROVENANCE_META/);
      // The type may be NAMED in prose explaining the deletion; it may not be DECLARED
      // or IMPORTED, which is what would make it usable again.
      expect(src, f).not.toMatch(/(export\s+type|import[^;]*)\s+ProvenanceKind/);
    }
    expect(existsSync(resolve(modDir, 'ProvenanceLegend.tsx'))).toBe(false);
  });

  it('every panel prints the ENDPOINT it reads — the thing the legend never carried', () => {
    // With the kinds gone, the only provenance left is the request itself. That is a
    // stronger statement than the legend made and it is derived, not declared: a panel
    // that stopped naming its endpoint would fail here.
    const endpoints: Array<[string, RegExp]> = [
      ['KpiStrip.tsx', /\/api\/sessions\/trends/],
      ['ActivityTrend.tsx', /\/api\/sessions\/trends/],
      ['WorkMix.tsx', /\/api\/tasks\/stats/],
      ['ProductiveSessions.tsx', /\/api\/sessions\/productive/],
      ['ActorBars.tsx', /\/api\/sessions\/contexts-by-actor/],
      ['SessionRhythm.tsx', /\/api\/sessions\/token-patterns/],
    ];
    for (const [file, endpoint] of endpoints) {
      const src = readFileSync(resolve(modDir, file), 'utf8');
      expect(src, file).toMatch(/<Provenance>/);
      expect(src, file).toMatch(endpoint);
    }
  });

  // The axios ban itself is `@typescript-eslint/no-restricted-imports` in .eslintrc.cjs
  // (src-wide, every import spelling) — not a regex here. See that file.
  it('no part imports a chart library directly (reuse the shared charts module)', () => {
    for (const { f, src } of allTsSrcs) {
      expect(src, f).not.toMatch(/from\s+['"]recharts['"]/);
      expect(src, f).not.toMatch(/from\s+['"]plotly/);
    }
  });
});

describe('Analytics rebuild — reuses the shared charting module', () => {
  it('the hero + rhythm + sparkline come from components/charts', () => {
    const trend = readFileSync(resolve(modDir, 'ActivityTrend.tsx'), 'utf8');
    const rhythm = readFileSync(resolve(modDir, 'SessionRhythm.tsx'), 'utf8');
    const kpi = readFileSync(resolve(modDir, 'KpiStrip.tsx'), 'utf8');
    expect(trend).toMatch(/from\s+['"]\.\.\/\.\.\/components\/charts['"]/);
    expect(trend).toMatch(/AreaChartCard/);
    expect(rhythm).toMatch(/BarChartCard/);
    expect(kpi).toMatch(/Sparkline/);
  });
});

describe('Analytics rebuild — token-driven', () => {
  it('the stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'Analytics.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });

  it.each(allTsSrcs)('$f carries no hardcoded hex colour', ({ src }) => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped.match(HEX) ?? []).toEqual([]);
  });
});

describe('Analytics — the page owns its project scope, and does not re-invent it (epic 41293984)', () => {
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
