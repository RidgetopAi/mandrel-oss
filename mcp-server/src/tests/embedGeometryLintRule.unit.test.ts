/**
 * embedGeometryLintRule — the EXECUTABLE claim for what makes an mcp-server test fixture
 * unable to express a vector dimension that disagrees with the active embedder
 *.
 *
 * THE CLASS THIS CLOSES
 *   src/tests/helpers/embedGeometry.ts has offered the derived spelling since an earlier task,
 *   so the right thing was AVAILABLE here — but availability only makes it convenient. A
 *   hardcoded width stayed writable, and a hardcoded width is invisible in a worktree until
 *   the CODE DEFAULT moves under it: on the backend exactly that happened,
 *   `Array.from({ length: 1536 })` going RED on a merged ref against a vector(768) column's
 *   CHECK the moment the default flipped to gemma. This file is the mcp-server half.
 *
 * WHY LINT AND NOT A RUNTIME CHECK: it needs no database and fires under BOTH geometries, so
 * it catches the "correct only by coincidence" spelling that a DB run under the matching
 * embedder waves through.
 *
 * NO DATABASE. This suite lints strings through the real eslint API and reads the embedder
 * registry, which is a pure env read.
 *
 * EVERY ASSERTION BELOW GOES THROUGH THE REAL CONFIG ON DISK, resolved by eslint itself for
 * a real file path — never a copy of the selectors and never a hand-built rule object. That
 * is deliberate: a copied selector list is the artifact that drifts, and resolving by path
 * is the only surface that also sees a config block appended AFTER the test block.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { embedders } from '../config/embeddingConfig.js';

/** mcp-server package root — where eslint.config.js lives. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A path INSIDE the test tree, so eslint resolves the test-file block for it. */
const TEST_FILE = 'src/tests/__embedGeometryLintProbe.test.ts';
/** A PRODUCT path, so eslint resolves the product block for it. */
const PRODUCT_FILE = 'src/config/embeddingConfig.ts';

interface RestrictedSelector {
  selector: string;
  message: string;
}

let eslint: ESLint;
let testRule: unknown;
let productRule: unknown;

/** The selector list off a resolved `no-restricted-syntax` entry; [] when it carries none. */
function selectorsOf(entry: unknown): RestrictedSelector[] {
  return Array.isArray(entry) ? (entry.slice(1) as RestrictedSelector[]) : [];
}

/** Diagnostics from the REAL config, for code linted AS a file in the test tree. */
async function diagnose(code: string, filePath = TEST_FILE) {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
}

/**
 * Every embedder key the registry knows, and the dimension each resolves to — read from the
 * module under pin, at point of use.
 *
 * DERIVED, NOT TYPED. A hand-written pair of numbers here would keep passing forever after a
 * third embedder was added, which is the exact shape of hole this task exists to close.
 */
function registryDimensions(): Array<{ key: string; dim: number }> {
  return Object.values(embedders()).map((spec) => ({ key: spec.key, dim: spec.dimensions }));
}

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  testRule = (await eslint.calculateConfigForFile(path.join(ROOT, TEST_FILE)))
    .rules?.['no-restricted-syntax'];
  productRule = (await eslint.calculateConfigForFile(path.join(ROOT, PRODUCT_FILE)))
    .rules?.['no-restricted-syntax'];
});

