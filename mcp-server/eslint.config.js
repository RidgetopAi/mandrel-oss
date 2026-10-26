// ESLint v9 flat config for the Mandrel MCP server.
// Replaces the legacy .eslintrc setup (the old `lint` script silently no-op'd
// because v9 requires a flat config). Pragmatic baseline: TypeScript-aware,
// with the noisiest rules as warnings so the linter gives signal without a
// wall of errors. Tighten over time (task B1 / B4).

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

/**
 * EMBEDDER-DIMENSION SELECTORS — TEST FILES ONLY.
 *
 * A test fixture must never write a vector dimension as a number. src/tests/helpers/
 * embedGeometry.ts has offered the derived spelling since an earlier task, so the right thing
 * was AVAILABLE here — but availability only makes it convenient, it does not make the wrong
 * thing unwritable. This is the enforcement half, ported from the backend,
 * where a hardcoded 1536 went RED on a merged ref the moment the CODE DEFAULT flipped to
 * gemma, against a vector(768) column's CHECK.
 *
 * WHY A LINT RULE AND NOT A RUNTIME CHECK: lint needs no database and fires under BOTH
 * geometries, so it catches the "correct only by coincidence" spelling that a DB run under
 * the matching embedder waves through.
 *
 * WHAT THIS MATCHES: a numeric literal whose VALUE equals a known embedder dimension,
 * anywhere in a file the test block below governs. It is an AST rule, so every numeric
 * spelling of the same value is matched and prose is not — comments are not AST nodes.
 * It says nothing about what an evader cannot do.
 *
 * THE NUMBERS ARE PINNED, NOT TRUSTED: src/tests/embedGeometryLintRule.unit.test.ts derives
 * the dimension of every key in embedders() from src/config/embeddingConfig.ts and fails if
 * one of them is missing here, so adding a third embedder cannot quietly leave a hole.
 * (This file is plain ESM `.js` and cannot import the TypeScript registry; the test is what
 * closes that gap.)
 *
 * TO WRITE ONE LEGITIMATELY: an eslint-disable ON THE LINE with a written reason
 * (a past incident — co-located exception, never a central allow-list).
 */
const EMBEDDER_DIMENSION_SELECTORS = [1536, 768].map((dim) => ({
  selector: `Literal[value=${dim}]`,
  message:
    `${dim} is a known embedder dimension. A test fixture must not write a vector width by ` +
    'hand — import embedDim/zeroEmbedding/patternEmbedding from ' +
    "'./helpers/embedGeometry.js' (or read it from embedders()) so the fixture tracks " +
    'MANDREL_EMBEDDER instead of being correct only by coincidence. ' +
    'Legitimate use: eslint-disable on the line, with the reason.',
}));

/**
 * The PRODUCT ruleset, hoisted into a named const for one reason: the test block below has
 * to re-state its `no-restricted-syntax` options, and it must do so by DERIVING them rather
 * than by hand-copying.
 *
 * ★ THE TRAP. A rule that appears in two config blocks does not MERGE its options — the
 * later block REPLACES them wholesale. So a bare
 * `'no-restricted-syntax': ['error', ...EMBEDDER_DIMENSION_SELECTORS]` in the test block
 * would silently switch off every other selector this project had ever put on that rule,
 * across the whole test tree, without one line of those selectors changing. That is exactly
 * what nearly shipped on the backend: it would have disabled the
 * project-scope guard over 99 test files, and that guard's own 194-test
 * suite passed 194/194 with the rule switched off — completely blind to its own disablement.
 *
 * Deriving the base selectors from this object is what makes the clobber unrepresentable
 * instead of merely tested: anything added to SRC_RULES is carried into the test block
 * automatically. embedGeometryLintRule.unit.test.ts asserts the resulting SUPERSET relation
 * against eslint's own resolved config, so a future block appended AFTER the test block
 * cannot re-open the hole either.
 */
const SRC_RULES = {
  // TypeScript itself handles undefined identifiers + globals.
  'no-undef': 'off',
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
  ],
  // Too noisy to enforce as errors in this codebase yet — surface as warnings.
  '@typescript-eslint/no-explicit-any': 'off',
  'no-empty': 'warn',
  'no-useless-escape': 'warn',
  'no-control-regex': 'off',
};

/**
 * The base `no-restricted-syntax` selectors, read off SRC_RULES. Normalised because a rule
 * may be configured as a bare severity string (`'error'`) with no options, in which case
 * there are no selectors to carry — slicing a string there would produce garbage that lints
 * nothing and reports nothing, which is the silent-failure shape this whole comment is about.
 */
