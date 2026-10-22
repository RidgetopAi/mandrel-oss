/**
 * PROJECT-SCOPE SELECTORS — see the long comment at the use site below.
 * Named so the TEST-FILE OVERRIDE can re-state them verbatim. An eslint `overrides` entry
 * REPLACES a rule's options rather than merging them, so a bare
 * `'no-restricted-syntax': ['error', ...embedDim]` in the override would have silently
 * switched the project-scope guard OFF for every file under src/__tests__/. Composing the
 * two arrays is what keeps that from happening, and
 * embedGeometryLintRule.test.ts asserts the override is a SUPERSET of the base.
 */
const PROJECT_SCOPE_SELECTORS = [
  {
    selector: 'MemberExpression[object.property.name="query"][property.name=/^(project_id|project|projectId)$/i]',
    message: 'Project scope must come from getRequestProjectId(req) — a raw req.query read is an UNAUTHORIZED door.',
  },
  {
    selector: 'MemberExpression[object.property.name="query"][property.value=/^(x-project-id|project_id|project|projectId)$/i]',
    message: 'Project scope must come from getRequestProjectId(req) — a computed req.query["project_id"] read is an UNAUTHORIZED door.',
  },
  {
    selector: 'MemberExpression[object.object.name=/^(req|request)$/i][object.property.name="body"][property.name=/^(project_id|projectId|project)$/i]',
    message: 'Project scope must come from getRequestProjectId(req) — a raw req.body read is an UNAUTHORIZED door.',
  },
  {
    selector: 'MemberExpression[object.object.name=/^(req|request)$/i][object.property.name="body"][property.value=/^(x-project-id|project_id|projectId|project)$/i]',
    message: 'Project scope must come from getRequestProjectId(req) — a computed req.body["projectId"] read is an UNAUTHORIZED door.',
  },
  {
    // DESTRUCTURING, identifier key: `const { project_id } = req.query`.
    // `headers` and `params` are in the source set for measured reasons:
    //   headers — `const { project } = req.headers` escaped BOTH layers. That is
    //     `headers.project`, the exact live door this branch deleted, in its
    //     destructured spelling: the round that taught the destructure SHAPE and the
    //     round that taught the header NAMES never crossed. This is that cell.
    //   params  — a `:projectId` path param is a real door (it needed
    //     authorizeProjectPathParam), and the deleted text layer covered this shape.
    //     Keeping it here is what makes the deletion lose no coverage.
    selector: 'ObjectPattern:has(Property[key.name=/^(x-project-id|project_id|projectId|project)$/i])[parent.init.object.name=/^(req|request)$/i][parent.init.property.name=/^(query|body|headers|params)$/i]',
    message: 'Project scope must come from getRequestProjectId(req) — DESTRUCTURING it out of req.query/body/headers/params is the same unauthorized door.',
  },
  {
    // DESTRUCTURING, STRING-LITERAL key: `const { 'x-project-id': p } = req.headers`.
    // A hyphenated header name cannot be an identifier, so `key.name` does not exist
    // on that Property and the selector above cannot see it.
    selector: 'ObjectPattern:has(Property[key.value=/^(x-project-id|project_id|projectId|project)$/i])[parent.init.object.name=/^(req|request)$/i][parent.init.property.name=/^(query|body|headers|params)$/i]',
    message: 'Project scope must come from getRequestProjectId(req) — DESTRUCTURING a project key out of req.query/body/headers/params is the same unauthorized door.',
  },
  {
    // `req.params.projectId` — the path-param door in its dotted/computed spelling.
    selector: 'MemberExpression[object.object.name=/^(req|request)$/i][object.property.name="params"][property.name=/^(project_id|projectId|project)$/i]',
    message: 'A project PATH PARAM must be authorized (routes/projects.ts uses router.param + authorizeProjectPathParam).',
  },
  {
    selector: 'MemberExpression[object.object.name=/^(req|request)$/i][object.property.name="params"][property.value=/^(x-project-id|project_id|projectId|project)$/i]',
    message: 'A project PATH PARAM must be authorized (routes/projects.ts uses router.param + authorizeProjectPathParam).',
  },
  {
    // THE OTHER SHAPE THE REGEX MISSED: the idiomatic Express header read.
    selector: 'CallExpression[callee.property.name=/^(get|header)$/i][arguments.0.value=/^(x-project-id|project|project_id|projectId)$/i]',
    message: 'Project scope must come from getRequestProjectId(req) — req.get("X-Project-ID")/req.get("project") bypasses the authorized resolution.',
  },
  {
    // THE DOOR THIS RULE WAS WRITTEN FOR: routes/embedding.ts read req.headers.project.
    selector: 'MemberExpression[object.property.name="headers"][property.name=/^(project|project_id|projectId)$/i]',
    message: 'A `project` REQUEST HEADER is an unauthorized project door (Reviewer D1) — use getRequestProjectId(req).',
  },
  {
    selector: 'MemberExpression[object.property.name="headers"][property.value=/^(x-project-id|project|project_id|projectId)$/i]',
    message: 'A raw project header read bypasses the authorized resolution — use getRequestProjectId(req).',
  },
];

