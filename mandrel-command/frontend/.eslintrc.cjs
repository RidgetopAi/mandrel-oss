// ESLint config for the Command UI frontend (Vite shell, eslint 8 classic format).
//
// Moved out of package.json's "eslintConfig" so the migration-era severity
// rationale below can live *with* the config (JSON can't hold comments).
// ── DYNAMIC `import.meta.env` READS ARE BANNED, src-wide ─────────
//
// Vite can only tree-shake env vars it can see STATICALLY (`import.meta.env.VITE_X`).
// Any form that lets the env OBJECT escape — a computed read `import.meta.env[name]`,
// an alias `const e = import.meta.env`, a destructure, a spread, passing it as an
// argument — forces Vite to inline the ENTIRE env object into that chunk, shipping
// EVERY loaded VITE_ var (readers or not) to every tenant. Measured 2026-08-03:
// three chunks in the on-host build carried the untracked `.env.production.local`
// verbatim, including VITE_MCP_BASE_URL, a var with NO reader in src.
//
// POPULATION OF THIS LINT LAYER (stated per CLASSES.md C3): the escape shapes
// enumerated in the selectors below. It is deliberately NOT claimed to be exhaustive
// — the CHOKE POINT every leak must pass through is the built bundle itself, and
// scripts/check-frontend-bundle-env.sh REDs on any env-object dump or VITE_ key in
// the emitted JS regardless of how it got there. This rule exists for fast feedback
// at the editor/lint stage; the bundle scan is the proof.
//
// Defined once here and injected in BOTH `rules` and the pages/components/contexts
// override below, because an override's `no-restricted-syntax` REPLACES (not merges)
// the top-level array — one copy would silently vanish for exactly those files.
const DYNAMIC_ENV_READ_BANS = [
  {
    selector:
      "MemberExpression[computed=true][object.object.type='MetaProperty'][object.property.name='env']",
    message:
      'Dynamic env read (`import.meta.env[name]`) inlines the ENTIRE env object into the bundle. Read statically (`import.meta.env.VITE_X`) and pass the VALUE to your helper — see src/pages/calendar/daySummaryConfig.ts.',
  },
  {
    selector:
      "VariableDeclarator > MemberExpression.init[object.type='MetaProperty'][property.name='env']",
    message:
      'Aliasing/destructuring `import.meta.env` defeats Vite static replacement and inlines the whole env object. Read each var statically: `import.meta.env.VITE_X`.',
  },
  {
    selector:
      "SpreadElement > MemberExpression.argument[object.type='MetaProperty'][property.name='env']",
    message:
      'Spreading `import.meta.env` serializes the whole env object into the bundle. Read each var statically: `import.meta.env.VITE_X`.',
  },
  {
    selector:
      "CallExpression > MemberExpression.arguments[object.type='MetaProperty'][property.name='env']",
    message:
      'Passing the whole `import.meta.env` object inlines it into the bundle. Pass the single value you need: `import.meta.env.VITE_X`.',
  },
  // A single `as` cast (`(import.meta.env as Record<string,string>)[name]`) slips
  // the shapes above because the cast node wraps the env member — measured during
  // this task's own mutation probe, and flagged by Reviewer (N1). Note the cast
  // form does not even leak: Vite then inlines `{}` and every read is silently
  // undefined — a functional bug, still banned. One cast layer is covered; a
  // double cast (`as unknown as X`) is not — the bundle scan remains the choke point.
  {
    selector:
      "MemberExpression[computed=true][object.type='TSAsExpression'][object.expression.object.type='MetaProperty'][object.expression.property.name='env']",
    message:
      'Casting `import.meta.env` to index it defeats Vite static replacement (the reads become undefined in production). Read statically: `import.meta.env.VITE_X`.',
  },
  {
    selector:
      "VariableDeclarator > TSAsExpression.init > MemberExpression.expression[object.type='MetaProperty'][property.name='env']",
    message:
      'Aliasing a cast `import.meta.env` defeats Vite static replacement. Read each var statically: `import.meta.env.VITE_X`.',
  },
];