describe('the eslint rule that bans a hardcoded embedder dimension in an mcp-server fixture', () => {
  it('the TEST-FILE config carries no-restricted-syntax at ERROR with a non-empty selector list', () => {
    // Assert the population is non-empty FIRST. If the rule resolved to nothing, every
    // "FIRES" assertion below would still be meaningful (real eslint would report nothing
    // and they would go RED) — but every "is SILENT" assertion would pass vacuously, and a
    // guard whose negative cases pass for the wrong reason is the hollow shape (C3).
    expect(Array.isArray(testRule)).toBe(true);
    // A RESOLVED config reports severity numerically; eslint normalises 'error' to 2. This
    // reads the resolved form on purpose — the config source says 'error', and asserting the
    // source spelling here would be asserting the text rather than what eslint will enforce.
    expect((testRule as unknown[])[0]).toBe(2);
    expect(selectorsOf(testRule).length).toBeGreaterThan(0);
  });

  it('the test config is a SUPERSET of the product config — no base selector is clobbered', () => {
    // ★ THE TRAP. Rule OPTIONS do not merge across config blocks; the later block REPLACES
    // them wholesale. A bare `['error', ...EMBEDDER_DIMENSION_SELECTORS]` in the test block
    // would switch off every other selector this project put on that rule, across the whole
    // test tree, with zero lines of those selectors changing. On the backend that would have
    // disabled the project-scope guard over 99 test files, and that guard's own 194-test
    // suite passed 194/194 with its rule switched off — blind to its own disablement.
    //
    // Resolved BY PATH rather than read off the exported array, so this also fails if a
    // future config block appended after the test block re-opens the hole.
    const base = selectorsOf(productRule).map((s) => s.selector);
    const test = selectorsOf(testRule).map((s) => s.selector);
    for (const selector of base) {
      expect(test, `product selector lost in the test config: ${selector}`).toContain(selector);
    }
    expect(test.length).toBeGreaterThan(base.length);
  });

  it('MEASURED: the product config carries NO no-restricted-syntax selectors today', () => {
    // The superset assertion above is VACUOUS while this is empty — it can only protect a
    // base selector that exists. Stating the emptiness is what keeps that visible instead of
    // hidden. When someone adds the first base selector this goes RED and sends them to the
    // superset test, which from that moment is the thing doing the protecting.
    expect(selectorsOf(productRule).map((s) => s.selector)).toEqual([]);
  });

  it('EVERY dimension in the registry is banned — a new embedder cannot leave a hole', () => {
    const dims = registryDimensions();
    expect(dims.length).toBeGreaterThanOrEqual(2); // minilm + gemma; never an empty sweep
    const selectors = selectorsOf(testRule).map((s) => s.selector);
    for (const { key, dim } of dims) {
      expect(typeof dim).toBe('number');
      // Named in the failure output so a miss says WHICH embedder is unguarded.
      expect({ key, selectors }).toEqual({
        key,
        selectors: expect.arrayContaining([`Literal[value=${dim}]`]),
      });
    }
  });

  it.each(registryDimensions())(
    'FIRES on a fixture that writes the $key dimension by hand',
    async ({ dim }) => {
      const msgs = await diagnose(`const v = new Array(${dim}).fill(0);\n`);
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs[0].message).toContain('embedGeometry');
    },
  );

  it.each(registryDimensions())(
    'FIRES on the $key dimension written as an object property, not just an array width',
    async ({ dim }) => {
      expect((await diagnose(`const stub = { dimensions: ${dim} };\n`)).length).toBeGreaterThan(0);
    },
  );

  it.each(registryDimensions())(
    'FIRES on a NON-DECIMAL spelling of the $key dimension — it is an AST rule, not a text scan',
    async ({ dim }) => {
      // The reason this is a selector on VALUE and not a regex over source text: a text scan
      // reads spellings, and every spelling it did not think of fails open. eslint resolves
      // the literal, so hex and exponential are the same node.
      const hex = `0x${dim.toString(16)}`;
      expect((await diagnose(`const v = new Array(${hex}).fill(0);\n`)).length).toBeGreaterThan(0);
    },
  );

  it('is SILENT on the derived spelling — the guard does not block correct work', async () => {
    // C3's corollary: a guard that flags the right answer gets deleted the first time it is
    // inconvenient. This is the exact code the routed fixtures now contain.
    expect(
      await diagnose(
        `import { zeroEmbedding, embedDim } from './helpers/embedGeometry.js';\n` +
          `const a = zeroEmbedding();\n` +
          `const b = new Array(embedDim()).fill(0.01);\n`,
      ),
    ).toEqual([]);
  });

  it('is SILENT on an unrelated number that is not an embedder dimension', async () => {
    expect(await diagnose('const limit = 24; const page = 100;\n')).toEqual([]);
  });

  it('is SILENT on the EMPTY file and on a file with no numeric literals at all', async () => {
    // The empty / absent population: a rule that reports on nothing would make every RED
    // above meaningless, and an empty input is the one nobody writes a case for.
    expect(await diagnose('')).toEqual([]);
    expect(await diagnose('export const nothing = "here";\n')).toEqual([]);
  });

  it('does NOT fire on prose — comments are not AST nodes', async () => {
    const { dim } = registryDimensions()[0];
    expect(
      await diagnose(`// the old fixture said ${dim} and only worked under one embedder\nconst x = 1;\n`),
    ).toEqual([]);
  });

  it('does NOT govern PRODUCT files — the registry itself must be able to state a width', async () => {
    // Scope statement, executed rather than written: src/config/embeddingConfig.ts declares
    // these numbers as the registry's own data. If the rule reached product code the registry
    // could not spell its own geometry, and the guard would be deleted the same day.
    for (const { dim } of registryDimensions()) {
      expect(
        await diagnose(`export const dimensions = ${dim};\n`, PRODUCT_FILE),
      ).toEqual([]);
    }
  });

  it('an eslint-disable ON THE LINE is the legitimate escape hatch', async () => {
    // A past incident — a co-located exception with a written reason, never a central allow-list.
    const { dim } = registryDimensions()[0];
    expect(
      await diagnose(
        `// eslint-disable-next-line no-restricted-syntax -- asserting the registry's own width\n` +
          `const legacyWidth = ${dim};\n`,
      ),
    ).toEqual([]);
  });
});

describe('the fixtures this task routed through the helper', () => {
  it('no file in the test tree writes a registry dimension by hand', async () => {
    // The COMPLETENESS claim, executed. A prose list of "the three fixtures" would be a
    // count with no command behind it and would go stale the first time a fixture is added;
    // this lints the whole tree through the real config and asserts the population is zero.
    const results = await eslint.lintFiles([path.join(ROOT, 'src')]);
    // POPULATION FLOOR (Reviewer N1). `toEqual([])` is a count-shaped predicate, and an
    // empty population satisfies it while asserting nothing. If `src/**` ever lands in
    // `ignores`, lintFiles returns zero results and this test goes green having linted
    // NOTHING — the emptiness would read as "clean". 498 files today; the floor is set
    // far below that so it fails on collapse, not on ordinary growth or pruning.
    expect(results.length).toBeGreaterThan(100);
    const offenders = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-restricted-syntax')
        .map((m) => `${path.relative(ROOT, r.filePath)}:${m.line}`),
    );
    expect(offenders).toEqual([]);
  }, 120_000);
});
