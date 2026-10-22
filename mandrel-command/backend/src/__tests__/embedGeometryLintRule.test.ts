/**
 * embedGeometryLintRule — the EXECUTABLE claim for the two things that together make a
 * backend test fixture unable to express a vector dimension that disagrees with the active
 * embedder.
 *
 * THE CLASS THIS CLOSES
 *   Stage 4 of the CI gate (backend jest) supplies no MANDREL_EMBEDDER and has no second
 *   embedder axis, so it runs at whatever the CODE DEFAULT is. On 2026-08-19 flipping that
 *   default to gemma turned two fixtures RED — they said `Array.from({ length: 1536 })`
 *   against a vector(768) column with a CHECK constraint. Invisible in every worktree,
 *   visible only on a merged ref (C4). Fixing those two fixtures did not close anything;
 *   the next fixture written the same way lands the same way.
 *
 * THE TWO HALVES, AND WHY THEY ARE BOTH HERE
 *   1. src/__tests__/helpers/embedGeometry.ts — the derived spelling, so it is the EASY
 *      one. Its vectorLiteral() also refuses a vector whose length disagrees, so a wrong
 *      length that no static rule enumerates still fails loudly and by name.
 *   2. the `no-restricted-syntax` entries in .eslintrc.js's test-file override — a known
 *      embedder dimension written as a numeric literal under src/__tests__/ is a lint
 *      ERROR, which is the CI gate STAGE L. That layer needs no database and fires under
 *      BOTH geometries, which is the part the DB cannot do: a 1536 under minilm inserts
 *      perfectly happily, and that is precisely the "correct by coincidence" state an earlier task
 *      exists to delete.
 *
 * THIS FILE LOADS THE REAL .eslintrc.js BY PATH, never a copy of the selectors — the same
 * arrangement projectScopeLintRule.test.ts settled on after a copied selector list drifted.
 */
// db-gate-exempt: no database — this suite lints strings and calls a pure config helper
// (0 occurrences of Pool/Client/.query).

interface LintMessage {
  ruleId: string | null;
  message: string;
  line: number;
}
interface LinterLike {
  defineParser(name: string, parser: unknown): void;
  verify(code: string, config: unknown): LintMessage[];
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Linter } = require('eslint') as { Linter: new () => LinterLike };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tsParser: unknown = require('@typescript-eslint/parser');

interface EslintOverride {
  files: string[];
  rules?: Record<string, unknown>;
}
interface RestrictedSelector {
  selector: string;
  message: string;
}

// A LITERAL specifier, deliberately: dbTestGateCoverage.test.ts forbids a computed
// require() in a test file, and a literal still resolves to the one real config on disk.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realEslintrc = require('../../.eslintrc.js') as {
  rules: Record<string, unknown>;
  overrides: EslintOverride[];
};

/** The base rule options — the project-scope guard, applied to every file. */
const BASE_RULE = realEslintrc.rules['no-restricted-syntax'] as [string, ...RestrictedSelector[]];

/**
 * The override that governs test files. Found by ASKING which override carries the rule,
 * not by index: an index would go quietly stale the first time an override is inserted
 * above it, and the failure mode of that staleness is a guard that no longer runs.
 */
const TEST_OVERRIDES = realEslintrc.overrides.filter(
  (o) => o.rules && o.rules['no-restricted-syntax'],
);
const OVERRIDE_RULE = TEST_OVERRIDES[0]?.rules?.['no-restricted-syntax'] as
  | [string, ...RestrictedSelector[]]
  | undefined;

const linter: LinterLike = new Linter();
linter.defineParser('@typescript-eslint/parser', tsParser);

/** Diagnostics from the REAL test-file rule options for a snippet. */
function diagnose(code: string): LintMessage[] {
  return linter
    .verify(code, {
      parser: '@typescript-eslint/parser',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      rules: { 'no-restricted-syntax': OVERRIDE_RULE },
    })
    .filter((m) => m.ruleId === 'no-restricted-syntax');
}

/**
 * Every embedder key the registry knows, and the dimension each one resolves to — read
 * from the module under pin, with a fresh require per key so the point-of-use env read is
 * exercised rather than a value frozen at first import.
 *
 * DERIVED, NOT TYPED. A hand-written [1536, 768] here would pass forever after a third
 * embedder was added, which is the shape of hole this whole task is about.
 */
