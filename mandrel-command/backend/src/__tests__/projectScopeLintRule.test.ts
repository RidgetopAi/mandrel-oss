/**
 * projectScopeLintRule — the executable coverage claim for the project-scope guard
 * (replaces projectScopeRawReadGate.test.ts, Reviewer round 3).
 *
 * =============================================================================
 * WHY THE TEXT SCAN IS GONE
 * =============================================================================
 * The guard used to be TWO layers — an eslint AST rule and a hand-written text scan — with
 * a prose "division of labour" describing which shapes each one covered. The product was
 * correct every round. THE TREATY was the highest-defect component in the whole task:
 *
 *   R2: the non-coverage list was false in BOTH directions.
 *   R3: fixed, and still false — `req.query?.['project_id']` (the bracketed regex allowed
 *       `\??\s*\[`, but an optional chain is `?.[` and the `.` had no path through it),
 *       and `const { project } = req.headers`, which is the exact live door this branch
 *       deleted in its destructured spelling. The round that taught the destructure SHAPE
 *       and the round that taught the header NAMES never crossed. The miss was always the
 *       uncrossed cell.
 *   R3: and the "two hops are honestly uncovered" test asserted `toBeGreaterThan(0)` —
 *       the opposite of its own name.
 *
 * Redundant guards add safety only when they fail INDEPENDENTLY and disagreement between
 * them is OBSERVABLE. Two detectors assigned complementary territories by a hand-written
 * document can never disagree, so the redundancy was theatre and the document was pure
 * liability: a division-of-labour doc between two detectors IS a coverage claim, which is
 * the artifact class this task kept failing.
 *
 * So: ONE detector, and the coverage claim is EXECUTABLE. There is no prose non-coverage
 * list any more. The fixtures below are the claim. A hole is an inverted fixture asserting
 * zero diagnostics with the reason in its name, so closing a hole forces its claim to
 * change in the same commit.
 *
 * =============================================================================
 * IT RUNS THE REAL .eslintrc.js — NOT A COPY
 * =============================================================================
 * `require('../../.eslintrc.js')` loads the shipping config file by path and pulls
 * `rules['no-restricted-syntax']` out of it. If someone edits that rule, this suite sees
 * the edit; a copied selector list would drift the moment it was copied, which is the
 * failure this whole file exists to end.
 */
import * as path from 'path';

/**
 * `require` rather than `import` for eslint and the parser: this repo ships no
 * `@types/eslint`, and the parser's own types do not resolve under this tsconfig's
 * `moduleResolution`. Adding a dependency to make a TEST compile would change the
 * lockfile and the CI install for everyone, which is a bigger footprint than the local
 * shapes below. The shapes are explicit — nothing here is implicitly `any`.
 */
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

/**
 * THE REAL FILE, by path. Not a copy, not a re-declaration of the selectors. If someone
 * edits the shipping rule, this suite sees the edit; a copy would drift the moment it was
 * made, which is the exact failure this file replaces.
 */
// A LITERAL specifier, deliberately: __tests__/dbTestGateCoverage.test.ts forbids
// `require()` with a computed specifier in test files, because an unresolvable one can
// hide a DB import from its scan. That guard is right and this file complies rather than
// exempting itself — a literal still resolves to the one real config on disk.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realEslintrc = require('../../.eslintrc.js') as { rules: Record<string, unknown> };
/** Where that literal actually resolved to — used only to assert it is the shipping file. */
const REAL_ESLINTRC_PATH = require.resolve('../../.eslintrc.js');

const REAL_RULE = realEslintrc.rules['no-restricted-syntax'];

const linter: LinterLike = new Linter();
linter.defineParser('@typescript-eslint/parser', tsParser);

const LINT_CONFIG = {
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: { 'no-restricted-syntax': REAL_RULE },
};

/** Diagnostics from the REAL rule for a snippet. */
function diagnose(code: string): number {
  return linter
    .verify(code, LINT_CONFIG)
    .filter((m: LintMessage) => m.ruleId === 'no-restricted-syntax').length;
}

// =============================================================================
// THE GRID — generated as a literal cross product, never hand-listed
// =============================================================================
// Every previous round patched one ROW or one COLUMN from memory, and the miss was always
// the cell where two fixes failed to cross. A generated grid has no memory: adding a
// source, a shape or a spelling multiplies out automatically and any uncovered cell is a
// failing test rather than an omission nobody thought of.