/**
 * EMBEDDER-DIMENSION SELECTORS — test files only.
 *
 * A backend test fixture must never write a vector dimension as a number. On 2026-08-19 two
 * fixtures said `Array.from({ length: 1536 })` and were correct only while the active
 * embedder happened to be minilm; flipping the CODE DEFAULT to gemma turned them RED on a
 * merged ref, against a vector(768) column's CHECK. Stage 4 of the CI gate supplies no
 * MANDREL_EMBEDDER, so it runs at whatever the code default is — a hardcoded dimension is
 * therefore invisible in a worktree until the default moves under it.
 *
 * WHAT THIS MATCHES: a numeric literal equal to a known embedder dimension, anywhere in a
 * file under the test override's `files` globs. Comments are not AST nodes, so prose that
 * mentions a number is untouched — which is why this is an AST rule and not a text scan
 * (this repo's own history: a hand-written text scan was the highest-defect artifact of
 * an earlier task and was deleted for it).
 *
 * It says nothing about what an evader cannot do. A wrong length that is not one of these
 * numbers is caught at runtime by vectorLiteral()'s length assertion, and behind that by the
 * postgres CHECK.
 *
 * THE NUMBERS ARE PINNED, NOT TRUSTED: embedGeometryLintRule.test.ts derives the dimension
 * of every key in knownEmbedderKeys() from src/config/embeddingColumn.ts and fails if any
 * of them is missing from this array — so adding a third embedder cannot quietly leave a
 * hole here.
 *
 * TO WRITE ONE LEGITIMATELY: put an eslint-disable ON THE LINE with a written reason
 * (a past incident — co-located exception, never a central allow-list). The registry contract
 * test does exactly that.
 */
const EMBEDDER_DIMENSION_SELECTORS = [1536, 768].map((dim) => ({
  selector: `Literal[value=${dim}]`,
  message:
    `${dim} is a known embedder dimension. A test fixture must not write a vector width by ` +
    'hand — import embedDim/zeroEmbedding/patternEmbedding/vectorLiteral from ' +
    "'./helpers/embedGeometry' so the fixture tracks MANDREL_EMBEDDER instead of being " +
    'correct only by coincidence. Legitimate use: eslint-disable on the ' +
    'line, with the reason.',
}));