function registryDimensions(): Array<{ key: string; dim: number }> {
  const saved = process.env.MANDREL_EMBEDDER;
  try {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const keys = (require('../config/embeddingColumn') as typeof import('../config/embeddingColumn'))
      .knownEmbedderKeys();
    return keys.map((key) => {
      process.env.MANDREL_EMBEDDER = key;
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('../config/embeddingColumn') as typeof import('../config/embeddingColumn');
      return { key, dim: fresh.activeEmbeddingDimensions() };
    });
  } finally {
    if (saved === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = saved;
    jest.resetModules();
  }
}

describe('the eslint rule that bans a hardcoded embedder dimension in a backend fixture', () => {
  it('the test-file override EXISTS and carries no-restricted-syntax', () => {
    // If this array is empty the entire guard is off and every assertion below would pass
    // vacuously against `undefined` options. Assert the population is non-empty FIRST.
    expect(TEST_OVERRIDES.length).toBe(1);
    expect(TEST_OVERRIDES[0].files).toEqual(
      expect.arrayContaining(['**/*.test.ts', '**/__tests__/**/*.ts']),
    );
    expect(Array.isArray(OVERRIDE_RULE)).toBe(true);
    expect(OVERRIDE_RULE?.[0]).toBe('error');
  });

  it('the override is a SUPERSET of the base rule — the project-scope guard is not lost in tests', () => {
    // eslint `overrides` REPLACES a rule's options; it does not merge them. A bare
    // `['error', ...embedDimSelectors]` in the override would switch the project-scope
    // guard OFF for the whole test tree without one line of it changing,
    // and nothing else in this repo would notice.
    const baseSelectors = BASE_RULE.slice(1) as RestrictedSelector[];
    const overrideSelectors = (OVERRIDE_RULE ?? []).slice(1) as RestrictedSelector[];
    expect(baseSelectors.length).toBeGreaterThan(0);
    for (const s of baseSelectors) {
      expect(overrideSelectors.map((o) => o.selector)).toContain(s.selector);
    }
    expect(overrideSelectors.length).toBeGreaterThan(baseSelectors.length);
  });

  it('EVERY dimension in the registry is banned — a new embedder cannot leave a hole', () => {
    const dims = registryDimensions();
    expect(dims.length).toBeGreaterThanOrEqual(2); // minilm + gemma; never an empty sweep
    const selectors = ((OVERRIDE_RULE ?? []).slice(1) as RestrictedSelector[]).map((s) => s.selector);
    for (const { key, dim } of dims) {
      expect(typeof dim).toBe('number');
      // Named in the failure message so a miss says WHICH embedder is unguarded.
      expect({ key, selectors }).toEqual({
        key,
        selectors: expect.arrayContaining([`Literal[value=${dim}]`]),
      });
    }
  });

  it.each(registryDimensions())(
    'FIRES on a fixture that writes the $key dimension by hand',
    ({ dim }) => {
      const msgs = diagnose(`const v = Array.from({ length: ${dim} }, () => 0.1);`);
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs[0].message).toContain('embedGeometry');
    },
  );

  it.each(registryDimensions())('FIRES on `"0.1,".repeat($key dimension)`', ({ dim }) => {
    expect(diagnose(`const v = '0.1,'.repeat(${dim});`).length).toBeGreaterThan(0);
  });

  it('is SILENT on the derived spelling — the guard does not block correct work', () => {
    // C3's corollary: a guard that flags the right answer gets deleted the first time it
    // is inconvenient. This is the exact code the fixtures now contain.
    expect(
      diagnose(
        `import { vectorLiteral, embedDim } from './helpers/embedGeometry';\n` +
          `const a = vectorLiteral();\n` +
          `const b = Array.from({ length: embedDim() }, () => 0.1);\n`,
      ),
    ).toEqual([]);
  });

  it('is SILENT on an unrelated number that is not an embedder dimension', () => {
    expect(diagnose('const limit = 24; const page = 100;')).toEqual([]);
  });

  it('does NOT fire on prose — comments are not AST nodes', () => {
    // This is why the guard is an AST rule and not a text scan. The two fixture files and
    // the registry's own header discuss 1536 in prose; a text scan would have to parse
    // comments to tell those apart, and a bespoke parser that fails open on what it cannot
    // read is this repo's most-repeated guard defect (four rounds).
    expect(diagnose('// the old fixture said 1536 and only worked under minilm\nconst x = 1;')).toEqual([]);
  });
});

describe('helpers/embedGeometry — the derived spelling is the easy one', () => {
  // Required fresh so the module reads the env this test set, not one frozen at import.
  function fresh(embedder?: string) {
    if (embedder === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = embedder;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./helpers/embedGeometry') as typeof import('./helpers/embedGeometry');
  }

  const saved = process.env.MANDREL_EMBEDDER;
  afterAll(() => {
    if (saved === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = saved;
    jest.resetModules();
  });

  it.each(registryDimensions())(
    'sizes every constructor to the ACTIVE embedder ($key)',
    ({ key, dim }) => {
      const g = fresh(key);
      expect(g.embedDim()).toBe(dim);
      expect(g.zeroEmbedding()).toHaveLength(dim);
      expect(g.patternEmbedding()).toHaveLength(dim);
      // The pgvector text form carries exactly `dim` comma-separated components.
      expect(g.vectorLiteral().split(',')).toHaveLength(dim);
    },
  );

  it('tracks the CODE DEFAULT when MANDREL_EMBEDDER is absent — the Stage 4 condition', () => {
    // Stage 4 of the clean gate supplies no MANDREL_EMBEDDER. That is not a bug to be
    // pinned around; it is the condition the fixtures must be correct under.
    const g = fresh(undefined);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require('../config/embeddingColumn') as typeof import('../config/embeddingColumn');
    expect(g.embedDim()).toBe(cfg.activeEmbeddingDimensions());
    expect(g.zeroEmbedding()).toHaveLength(cfg.activeEmbeddingDimensions());
  });

  it('THROWS on a vector whose length disagrees with the active embedder', () => {
    const g = fresh(undefined);
    expect(() => g.vectorLiteral(new Array(g.embedDim() + 1).fill(0))).toThrow(/dimensions but the ACTIVE/);
  });

  it('THROWS on the EMPTY vector rather than emitting `[]`', () => {
    // The empty population, which is the one that slips through: an empty fixture emits a
    // literal postgres accepts nowhere and, worse, is the shape that produces a suite
    // asserting over zero rows.
    const g = fresh(undefined);
    expect(() => g.vectorLiteral([])).toThrow(/0 dimensions/);
  });

  it('names the active COLUMN as well as the geometry, so a fixture needs one import', () => {
    expect(fresh('gemma').activeEmbeddingColumn()).toBe('embedding_gemma');
    expect(fresh('minilm').activeEmbeddingColumn()).toBe('embedding');
  });
});