/** Where a project reference can arrive on an Express request. */
const SOURCES = ['query', 'body', 'headers', 'params'] as const;

/** How it can be written. */
const SHAPES = [
  'dotted',
  'bracketed',
  'optional-dotted',
  'optional-bracketed',
  'destructure-single-line',
  'destructure-multi-line',
] as const;

/** What it can be called. */
const SPELLINGS = ['project', 'project_id', 'projectId', 'x-project-id'] as const;

/**
 * HOW IT IS CASED — the axis this grid did not have, and the miss that proved the grid's
 * own thesis against it.
 *
 * The rule's regexes used to spell case-insensitivity by hand (`[xX]-[pP]roject-[iI][dD]`)
 * — 4 of 12 letters. Express's `req.get()` IS case-insensitive at runtime, so every casing
 * is the SAME live door; measured, `req.get('X-PROJECT-ID')` and `req.get('X-PROJECT-Id')`
 * were silent while five sibling casings fired. The regexes now carry `/i`.
 *
 * The commit that introduced this grid argued "every round patched one row or column from
 * memory and the miss was always the uncrossed cell; a generated grid has no memory." That
 * was right, and it was falsified by the grid's own first missing axis — the author knew
 * case mattered (that is why the `[xX]` classes existed) and still did not cross it.
 * So case is an axis now, not a hand-listed pair of spellings.
 */
const CASES = ['as-written', 'upper', 'mixed'] as const;

type Source = (typeof SOURCES)[number];
type Shape = (typeof SHAPES)[number];
type Spelling = (typeof SPELLINGS)[number];
type Casing = (typeof CASES)[number];

/**
 * Case variants apply to the WIRE NAME only. A JS identifier is case-SENSITIVE, so
 * `req.query.PROJECT_ID` is a different property and not the same door — recasing an
 * identifier spelling would assert a falsehood. Only quoted/hyphenated names (the header
 * spellings) are recased, which is exactly where the runtime is case-insensitive.
 */