// ── RUNTIME axios LOADS ──────────────────────────────────────────
// `@typescript-eslint/no-restricted-imports` (configured below) is an ES-MODULE rule:
// it sees `import … from 'axios'` in every spelling, but NOT `await import('axios')`
// and NOT `require('axios')`. MEASURED on this toolchain (eslint 8.57.1 /
// @typescript-eslint 6.21.0, 2026-08-08): a file containing only
// `(await import('axios')).default` lints CLEAN under both the extension rule and the
// base rule. The matcher this ban replaces did cover both forms, so covering them here
// is what keeps the swap a strict upgrade instead of a quiet narrowing.
//
// These are declarative ESLint SELECTORS over the parser's own AST — not a hand-written
// grammar. Zero occurrences in src today (`grep -rn "import('axios')\|require('axios')"
// src/` -> 0); this exists so the ban cannot be phrased around.
//
// Defined once and injected into BOTH `no-restricted-syntax` arrays for the same reason
// DYNAMIC_ENV_READ_BANS is: an override REPLACES the array, it does not merge.
const AXIOS_RUNTIME_LOAD_BANS = [
  {
    selector: "ImportExpression > Literal[value='axios']",
    message:
      "Dynamic `import('axios')` bypasses the unified client in src/api (auth header, project scope, error normalisation). Use src/api; the single axios instance lives in src/services/api.ts.",
  },
  {
    selector: "CallExpression[callee.name='require'] > Literal[value='axios']",
    message:
      "`require('axios')` bypasses the unified client in src/api. Use src/api; the single axios instance lives in src/services/api.ts.",
  },
];

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: {
    react: { version: 'detect' },
  },
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',

    // --- Migration-era severity (Command redesign) ---
    // The antd/legacy screens are being replaced screen-by-screen by the
    // Command redesign. `no-explicit-any` is surfaced as a WARNING during the
    // port (not 'off' — we still want to see it) and will be tightened back to
    // 'error' once the migration completes and the legacy screens are gone.
    // CI allows warnings (`--max-warnings=-1`); only errors fail the lint stage.
    // Do NOT mass-rewrite `any` on soon-to-be-deleted code — that's churn.
    '@typescript-eslint/no-explicit-any': 'warn',

    // Honor the `_`-prefix convention for intentionally-unused bindings
    // (e.g. positional args / destructured API you must name but don't use).
    // Stays an ERROR so genuinely-dead bindings are still caught.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],

    // Whole-env inlining ban — see DYNAMIC_ENV_READ_BANS at the top of this file.
    'no-restricted-syntax': ['error', ...DYNAMIC_ENV_READ_BANS, ...AXIOS_RUNTIME_LOAD_BANS],

    // ── DIRECT axios VALUE IMPORTS ARE BANNED src-wide ─────────────
    //
    // Every request must go through the unified client in `src/api` so it carries the
    // shared interceptor (auth header, project scope, error normalisation). A module
    // that imports axios itself bypasses all of it.
    //
    // TYPE imports are explicitly fine and are the house idiom — 30+ modules do
    // `import type { AxiosRequestConfig } from 'axios'`, which erases at compile time
    // and ships nothing. `allowTypeImports: true` is the maintained implementation of
    // that exclusion.
    //
    // WHY THE LINT RULE AND NOT A HAND-WRITTEN MATCHER (the point of this change).
    // This ban previously lived in `src/testSupport/axiosValueImport.ts`: a regex
    // approximating the TypeScript import grammar, fed the TEXT of a hand-listed set of
    // page modules by three `*.wiring.test.ts` files. It was "completed" three times and
    // still had holes — it false-REDs on the inline type specifier
    // `import { type X } from 'axios'` (the house idiom, 127 uses across this codebase)
    // and missed the bare side-effect form `import 'axios';` entirely — and its
    // POPULATION was whatever those three suites remembered to list, so a new page was
    // invisible to it. Deleted 2026-08-08 in favour of this rule, which is maintained by
    // people whose job is TS grammar, covers every import spelling, and enumerates the
    // WHOLE tree via `npm run lint` rather than a remembered list.
    //
    // POPULATION (stated per CLASSES.md C3): every file `npm run lint` visits —
    // `eslint src --ext .ts,.tsx`, i.e. all of src/, product and test alike.
    //
    // WHAT THIS RULE DOES *NOT* COVER: CommonJS `require('axios')`. ESLint's
    // no-restricted-imports is an ES-module rule; `require` is not an import
    // declaration. That is not a live gap here (this is an ESM Vite app; `require` is
    // not callable in src and there are zero occurrences), and the CHOKE POINT that
    // catches any bypass regardless of spelling is the built bundle plus the runtime
    // behaviour suites — not this rule. Stated rather than silently assumed.
    //
    // THE ONE LEGITIMATE VALUE IMPORT is `src/services/api.ts` (the axios instance
    // itself), exempted in the overrides below. Measured on this tree:
    //   grep -rn "from 'axios'\|from \"axios\"" src/ | grep -v 'import type'
    //   -> exactly one hit, src/services/api.ts:1.
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'axios',
            allowTypeImports: true,
            message:
              "Don't import axios directly — requests must go through the unified client in src/api so they carry the shared interceptor (auth, project scope, error normalisation). `import type { … } from 'axios'` is fine. The single axios instance lives in src/services/api.ts.",
          },
        ],
      },
    ],
  },

  overrides: [
    {
      // ── THE ONE AXIOS VALUE IMPORT ────────────────────────────────
      // `src/services/api.ts` IS the axios instance every other module consumes through
      // src/api; it must import the library. This is the only exemption, and it was
      // measured, not assumed — see the rule's comment above for the command. Kept as a
      // narrow `files` override rather than an inline eslint-disable so that a SECOND
      // module trying to become "the client" is a RED instead of a copied directive.
      files: ['src/services/api.ts'],
      rules: {
        '@typescript-eslint/no-restricted-imports': 'off',
      },
    },
    {
      // ── `instanceof Error` IS BANNED IN THE UI LAYER ──────────────
      //
      // WHY A LINT RULE AND NOT A CONVENTION. This codebase accumulated FORTY-EIGHT
      // call sites all written as `err instanceof Error ? err.message : '<generic>'`,
      // and every one of them was WRONG for its whole life: the shared axios
      // interceptor rejects with a plain object literal (`{message, code, status,
      // details}`), which is not an `Error`, so the check was always false and the
      // server's message was never once shown to a user. Forty-eight sites converged
      // on a broken idiom precisely because NOTHING OBJECTED. Fixing the 48 without
      // adding an objector just resets the counter — site #49 is written the same way
      // by the next person, and it is invisible again.
      //
      // The rule is the whole-class fix; the sweep was only the cleanup.
      //
      // WHY THIS SELECTOR IS THE CHOKE POINT. It matches the `instanceof Error` test
      // itself, in the AST — not a text pattern, not the shapes anyone anticipated. A
      // ternary, an `if`, a `&&`, a helper, a new file: every form must pass through
      // this node, so a new instance cannot be phrased around the rule (a past incident —
      // anchor on the token every instance must pass through, never on the shapes you
      // had in mind).
      //
      // SCOPED to the layers that RENDER (`src/pages`, `src/components`). The three
      // legitimate uses live outside it and are legitimate BECAUSE of where they are:
      // `hooks/useQueryErrorHandler.ts` wraps a rejection INTO an Error for Sentry,
      // `hooks/useErrorHandler.ts` reads `.name`, `api/mandrelApiClient.ts` NORMALISES
      // an error into `{message}`. Those are producers and adapters; this ban is about
      // consumers deciding what a human reads. Widening it to `src/**` would force
      // three exemptions that carry no information, and a rule mostly made of
      // exemptions is one nobody reads.
      //
      // EXEMPTIONS ARE CO-LOCATED, deliberately: an `eslint-disable-next-line` sits ON
      // the line it excuses, so forgetting one is a visible RED at that line rather
      // than a silent hole in a central allow-list that drifts.
      //
      // An exemption that has stopped suppressing anything is a hole that READS like a
      // guard, so staleness is checked too — but NOT by adding
      // `--report-unused-disable-directives` to the `lint` script, which was tried and
      // reverted: it reports repo-wide, and this tree carries 99 pre-existing stale
      // directives for OTHER rules — 74 in the regenerated `src/api/generated/`, where a
      // hand-fix does not survive the next `npm run generate:openapi`, so the stage would
      // go RED again on every regeneration; 21 in the directories this rule covers; 4
      // elsewhere. A gate that goes RED for a reason its owner cannot durably fix is a
      // gate that gets switched off. Instead `src/api/instanceofErrorBan.guard.test.ts`
      // runs ESLint programmatically, scoped to THIS rule, and fails on a stale
      // exemption for it. That same test also proves this override still FIRES, so
      // narrowing `files` or renaming the selector is a RED rather than a silent
      // defang (measured: it is).
      files: [
        'src/pages/**/*.{ts,tsx}',
        'src/components/**/*.{ts,tsx}',
        // `src/contexts` too: a provider is one of the most plausible homes for a future
        // global error banner, i.e. a RENDERER outside pages/components. It carries ZERO
        // `instanceof Error` today, so covering it costs zero exemptions — the
        // "don't drown the rule in uninformative exemptions" argument that keeps hooks/
        // and api/ out simply does not apply here.
        'src/contexts/**/*.{ts,tsx}',
      ],
      rules: {
        // NOTE: this array REPLACES the top-level `no-restricted-syntax` for these
        // files, so the env-read bans must be re-injected here or pages/components/
        // contexts would silently lose them (single source: DYNAMIC_ENV_READ_BANS).
        'no-restricted-syntax': [
          'error',
          ...DYNAMIC_ENV_READ_BANS,
          ...AXIOS_RUNTIME_LOAD_BANS,
          {
            selector: 'BinaryExpression[operator="instanceof"][right.name="Error"]',
            message:
              "`instanceof Error` is false for every API failure — the shared axios interceptor rejects with a PLAIN OBJECT, not an Error. Use apiErrorMessage(err, 'fallback') from src/api/request. If you genuinely need the class (wrapping for Sentry, reading .name), add an eslint-disable-next-line ON THIS LINE saying why.",
          },
        ],
      },
    },
  ],
};