function restrictedSyntaxSelectors(entry) {
  return Array.isArray(entry) ? entry.slice(1) : [];
}
const BASE_RESTRICTED_SYNTAX = restrictedSyntaxSelectors(SRC_RULES['no-restricted-syntax']);

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // NOTE: 'scripts/**' was globally ignored here until an earlier task, so the
      // lint gate covered ZERO operational code — migrations, production-data
      // backfills and regen-tool-surface-golden.ts (which regenerates a gate
      // fixture) were linted by nothing while `npm run lint` reported green.
      // That is the SAME hole the typecheck gap had, one layer over: the two
      // gates shared a blind spot and each looked like coverage for the other.
      // scripts/ and evals/ are linted now, by the two blocks below.
      '**/*.d.ts',
      // NOTE: **/*.test.ts is intentionally NOT ignored. Test files
      // were previously excluded here, so the lint gate covered ZERO test code —
      // test drift (unused vars, dead disable-directives, floating promises) went
      // unseen and CI-green-on-lint said nothing about tests. They ARE linted now,
      // under a test-appropriate ruleset (the dedicated block at the end of this file).
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...SRC_RULES,
    },
  },
  {
    // --- Operational TypeScript: scripts/ and evals/ — an earlier task ---
    // These run the SAME product ruleset as src/ (tsPlugin recommended + SRC_RULES),
    // derived from the same const rather than hand-copied, so a future tightening of
    // SRC_RULES reaches this code too instead of quietly leaving it behind.
    // NOTHING is relaxed here. If a file genuinely cannot come under the linter it is
    // named in `ignores` above with the reason — never absorbed by a weakened rule.
    files: ['scripts/**/*.ts', 'evals/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...SRC_RULES,
    },
  },
  {
    // --- Operational plain JS: scripts/ and evals/ *.mjs|.cjs|.js — an earlier task ---
    // A SEPARATE block, deliberately, because `no-undef` must stay ON for these.
    // SRC_RULES switches `no-undef` off for TypeScript, which is correct there and
    // only there: tsc is what catches an undefined identifier in a .ts file, and as
    // of an earlier task it actually does for scripts/ and evals/. Nothing typechecks
    // a .mjs, so switching `no-undef` off for these would trade a real check for
    // nothing. Node's globals are DECLARED rather than the rule weakened — the
    // 34 `'console' is not defined` errors this surfaced were a missing environment
    // declaration, not a code defect, and silencing the rule would have hidden the
    // real undefined identifiers along with them.
    files: [
      'scripts/**/*.mjs', 'scripts/**/*.cjs', 'scripts/**/*.js',
      'evals/**/*.mjs', 'evals/**/*.cjs', 'evals/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // --- PACKAGE-ROOT TOOLING: TypeScript — an earlier task ---
    // `npm run lint` used to pass the argument list `src scripts evals`, so anything
    // sitting at the package ROOT was outside the lint population no matter what this
    // file said. That included vitest.setup.ts — the setupFile every test file in the
    // suite loads, and therefore code on the authoritative gate's own execution path —
    // plus vitest.config.ts, vitest.order-matrix.config.ts and tools/. The argument list
    // is now `.`, so the POPULATION is the package and the exclusions are the `ignores`
    // block above: a new root-level file is covered by default instead of by remembering
    // to extend an argument list. Same ruleset as src/, derived from the same const.
    files: ['*.ts', 'tools/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...SRC_RULES,
    },
  },
  {
    // --- PACKAGE-ROOT TOOLING: plain JS/ESM — an earlier task ---
    // Split from the TypeScript block for the reason the scripts/evals pair is split:
    // `no-undef` must stay ON where nothing typechecks the file. Node's globals are
    // DECLARED rather than the rule weakened.
    files: ['*.js', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // --- PACKAGE-ROOT TOOLING: CommonJS — an earlier task ---
    // sourceType 'commonjs' so `require`/`module` parse as what they are. Declaring
    // globals.node here is what clears the 28 `no-undef` errors the two root .cjs files
    // produced the first time anything linted them (20 + 8, `eslint . -f json`); they are
    // a missing environment declaration, not code defects, and silencing `no-undef`
    // instead would have hidden the real undefined identifiers along with them. The 29th
    // error was a genuinely unused catch binding, fixed in the file rather than tolerated.
    files: ['*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    // --- Test files (vitest) — an earlier task ---
    // Test code IS linted (see the note in `ignores` above), but under a ruleset
    // tuned for tests. These files match `src/**/*.ts` too, so they inherit the
    // product block above; this block layers on top of it to:
    //   1. Declare the vitest globals. `vitest.config.ts` sets `globals: true`, so
    //      describe/it/expect/vi/beforeEach/... are ambient — declare them here so
    //      they stay valid if the product block's `no-undef` is ever tightened back on.
    //   2. Keep the test-idiomatic rules relaxed. Tests legitimately use `any`,
    //      non-null assertions and throwaway fixture bindings; the product ruleset is
    //      slated to "tighten over time" (see the file header) — pinning these here
    //      insulates healthy test code from that tightening so it can't suddenly break
    //      the lint gate. The linter still catches real problems (syntax, dead
    //      directives, obvious mistakes) in tests.
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        suite: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // BASE FIRST, then the test-only additions — see the ★ TRAP comment at the top of this
      // file. `overrides`/later-block rule options REPLACE, they do not merge; dropping the
      // spread here would switch off every base selector across the whole test tree.
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...EMBEDDER_DIMENSION_SELECTORS],
    },
  },
];