const recase = (spelling: Spelling, casing: Casing): string => {
  if (casing === 'as-written' || isIdentifier(spelling)) return spelling;
  return casing === 'upper'
    ? spelling.toUpperCase()
    : spelling.replace(/(^|-)([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
};

/** A hyphenated name is not a valid identifier, so those cells must use a quoted key. */
const isIdentifier = (s: Spelling): boolean => /^[A-Za-z_$][\w$]*$/.test(s);

function render(source: Source, shape: Shape, spelling: Spelling, casing: Casing = 'as-written'): string {
  const name = recase(spelling, casing);
  const q = `'${name}'`;
  switch (shape) {
    case 'dotted':
      return `const v = req.${source}.${name};`;
    case 'bracketed':
      return `const v = req.${source}[${q}];`;
    case 'optional-dotted':
      return `const v = req.${source}?.${name};`;
    case 'optional-bracketed':
      return `const v = req.${source}?.[${q}];`;
    case 'destructure-single-line':
      return isIdentifier(spelling)
        ? `const { ${name} } = req.${source};`
        : `const { ${q}: v } = req.${source};`;
    case 'destructure-multi-line':
      return isIdentifier(spelling)
        ? `const {\n  other,\n  ${name},\n} = req.${source};`
        : `const {\n  other,\n  ${q}: v,\n} = req.${source};`;
  }
}

export interface Cell {
  source: Source;
  shape: Shape;
  spelling: Spelling;
  casing: Casing;
  code: string;
  id: string;
}

/** DERIVED (part 1): the population is the cross product itself. */
const GRID: Cell[] = SOURCES.flatMap((source) =>
  SHAPES.flatMap((shape) =>
    SPELLINGS.flatMap((spelling) =>
      CASES.map((casing) => ({
        source,
        shape,
        spelling,
        casing,
        code: render(source, shape, spelling, casing),
        id: `${source} / ${shape} / ${spelling} / ${casing}`,
      }))
    )
  )
);

/**
 * Recasing an IDENTIFIER spelling produces the identical string (see `recase`), so those
 * cells are exact duplicates of their `as-written` sibling rather than new coverage.
 * Counting them would inflate the population and make the non-empty trap weaker, so they
 * are dropped — and the drop is asserted below rather than assumed.
 */
const DUPLICATE_CASE = (c: Cell): boolean => c.casing !== 'as-written' && isIdentifier(c.spelling);

/**
 * The cells that are DELIBERATE HOLES — a dotted or optional-dotted read of a hyphenated
 * name is not expressible in JavaScript at all (`req.headers.x-project-id` parses as a
 * subtraction), so those cells are unreachable rather than uncovered.
 */
const UNREACHABLE = (c: Cell): boolean =>
  !isIdentifier(c.spelling) && (c.shape === 'dotted' || c.shape === 'optional-dotted');

const REACHABLE = GRID.filter((c) => !UNREACHABLE(c) && !DUPLICATE_CASE(c));

describe('project-scope lint rule — the generated grid IS the coverage claim', () => {
  it('the population is derived, snapshotted by hand, and non-empty', () => {
    // Part 2 — the HAND-WRITTEN snapshot. Looks redundant; it is the only thing that
    // catches a WRONG derivation (a mis-typed loop that silently produces 0 or the wrong
    // axis). Update it deliberately when an axis changes.
    expect(SOURCES).toEqual(['query', 'body', 'headers', 'params']);
    expect(SHAPES).toEqual([
      'dotted',
      'bracketed',
      'optional-dotted',
      'optional-bracketed',
      'destructure-single-line',
      'destructure-multi-line',
    ]);
    expect(SPELLINGS).toEqual(['project', 'project_id', 'projectId', 'x-project-id']);
    expect(CASES).toEqual(['as-written', 'upper', 'mixed']);

    // Part 3 — the NON-EMPTY TRAP. An empty grid would make every `it.each` below vacuous
    // and the suite would report a confident green having asserted nothing.
    expect(GRID).toHaveLength(SOURCES.length * SHAPES.length * SPELLINGS.length * CASES.length);
    expect(GRID.length).toBe(288);
    // The case axis must contribute DISTINCT CODE, not merely distinct cells.
    //
    // The first version of this trap asserted `REACHABLE.filter(c => c.casing !==
    // 'as-written').length > 0` — cells EXIST. Measured: neutering `recase` to a no-op
    // left the suite at 194/194, because the cells still existed and simply carried
    // identical code. Existence is not the property that matters; DISTINCTNESS is. That
    // is the same defect this whole grid was built to stop, inside the trap written to
    // stop it, so it is worth the four lines.
    const casedCode = new Set(
      REACHABLE.filter((c) => c.casing !== 'as-written').map((c) => c.code)
    );
    const baseCode = new Set(
      REACHABLE.filter((c) => c.casing === 'as-written').map((c) => c.code)
    );
    expect(casedCode.size).toBeGreaterThan(0);
    // Every cased cell must render code no `as-written` cell produces.
    expect([...casedCode].filter((code) => baseCode.has(code))).toEqual([]);
    expect(REACHABLE.length).toBe(120);
    expect(REACHABLE.length).toBeGreaterThan(80);
  });

  it('the rule under test is the REAL one, loaded from the shipping .eslintrc.js', () => {
    // If this ever loads a copy, the whole design fails silently — the fixtures would
    // certify a config nobody runs.
    expect(REAL_ESLINTRC_PATH.endsWith('/backend/.eslintrc.js')).toBe(true);
    expect(Array.isArray(REAL_RULE)).toBe(true);
    expect((REAL_RULE as unknown[])[0]).toBe('error');
    // …and it is not inert: a known-bad snippet must produce a diagnostic through the
    // exact wiring the fixtures use.
    expect(diagnose('const v = req.query.project_id;')).toBeGreaterThan(0);
    // …and not everything-is-bad, or the greens below would be meaningless.
    expect(diagnose('const v = req.query.limit;')).toBe(0);
  });

  it.each(REACHABLE.map((c) => [c.id, c] as const))(
    'CELL %s — the real rule reports it',
    (_id, cell) => {
      expect({ cell: cell.id, code: cell.code, diagnostics: diagnose(cell.code) > 0 }).toEqual({
        cell: cell.id,
        code: cell.code,
        diagnostics: true,
      });
    }
  );

  it.each(GRID.filter(UNREACHABLE).map((c) => [c.id, c] as const))(
    'CELL %s — unreachable: a hyphenated name cannot be a dotted property in JS',
    (_id, cell) => {
      // Asserted rather than skipped, so "unreachable" stays a fact about the language and
      // not a quiet exemption. `req.headers.x-project-id` is a subtraction expression.
      expect(isIdentifier(cell.spelling)).toBe(false);
    }
  );
});

describe('the `req.get()` / `req.header()` accessor axis', () => {
  const ACCESSORS = ['get', 'header'] as const;
  const ACCESSOR_CELLS = ACCESSORS.flatMap((fn) =>
    SPELLINGS.map((spelling) => ({
      id: `req.${fn}('${spelling}')`,
      code: `const v = req.${fn}('${spelling}');`,
    }))
  );

  it('the accessor population is non-empty and matches its hand-written size', () => {
    expect(ACCESSOR_CELLS).toHaveLength(ACCESSORS.length * SPELLINGS.length);
    expect(ACCESSOR_CELLS).toHaveLength(8);
  });

  it.each(ACCESSOR_CELLS.map((c) => [c.id, c] as const))(
    'CELL %s — the real rule reports it',
    (_id, cell) => {
      expect({ code: cell.code, reported: diagnose(cell.code) > 0 }).toEqual({
        code: cell.code,
        reported: true,
      });
    }
  );
});

describe('OPTIONAL CHAINING — a fixture, not a belief', () => {
  // This was shipped as a REASONED claim ("in ESTree a ChainExpression wraps a
  // MemberExpression with optional:true, and esquery matches the inner node, so it should
  // already fire"). It happens to be true. It was still exactly the kind of unverified
  // sentence this task keeps failing on, so it is now measured for every source.
  it.each(SOURCES.map((s) => [s] as const))('req.%s?.project_id fires', (source) => {
    expect(diagnose(`const v = req.${source}?.project_id;`)).toBeGreaterThan(0);
  });

  it.each(SOURCES.map((s) => [s] as const))("req.%s?.['project_id'] fires", (source) => {
    expect(diagnose(`const v = req.${source}?.['project_id'];`)).toBeGreaterThan(0);
  });

  it('a long optional chain still fires (req?.query?.[…])', () => {
    expect(diagnose("const v = req?.query?.['projectId'];")).toBeGreaterThan(0);
  });
});

describe('the verbatim pre-fix door shapes — ported from the deleted text scan', () => {
  // These are the real lines that existed in this repo before the fix. They are the
  // regression population: if any stops being reported, a door that was actually open once
  // has become invisible again.
  const HISTORICAL_DOORS: ReadonlyArray<readonly [string, string]> = [
    ['controllers/task.ts', 'const projectId = req.projectId || (req.query.project_id as string);'],
    ['services/requestProjectScope.ts', 'const projectId = req.projectId ?? req.body?.projectId;'],
    ['middleware/sseAuth.ts', 'const projectId = req.query.projectId as string | undefined;'],
    [
      'routes/resolve.ts',
      "const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;",
    ],
    [
      'routes/embedding.ts (DOOR 1, the live one)',
      "const legacyHeader = typeof req.headers.project === 'string' ? req.headers.project.trim() : undefined;",
    ],
    ['controllers/session.ts (×8)', 'const { project_id, actor } = req.query;'],
    ['controllers/task.ts:632', 'const { ids, project_id } = req.body;'],
    ['the R3 miss', "const v = req.query?.['project_id'];"],
    ['the R3 miss (headers destructure)', 'const { project } = req.headers;'],
  ];

  it.each(HISTORICAL_DOORS.map(([where, code]) => [where, code] as const))(
    'still reported — %s',
    (_where, code) => {
      expect({ code, reported: diagnose(code) > 0 }).toEqual({ code, reported: true });
    }
  );
});

describe('LEGITIMACY SET — the rule must not redden correct code', () => {
  // C3's corollary: a guard that flags correct work gets deleted the first time it is
  // inconvenient, which is worse than the hole it closed. Every entry here fired once
  // during development and was paid for with a narrowing.
  const MUST_NOT_FIRE: ReadonlyArray<readonly [string, string]> = [
    ['the authorized attachment itself', 'const projectId = req.projectId;'],
    ['routes/mcp.ts binding', "return { kind: 'bind', projectId: req.projectId };"],
    ['a git-commit DTO, not a request', 'const queryParams = [request.project_id];'],
    ['a service DTO named request', 'const { project_id, repo_path } = request;'],
    ['a ContextSearchParams DTO', 'const { project_id, session_id } = params;'],
    ['the supported accessor', 'const projectId = getRequestProjectId(req);'],
    ['the resolver documenting its own sources', "const k = { key: 'query.project_id' };"],
    ['a RESPONSE body in a test assertion', 'expect(res.body.projectId).toBe(x);'],
    ['an unrelated query param', 'const limit = req.query.limit;'],
    ['an unrelated header', 'const auth = req.headers.authorization;'],
    ['a domain object', 'const { project } = someDomainObject;'],
    ['the resolver\'s own dynamic read', 'return req.headers?.[spec.name];'],
  ];

  it.each(MUST_NOT_FIRE.map(([why, code]) => [why, code] as const))(
    'silent — %s',
    (_why, code) => {
      expect({ code, reported: diagnose(code) }).toEqual({ code, reported: 0 });
    }
  );
});

// =============================================================================
// THE HOLES — inverted fixtures. These ARE the non-coverage statement.
// =============================================================================
// There is no prose list any more. Each hole asserts ZERO diagnostics, so closing one
// makes this suite fail and forces the claim to be updated in the same commit. That is the
// property the prose version never had: it could go stale silently, and did, three rounds
// running.
describe('KNOWN HOLES — asserted as holes, so closing one updates the claim', () => {
  it('HOLE: a read through an ALIAS is not detected (one hop or many)', () => {
    // NOT banned on purpose. Banning alias CREATION is a one-line AST selector and the
    // wrong move: there are ~10 legitimate bare `= req.body` / `= req.query` bindings in
    // src (typeSafety ×2, validation, monitoring, task ×2, context, session, project ×2,
    // plus the resolver's own two). Ten forced disables on idiomatic code is the guard
    // that gets deleted the first time it is inconvenient.
    //
    // If alias re-entry is ever OBSERVED, the right instrument is a small custom rule
    // using eslint's scope-analysis API — a real dataflow hop, not a regex imitation of
    // one, which is what the deleted text layer was.
    expect(diagnose('const q = req.query;\nconst v = q.project_id;')).toBe(0);
    expect(diagnose('const b = req.body;\nconst v = b.projectId;')).toBe(0);
    expect(diagnose('const q = req.query;\nconst { project_id } = q;')).toBe(0);
    expect(diagnose('const a = req;\nconst q = a.query;\nconst v = q.project_id;')).toBe(0);
  });

  it('HOLE: a truly DYNAMIC key cannot be resolved by any lexical or AST rule', () => {
    // The resolver's own readRawSource is written this way on purpose and is the one place
    // it is correct.
    expect(diagnose('const v = req.query[someVar];')).toBe(0);
    expect(diagnose('const v = req.headers[buildName()];')).toBe(0);
    expect(diagnose("const v = req.query['project' + '_id'];")).toBe(0);
  });

  it('HOLE: a project reference NOT NAMED after a project is invisible to any name rule', () => {
    // THE `?id=` PARAM ON /api/embedding/* WAS EXACTLY THIS (Reviewer D1, DOOR 2): a
    // dataset id IS a project id. No name-matching rule will ever find it — only reading
    // the CONSUMER does. embeddingProjectScope.test.ts is the compensating control, and it
    // is behavioural for precisely this reason.
    expect(diagnose('const v = req.query.id;')).toBe(0);
    expect(diagnose('const v = req.query.dataset;')).toBe(0);
  });

  it('HOLE: NESTED references are not covered here', () => {
    // `body.arguments.projectId` on the /api/mcp passthrough is authorized separately at
    // routes/mcp.ts against the same ProjectAccessService. A selector wide enough to catch
    // nested objects would fire on most of the codebase.
    expect(diagnose('const v = req.body.arguments.projectId;')).toBe(0);
  });

  it('HOLE: a request bound to a name other than req/request is not covered', () => {
    // The `req|request` base qualifier is what stops the rule firing on `res.body` in test
    // assertions. The trade is stated here rather than in prose.
    expect(diagnose('const v = httpRequest.body.projectId;')).toBe(0);
  });

  it('HOLE: nothing outside this package is covered', () => {
    // The frontend, the mcp-server, SQL and migrations are all out of scope for a backend
    // lint config. Asserted by construction: this suite only ever lints snippets.
    expect(REAL_ESLINTRC_PATH).toContain('/backend/');
  });
});

// =============================================================================
// THE ESCAPE HATCH — ported from the deleted text scan's marker inventory
// =============================================================================
// The deleted file's one test with real teeth. Without it the disables multiply at exactly
// the rate the raw reads used to, and the guard becomes decorative. Reasons stay
// CO-LOCATED with each disable; only the inventory lives here.
describe('escape hatch — disables cannot multiply silently', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  const SRC_ROOT = path.resolve(__dirname, '..');
  // ALL THREE ESLINT SUPPRESSION SPELLINGS, not just the one this inventory was born
  // matching. eslint honours `eslint-disable-next-line`, trailing `eslint-disable-line`,
  // and block/file-level `eslint-disable`. Measured on the previous single-string version:
  // two REAL unauthorized doors — a file-level `/* eslint-disable no-restricted-syntax */`
  // in controllers/decision.ts and a trailing `// eslint-disable-line` in
  // controllers/treewalker.ts — were suppressed by eslint AND invisible to this inventory,
  // so the suite stayed 146/146 with both live. The population was "lines containing
  // -next-line", not "suppressions of the rule". That gap was also a COVERAGE REGRESSION
  // against the text scan this replaced, whose marker was independent of eslint's own
  // opt-out machinery — the one dimension nobody enumerated when porting it.
  const DISABLE_RE =
    /eslint-disable(?:-next-line|-line)?[^\n]*\bno-restricted-syntax\b/;
  const hasDisable = (src: string): boolean => DISABLE_RE.test(src);

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(full, out);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  /**
   * THIS FILE IS EXCLUDED FROM ITS OWN SCAN. It necessarily contains the literal
   * `eslint-disable-next-line no-restricted-syntax` — that is the string being searched
   * for — so including it makes the instrument part of its own sample and it reports a
   * disable that does not exist (C1: `pgrep -f X` matching the shell that ran it).
   */
  const SELF = path.resolve(__dirname, 'projectScopeLintRule.test.ts');
  const files = walk(SRC_ROOT).filter((f) => f !== SELF);

  it('the inventory scan has a non-empty population', () => {
    // Same trap as the grid: a walker that returns [] would make the assertion below pass
    // by measuring nothing.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(SRC_ROOT, 'routes', 'embedding.ts'));
  });

  it('every file carrying a disable is on the list, with its reason next to the code', () => {
    const marked = files
      .filter((f) => hasDisable(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC_ROOT, f))
      .sort();

    //   controllers/git.ts        payload SUBJECT (the project the stats belong to)
    //   controllers/task.ts       creation TARGET + bulk-move DESTINATION
    //   routes/users.ts           the grant/revoke OBJECT, on requireAdmin routes
    //   __tests__/projectScope*   the guard suite echoing what it just authorized
    //
    // __tests__/embeddingColumn.contract.test.ts is here for a DIFFERENT rule sharing the
    // same rule id: the test-file override adds embedder-dimension selectors,
    // and that file's whole job is to PIN the two dimensions, so the literal is
    // the assertion. It carries no project-scope disable. This inventory is keyed on the
    // rule id, not on the reason, so a second guard living under no-restricted-syntax
    // lands here by construction.
    //
    // controllers/context.ts, controllers/session.ts and routes/typeSafety.ts are NOT
    // here on purpose: their raw reads go through an ALIAS (`const updates = req.body`),
    // which is an ASSERTED HOLE above, so the rule does not fire and no disable is needed.
    // Their explanatory comments remain in place; what was removed is the dead
    // `project-scope-raw-read:` token, a directive of the deleted text scan that nothing
    // reads any more.
    //
    // Every one is authorized BEFORE the read: because the resolver
    // authorizes EVERY candidate and body.project_id/projectId are PROJECT_SCOPE_SOURCES. Growing this list is a review decision.
    expect(marked).toEqual([
      '__tests__/embeddingColumn.contract.test.ts',
      'controllers/git.ts',
      'controllers/task.ts',
      'routes/users.ts',
    ]);
  });

  it('every disable carries a written reason on the same line', () => {
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!DISABLE_RE.test(line)) return;
          // A bare disable with no `--` justification is the shape that rots: it survives
          // review because nobody can tell whether it was ever thought about.
          if (!/--\s*\S/.test(line)) offenders.push(`${path.relative(SRC_ROOT, f)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