module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    // The TYPECHECK config, not the build config. tsconfig.json sets rootDir ./src,
    // so scripts/ and test-setup.ts are not members of that program and typed linting
    // fails on them with a parsing error. tsconfig.typecheck.json is the same options
    // over the wider file set, so lint and STAGE 3 now share one program definition.
    project: './tsconfig.typecheck.json'
  },
  plugins: [
    '@typescript-eslint'
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    // @typescript-eslint/recommended turns OFF core no-redeclare in favour of its
    // own version, which (intentionally) does NOT flag duplicate `interface`
    // declarations because TS merges them. We re-enable the core rule so that
    // accidental duplicate type declarations stay a hard error.
    'no-redeclare': 'error',
    // The following recommended rules flag legitimate, idiomatic patterns in this
    // codebase (test-time require() after jest.mock, `Function` as a generic
    // callback type, Express `declare global { namespace Express }` augmentation).
    // They are real tech-debt signals worth tracking but are NOT bugs and a forced
    // rewrite would risk runtime/behavioural change — so they are warnings (visible,
    // non-blocking), not errors. Revisit as a dedicated cleanup task.
    '@typescript-eslint/no-var-requires': 'warn',
    '@typescript-eslint/ban-types': 'warn',
    '@typescript-eslint/no-namespace': 'warn',

    // ── PROJECT SCOPE MUST COME FROM getRequestProjectId() ──────
    //
    // WHY ESLINT AND NOT A TYPE. The obvious type-level fix — augmenting Express with
    // `query: Omit<qs.ParsedQs, 'project_id' | 'project' | 'projectId'>` — DOES NOT WORK,
    // measured rather than assumed: `ParsedQs` carries a string index signature, so
    // `keyof ParsedQs` is `string | number` and `Exclude<string, 'project_id'>` is still
    // `string`. The literal is never removed and the index signature keeps every key
    // legal. A probe compiled inside this project (proved live by a deliberate error in
    // the same file producing exactly one diagnostic) reported ZERO errors for
    // `q.project_id`, for `const { project_id } = q`, and for assigning the literal to
    // `Exclude<keyof ParsedQs, 'project_id'>`. Removing the index signature instead would
    // make every other `req.query.x` read in the codebase a compile error.
    //
    // WHY THIS IS A GATE, NOT PROSE: eslint is ERROR-GATED in the CI gate STAGE L, so
    // an `error` here fails the build exactly like a type error would.
    //
    // THIS FILE DOES NOT STATE WHAT THE RULE COVERS. That is deliberate and it is the
    // whole design. A written division-of-labour statement was the single
    // highest-defect artifact on this task: it was false in the reviewer round 2, still
    // false in round 3 with a new shape, and in round 4 it survived here in this very
    // file — citing a test that had just been deleted and asserting that alias reads
    // were covered by a layer that no longer existed. Four rounds, one component.
    //
    // THE COVERAGE CLAIM IS EXECUTABLE AND LIVES IN ONE PLACE:
    //     src/__tests__/projectScopeLintRule.test.ts
    // It runs THESE selectors (it `require`s this real file, not a copy) over a
    // GENERATED cross product of sources x shapes x spellings x case, and every
    // genuine hole is an INVERTED fixture asserting zero diagnostics with its reason
    // in the test name. So closing a hole FAILS THE SUITE and forces the claim to
    // change in the same commit. Prose cannot do that; it can only go stale, and here
    // it did, four times.
    //
    // If you want to know what this rule catches: read that file, or add a fixture.
    // Do not describe it here. A sentence in this file cannot be tested and has now
    // been wrong more often than it has been right.
    //
    // TO DO A LEGITIMATE RAW READ: put an eslint-disable ON THE LINE with a written
    // reason (a past incident — co-located exception, never a central allow-list). Every
    // suppression is inventoried by the same test file, in all three eslint spellings.
    //
    // The `object.object.name=/^(req|request)$/` qualifier on the body/destructuring
    // selectors is load-bearing: without it the rule fires on `res.body.projectId` in a
    // test ASSERTION, which is a RESPONSE, not a request door. C3's corollary — a guard
    // that flags correct work gets deleted the first time it is inconvenient.
    'no-restricted-syntax': ['error', ...PROJECT_SCOPE_SELECTORS],
    'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'warn',
    'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'warn'
  },
  overrides: [
    {
      // Test files get the Jest globals (describe/it/expect/jest/beforeEach/...).
      files: ['**/*.test.ts', '**/__tests__/**/*.ts'],
      env: {
        jest: true,
        node: true,
        es2022: true
      },
      rules: {
        // BASE FIRST, then the test-only additions. `overrides` replaces rule options; it
        // does not merge them. Dropping the spread here would turn the project-scope guard
        // off across the whole test tree without a single line of it changing.
        'no-restricted-syntax': ['error', ...PROJECT_SCOPE_SELECTORS, ...EMBEDDER_DIMENSION_SELECTORS]
      }
    }
  ],
  ignorePatterns: [
    'dist/',
    'build/',
    'node_modules/',
    '*.js'
  ]
};
