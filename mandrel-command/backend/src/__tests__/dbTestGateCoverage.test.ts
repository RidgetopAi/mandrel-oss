/**
 * dbTestGateCoverage.test.ts — the guard that makes the OLD gate pattern impossible
 * to re-introduce.
 *
 * WHAT THIS GUARDS
 *   `helpers/dbContractGate.ts` already had the right rule — a DB suite RUNS by
 *   default and FAILS LOUDLY when Postgres is unreachable — and seven
 *   `*.contract.test.ts` suites used it. The fourteen `*.db.test.ts` suites did not:
 *   each kept a private copy of a skip idiom keyed on a flag BOTH CI gates set
 *   job-wide, so 14 suites were dark in the CI gate and in GitHub Actions. Having
 *   the fix and not adopting it was the whole failure, so ADOPTION is enforced here.
 *
 * THIS DETECTOR HAS BEEN DEFEATED FOUR TIMES. Every rewrite is listed, because the
 * defeats are the specification — a guard's history of holes is more informative than
 * its docstring, and the docstring is what lied in each previous round.
 *
 *   ROUND 1 — a flat `readdirSync` (missed subdirectories), a two-string `isDbSuite`
 *     allow-list (aliased imports, double quotes and `new Client(` all walked past),
 *     and a column-0 declaration anchor defeated by INDENTATION
 *     (`if (RUN) { describe(…) }` — the resolveNav disease, re-introducible).
 *   ROUND 2 (this file) — the four fixes above verified closed, and then defeated
 *     again, decisively, by the ONE shape that matters most:
 *
 *         const d = SKIP ? describe.skip : describe;   // ← THE ORIGINAL DEFECT
 *
 *     The previous version judged CALLEE TEXT: `d(…)` is not named `describe`, and the
 *     `describe.skip` in the ternary is a bare property access that is never a
 *     CallExpression, so nothing examined it. That is the literal idiom this task was
 *     opened about, sitting in the file the task is named after, and the detector
 *     built to prevent it could not see it.
 *
 *   ROUND 3 — the binding rule went in, and was defeated three more ways, ALL of which
 *     put a dark DB test inside a file the detector called green:
 *       E1 `SUITE_IDENTS` listed only the describe family. jest registers a TOP-LEVEL
 *          `it` perfectly well, and describeDb injects its reachability check only into
 *          its OWN body — so `(RUN ? it : it.skip)('dark DB test', …)` beside a decoy
 *          gated block ran with no DB assertion at all.
 *       E2 the rule stopped at the FILE boundary: export the alias from a neighbouring
 *          module (`export const reg = RUN ? describe : describe.skip`) and the test
 *          references only `reg`. The sharp part — the import graph ALREADY walked that
 *          module to answer "does it reach pg". It was read for one purpose and not the
 *          other.
 *       E3 only `Identifier` nodes were inspected, so `globalThis['describe']` walked
 *          past — and the header at the time conceded only *string-built* names, making
 *          the documented gap narrower than the real one.
 *
 *   ROUND 4 — the fix for E2 was HALF DONE, and the header described the wrong bound.
 *     `suiteLocalModules` was computed for the test file and NOT RECURSED, so one extra
 *     re-export carried anything: an alias two barrels deep (F1b), or `pg` two barrels
 *     deep (F2), went green. The finding underneath it matters more than the hole: the
 *     header called the bound a DIRECTORY ("outside the test's own directory tree"),
 *     but the missed module was INSIDE that directory — the real bound was a DEPTH of
 *     one, and the words hop/one-level/transitive appeared nowhere in the file. The
 *     stated bound was wider than the real bound for the fourth round running, that
 *     time inside the paragraph written to stop it happening. Also F3: "ambiguity fails
 *     closed" had been true only for the arrangements its own probe used, three
 *     revisions running (D4 → E4 → F3), because each revision COUNTED registrations and
 *     every count needs a rule for which ones to skip — and that rule is where the next
 *     shape hides. Counting is gone; see nodeIsExempt.
 *
 * SO THIS VERSION JUDGES BINDINGS, NOT NAMES, ACROSS THE SET OF FILES A SUITE CAN REACH:
 *
 *     Every REFERENCE to a registrar (`describe`/`it`/`test` and their x/f variants) and
 *     to the gate functions — spelled as an identifier or as a literal element access —
 *     must be a direct callee inside a gate call. That holds in the test file AND in the
 *     suite-local modules it imports.
 *
 *   A ternary, a variable, a re-export, an object property, a function argument — any
 *   route by which the identifier could travel is an offence AT THE REFERENCE, before it
 *   travels. "You cannot alias what you cannot reference" is now true across a set of
 *   files rather than inside one, which is what E2 proved it had to be.
 *
 *   INCLUDING `it`/`test` BUYS MORE THAN THE HOLE IT CLOSED, and the reason is worth
 *   knowing before anyone trims the list back: a dark suite must now alias BOTH
 *   registrars. Alias only the suite and the tests inside it still name `it` — which
 *   must itself sit inside a gate — so the suite is caught through its own contents.
 *   Every layer of indirection an evader adds has to be added twice. Pinned by the
 *   "caught through the `it`s it contains" probe below.
 *
 * THE OTHER AUTHORITIES (unchanged in spirit, tightened in fact)
 *   POPULATION — `jest --listTests` verbatim. jest IS the collection rule, so the
 *     detector holds NO copy of `testMatch`: previously both sides filtered
 *     `.endsWith('.test.ts')` and therefore agreed with each other while both could
 *     disagree with jest (a `.db.test.tsx` suite would have run unseen). The
 *     cross-check walk now uses a DELIBERATELY WIDER predicate than jest's, so it can
 *     only over-report — and an over-report is a loud RED asking a human whether a
 *     test file exists that never runs.
 *   STRUCTURE — the TypeScript parser, now following the local import GRAPH rather
 *     than one file's own specifiers, so a barrel or a helper that opens the
 *     connection on the suite's behalf cannot hide it.
 *
 * WHAT THIS DETECTOR STILL CANNOT SEE. Read this as part of the guarantee, not as a
 * disclaimer: three of the four rounds of defeats landed in territory an earlier version
 * of this comment implied was covered, so the bound is stated here as precisely as the
 * rule itself.
 *
 *   REACHING A DRIVER
 *   - Through a NON-relative dependency: the walk stops at package boundaries and never
 *     enters node_modules.
 *   - Through a relative module OUTSIDE the test's own directory tree — including a pure
 *     re-export barrel one level UP (`src/support/barrel.ts`). Say the bound as BOTH of
 *     its parts, because naming only one is how the last round's hole survived:
 *       PLACE    inside the test's own directory tree, at any depth;
 *       DISTANCE transitive to a fixed point — NOT one hop.
 *     A module inside that tree is followed however deep it goes; a module outside it is
 *     not followed at all, at any depth. The justification for the place bound (a product
 *     module is indistinguishable from the many suites that mock it) genuinely does NOT
 *     describe a pure re-export barrel: that one is simply outside the line, and the line
 *     was drawn where it could be drawn cheaply. It is pinned by an executable test (E5)
 *     rather than left to prose, so widening the walk turns that test RED and forces this
 *     paragraph to be rewritten in the same commit.
 *   - Through a computed module specifier. Aliasing `require` is banned outright to close
 *     the cheap route; a genuinely dynamic specifier remains open.
 *
 *   REGISTERING A SUITE
 *   - Through a registrar reached by a RUNTIME-BUILT name (`globalThis['desc' + 'ribe']`,
 *     a name from a config file). A literal key IS caught (E3); only names that do not
 *     exist until execution are invisible.
 *   - Through an alias living in a module outside the suite-local set — the same PLACE
 *     boundary as above (the distance inside it is unbounded, so depth is not the gap).
 *   - Through jest's own APIs that register without naming a registrar (e.g. a custom
 *     runner or a `testEnvironment` that fabricates suites). Nothing static will see that.
 *
 *   The honest instrument for all of the above is RUNTIME, not a longer static walk: a
 *   jest environment that fails any test which opens an un-gated real connection does not
 *   care how the connection was reached or how the suite was registered. That is filed as
 *   the follow-up; this file is the static half and says so.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type * as TS from 'typescript';

/** Resolve like the tool does — deps are hoisted to the workspace root. */
const BACKEND_DIR = path.resolve(__dirname, '..', '..');
// db-gate-exempt: dynamic by necessity — the hoisted `typescript` must be resolved from
// BACKEND_DIR, and this detector's own rule against non-literal require() is what would
// otherwise flag it. Named here rather than silently special-cased.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts: typeof TS = require(require.resolve('typescript', { paths: [BACKEND_DIR] })); // db-gate-exempt: dynamic by necessity (hoisted dep, resolved from BACKEND_DIR)

const SRC_DIR = path.resolve(__dirname, '..');
const HELPER_ABS = path.join(__dirname, 'helpers', 'dbContractGate.ts');
const SELF_ABS = path.resolve(__filename).replace(/\.js$/, '.ts');

/** A registration opts out only by a marker on ITS OWN node — never a list over here. */
const EXEMPT = 'db-gate-exempt:';

const GATE_CALLS = ['describeDb', 'describeContract'];
/** Every identifier that can register (or silently drop) a whole suite. */
// EVERY identifier jest will register with. `it`/`test` were missing (E1) and that was
// a full defeat: jest registers a TOP-LEVEL `it` perfectly well, and describeDb injects
// its reachability beforeAll only into its OWN body — so
//     (RUN ? it : it.skip)('dark DB test', …)
// sitting beside a trivial gated block ran with no DB assertion at all, in a
// gate-importing, db-named file, with the detector green.
const SUITE_IDENTS = [
  'describe', 'xdescribe', 'fdescribe',
  'it', 'xit', 'fit',
  'test', 'xtest', 'ftest',
];
const HELPER_SPECIFIER = 'helpers/dbContractGate';
const DB_MODULES = (s: string) => s === 'pg' || /(^|\/)database\/connection$/.test(s);

interface Offence {
  file: string;
  line: number;
  token: string;
  text: string;
}

// ---------------------------------------------------------------------------------
// POPULATION
// ---------------------------------------------------------------------------------

/**
 * jest's OWN answer — not a re-implementation of its config. Fails closed: if jest
 * cannot be asked, or answers with nothing, that is a RED. An empty list would make
 * every assertion in this file pass perfectly.
 */
function jestCollectedTests(): string[] {
  const pkg = require.resolve('jest/package.json', { paths: [BACKEND_DIR] });
  const bin = path.join(path.dirname(pkg), 'bin', 'jest.js');
  if (!fs.existsSync(bin)) throw new Error(`cannot locate the jest binary at ${bin}`);
  const out = execFileSync(process.execPath, [bin, '--listTests'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // NO suffix filter: whatever jest says it will run is what gets scanned. The only
  // filter is "is a real file", so a stray log line cannot become a phantom entry.
  const files = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && fs.existsSync(l));
  if (files.length === 0) throw new Error('jest --listTests returned no test files');
  return files.sort();
}

/**
 * A DELIBERATELY WIDER net than jest's `testMatch`. This is not a copy of jest's rule —
 * it is a superset, so it can only ever over-report, and an over-report means "a file
 * that looks like a test exists but jest does not run it", which is exactly the
 * question a human should be asked.
 */
const LOOKS_LIKE_A_TEST = /\.(test|spec)\.[jt]sx?$/;

function walkLooksLikeTests(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkLooksLikeTests(full, acc);
    else if (LOOKS_LIKE_A_TEST.test(entry.name)) acc.push(full);
  }
  return acc.sort();
}

// ---------------------------------------------------------------------------------
// PARSING + THE IMPORT GRAPH
// ---------------------------------------------------------------------------------

interface Parsed {
  sf: TS.SourceFile;
  text: string;
  lines: string[];
  specifiers: string[];
  /** Registration calls, keyed on the line their STATEMENT begins (see nodeIsExempt). */
  registrationsByStatementLine: Map<number, TS.Node[]>;
}

const parseCache = new Map<string, Parsed>();

function parse(file: string): Parsed {
  const cached = parseCache.get(file);
  if (cached) return cached;

  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  const visit = (node: TS.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // A TYPE-ONLY import is erased at compile time — it cannot open a connection.
      // Excluding it is a fact about the language, not a guess about intent.
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const bindings = clause?.namedBindings;
      const everyBindingIsTypeOnly =
        bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
          ? bindings.elements.every((el) => el.isTypeOnly === true)
          : false;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (ts.isExportDeclaration(node) && node.isTypeOnly) ||
        (everyBindingIsTypeOnly && !clause?.name);
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as TS.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // REGISTRATIONS INDEXED BY THE LINE THEIR STATEMENT BEGINS ON.
  //
  // "Ambiguity fails closed" has now been true only for the shapes its own probe used,
  // three revisions running: D4 counted top-level expression statements, E4 counted
  // outermost-on-the-line, and each time a slightly different arrangement — a block, a
  // callback — hid a second registration behind the first and the marker excused both
  // (F3: `[1].forEach(() => { describe('A', …); }); describe('B', …);` counted as one).
  //
  // Counting is the wrong instrument, because every count needs a rule for which
  // registrations to skip, and that rule is where the shapes hide. So: record the
  // registrations themselves, keyed on the line their STATEMENT starts. The exemption
  // test then asks a question with no arithmetic in it — is every registration
  // beginning on the marker's line part of the same nesting chain as the node the
  // marker is attached to? Anything else on that line, however it is nested, means the
  // marker cannot say what it excuses.
  const registrationsByStatementLine = new Map<number, TS.Node[]>();
  const census = (node: TS.Node): void => {
    if (ts.isCallExpression(node) && isRegistrationCall(node)) {
      let stmt: TS.Node = node;
      while (stmt.parent && !ts.isSourceFile(stmt.parent) && !ts.isStatement(stmt)) stmt = stmt.parent;
      const ln = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
      const bucket = registrationsByStatementLine.get(ln) ?? [];
      bucket.push(node);
      registrationsByStatementLine.set(ln, bucket);
    }
    ts.forEachChild(node, census);
  };
  census(sf);

  const parsed = { sf, text, lines: text.split('\n'), specifiers, registrationsByStatementLine };
  parseCache.set(file, parsed);
  return parsed;
}

/** Resolve a RELATIVE specifier to a real file on disk (the forms TS actually uses). */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Does this file reach a database driver — directly, or through SUITE-LOCAL support code?
 *
 * Two sources count:
 *   1. the file's own import specifiers;
 *   2. one hop through a relative module that lives INSIDE the test's own directory
 *      tree — i.e. suite-local support code (`./barrel`, `./support/index`). That is
 *      where a suite hiding its connection behind a helper would put it, and it closes
 *      both barrel/helper shapes without any dir-name allow-list.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, and why (measured, not assumed):
 *   Full transitive closure over ALL relative imports was implemented first and then
 *   rejected on evidence. It marks 37 of 53 backend test files as DB suites, because
 *   almost any product module transitively imports the shared pool. The 13 files it
 *   newly demanded a gate for include healthController, sessionRoutesAuth and
 *   typeSafetyRoutesAuth — whose own header says "the handlers themselves touch no DB /
 *   no network" — every one of them a mocked unit test. Adopting it would have meant
 *   13 exemption markers, and a marker that appears on a quarter of the suite stops
 *   being a decision and becomes noise; the next real one would be waved through.
 *
 *   So the RESIDUAL GAP, stated plainly: a test that imports a PRODUCT module which
 *   itself opens a connection is not treated as a DB suite. It is indistinguishable, at
 *   the import level, from the many suites that import the same module and mock it. If
 *   that gap needs closing, the honest instrument is a runtime one — a jest
 *   environment that fails a test which opens an un-gated real connection — not a
 *   deeper static walk with a longer exemption list.
 */
const reachCache = new Map<string, boolean>();

/**
 * The modules a test can reach through SUITE-LOCAL support code: relative imports that
 * resolve inside the test's OWN DIRECTORY TREE, followed TRANSITIVELY to a fixed point.
 *
 * ONE definition, consumed both by "does this reach a driver" and by the binding rule —
 * so the two can never be walked for different distances. That sharing was the point of
 * the E2 fix and it was only half done: the set was computed for the test file and NOT
 * RECURSED, so one extra barrel carried anything (F1b/F2):
 *
 *     helpers/zzInner.ts   export const reg = RUN ? describe : describe.skip;  // unscanned
 *     helpers/zzOuter.ts   export { reg } from './zzInner';                    // scanned, clean
 *     zzF1.db.test.ts      reg('dark DB suite', () => { … });                  // green
 *
 * DISTANCE, stated: TRANSITIVE (fixed point), bounded by DIRECTORY — never one hop.
 * Both bounds are load-bearing and neither implies the other; describing this as a
 * directory bound alone is what let the depth-1 hole survive a round.
 *
 * Recursing here CANNOT reopen the 37-of-53 exemption-noise problem that led to
 * rejecting full closure: that problem is caused by PRODUCT modules, which this
 * directory rule still excludes at every depth.
 */
function suiteLocalModules(file: string): string[] {
  const ownDir = path.dirname(path.resolve(file)) + path.sep;
  const out: string[] = [];
  const queue: string[] = [file];
  const seen = new Set<string>([path.resolve(file)]);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    let specifiers: string[];
    try {
      specifiers = parse(current).specifiers;
    } catch {
      continue; // unreadable module: reachesDb already fails closed on this
    }
    for (const spec of specifiers) {
      const next = resolveRelative(current, spec);
      if (!next) continue;
      const abs = path.resolve(next);
      // The containment test is against the TEST's directory, fixed — not the current
      // module's — so a deeper module cannot widen the boundary as the walk proceeds.
      if (!abs.startsWith(ownDir) || seen.has(abs)) continue;
      seen.add(abs);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

function reachesDb(file: string): boolean {
  const memo = reachCache.get(file);
  if (memo !== undefined) return memo;

  let result = false;
  try {
    const p = parse(file);
    if (p.specifiers.some(DB_MODULES)) {
      result = true;
    } else {
      for (const next of suiteLocalModules(file)) {
        if (parse(next).specifiers.some(DB_MODULES)) {
          result = true;
          break;
        }
      }
    }
  } catch {
    // An unreadable/unparseable local module must not silently mean "no DB".
    result = true;
  }

  reachCache.set(file, result);
  return result;
}

// ---------------------------------------------------------------------------------
// PER-NODE EXEMPTIONS
// ---------------------------------------------------------------------------------

/**
 * A marker excuses a NODE, not a line. Two registrations on one physical line are two
 * separate decisions, and keying on the line number silently excused both.
 * The marker must be in the comment TRAILING that node's own statement.
 */
function nodeIsExempt(p: Parsed, node: TS.Node): boolean {
  // The marker may sit anywhere from the start of the node's own STATEMENT down to the
  // node itself — that covers a multi-line declaration such as
  //     const d =
  //       COND ? describe : describe.skip; // db-gate-exempt: …
  // but NEVER a line below it, and never a free-floating comment above the statement.
  let stmt: TS.Node = node;
  while (stmt.parent && !ts.isSourceFile(stmt.parent) && !ts.isStatement(stmt)) stmt = stmt.parent;
  const from = lineOf(p, stmt);
  const to = lineOf(p, node);
  for (let line = Math.min(from, to); line <= Math.max(from, to); line++) {
    const text = p.lines[line - 1] ?? '';
    if (!text.includes(EXEMPT)) continue;

  // AMBIGUITY FAILS CLOSED. A marker on a line carrying MORE THAN ONE registration
  // cannot say which one it excuses, so it excuses NEITHER. That is stricter than
  // attributing the comment to whichever statement it happens to trail: it makes the
  // two-registrations-one-line shape (D4) impossible to excuse by accident, and the
  // fix is to put them on separate lines, which is what a reviewer needs to see anyway.
  //
  // Requiring the marker on the node's OWN START line is what closes D5: prose ABOVE a
  // registration ("this comment merely describes the harness") is on a different line
  // and excuses nothing. Prose is not a decision.
    const competing = (p.registrationsByStatementLine.get(line) ?? []).filter(
      (r) => !sameChain(r, node),
    );
    if (competing.length === 0) return true;
  }
  return false;
}

/** Are these two nodes on one ancestor/descendant path (i.e. the same registration)? */
function sameChain(a: TS.Node, b: TS.Node): boolean {
  for (let n: TS.Node | undefined = a; n; n = n.parent) if (n === b) return true;
  for (let n: TS.Node | undefined = b; n; n = n.parent) if (n === a) return true;
  return false;
}

function lineOf(p: Parsed, node: TS.Node): number {
  return p.sf.getLineAndCharacterOfPosition(node.getStart(p.sf)).line + 1;
}

// ---------------------------------------------------------------------------------
// THE SCAN
// ---------------------------------------------------------------------------------

/**
 * A call that REGISTERS something: its callee names a known registrar (describe/it/…
 * or a gate), or it sits in expression-statement position (which is where a wrapper
 * like `describeStreaming(…)` or an aliased `d(…)` does its registering).
 */
function isRegistrationCall(node: TS.CallExpression): boolean {
  const callee = node.expression;
  const base = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  if (referencedName(base) !== null) return true;
  return node.parent !== undefined && ts.isExpressionStatement(node.parent);
}

/**
 * Does this identifier occupy a NAME slot of its parent — i.e. is it a member name or a
 * declaration name rather than a value being read?  (an earlier Task.)
 *
 * WHY THIS EXISTS. `referencedName` used to answer "is this identifier's TEXT a
 * registrar name", and never asked what the identifier was DOING. So the `test` in
 * `PATTERN.test(x)` — a property name that can never resolve to jest's global — was
 * reported as an ungated registrar reference. MEASURED on branch
 * batch3/a17cf00d-owner-scoping-bare-actor: five such calls in ownerScopeSweep.db.test.ts
 * turned the FULL backend suite RED while that suite was 22/22 green.
 *
 * IT WAS NEVER JUST `.test(`. The sweep in "NAME SLOTS ARE NOT REFERENCES" below plants
 * twelve shapes — property access, method call, object-literal key, variable/function/
 * parameter/class-method/interface-member declaration, renamed destructure, qualified
 * type name — and every one of the twelve was a false RED. The whole SUITE_IDENTS set
 * collides in every name slot, not one member in one slot.
 *
 * THE RULE IS STRUCTURAL, NOT A LIST OF SHAPES — deliberately, because a list of shapes
 * is what rounds E1/E2/E3 each defeated. The TypeScript AST uniformly calls the
 * member-or-declaration-name slot `name`, so ONE test covers every declaration form
 * there is, including ones nobody here has thought of. Two carve-outs, because in these
 * the name slot IS the value being read:
 *   - a SHORTHAND object property   `{ describe }`          -> reads the global
 *   - a BindingElement with no propertyName  `const { test } = globalThis`
 *                                                            -> the name IS the key
 * and one addition: a BindingElement's `propertyName` (`const { describe: reg } = …`) is
 * the key being read, so it is a reference even though it sits in a name-ish slot.
 * All three are pinned by the STILL CAUGHT table below.
 *
 * NOT REPLACED BY THE TYPE CHECKER, on purpose: resolving these identifiers to symbols
 * would mean building a full ts.Program over the backend for every scanned file, and it
 * would still have to answer this same syntactic question first. The defect was asking
 * the wrong question, not asking it of the wrong tree.
 */
function isNameSlot(node: TS.Node): boolean {
  const parent = node.parent as (TS.Node & { name?: TS.Node; propertyName?: TS.Node }) | undefined;
  if (!parent) return false;
  // The key of a renamed destructure is READ, not declared.
  if (parent.propertyName === node) return false;
  if (parent.name !== node) {
    // A type-position member (`ns.it`) is a name slot too; its slot is called `right`.
    return ts.isQualifiedName(parent) && parent.right === node;
  }
  // `{ describe }` and `const { test } = …` put the VALUE in the name slot.
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isBindingElement(parent) && !parent.propertyName) return false;
  return true;
}

/**
 * The registrar this node REFERS to, however it is spelled — or null.
 *   `describe`            -> Identifier
 *   `globalThis['describe']` -> ElementAccessExpression with a literal key (E3)
 * A computed key (`globalThis['desc' + 'ribe']`) is genuinely invisible and is named
 * as such in the header; a LITERAL one never was, and that is what this closes.
 * An identifier in a NAME slot is not a reference at all — see isNameSlot.
 */
function referencedName(node: TS.Node): string | null {
  const known = (n: string) => (SUITE_IDENTS.includes(n) || GATE_CALLS.includes(n) ? n : null);
  if (ts.isIdentifier(node)) return isNameSlot(node) ? null : known(node.text);
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return known(node.argumentExpression.text);
  }
  return null;
}

/** Is this node the function actually being called (`f(…)` or `f.x(…)`)? */
function isDirectCallee(id: TS.Node): TS.CallExpression | null {
  const parent = id.parent;
  if (parent && ts.isCallExpression(parent) && parent.expression === id) return parent;
  if (
    parent &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === id &&
    parent.parent &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return parent.parent;
  }
  return null;
}

function scanFile(file: string): Offence[] {
  const offences: Offence[] = [];
  const p = parse(file);
  const rel = path.relative(SRC_DIR, file);
  const isSelf = path.resolve(file) === SELF_ABS;

  // --- (1) Aliasing `require` is banned in EVERY test file --------------------------
  // Not only in gated files: aliasing require is precisely how a file hides that it is
  // a DB suite, so the ban has to apply before we decide whether it is one.
  const requireVisit = (node: TS.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'require' && !isDirectCallee(node)) {
      if (!nodeIsExempt(p, node)) {
        offences.push({
          file: rel,
          line: lineOf(p, node),
          token: 'aliased-require',
          text: '`require` is referenced without being called — that defeats import analysis',
        });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      (node.arguments.length === 0 || !ts.isStringLiteral(node.arguments[0])) &&
      !nodeIsExempt(p, node)
    ) {
      offences.push({
        file: rel,
        line: lineOf(p, node),
        token: 'computed-require',
        text: 'require() with a non-literal specifier — unresolvable, so it can hide a DB import',
      });
    }
    ts.forEachChild(node, requireVisit);
  };
  requireVisit(p.sf);

  // --- (2) Is this file subject to the gate? ---------------------------------------
  const gatedByName = /\.(db|contract)\.test\.[jt]sx?$/.test(path.basename(file));
  const gatedByImport = reachesDb(file);
  if (isSelf || (!gatedByName && !gatedByImport)) return offences;

  // --- (3) BINDING rule: every reference to a suite registrar must be a direct
  //         callee inside a gate call. This is what closes the aliasing family,
  //         including `const d = SKIP ? describe.skip : describe`.
  let exemptRegistrationExists = false;

  // ...AND the same rule over the SUITE-LOCAL modules this file pulls in. The graph
  // already walks exactly these modules to answer "does it reach pg" (E2): they were
  // being read for one purpose and not the other, so exporting the alias from next door
  //     // helpers/zzReg.ts   export const reg = RUN ? describe : describe.skip;
  //     // zzE2.db.test.ts    reg('dark DB suite', () => { … });
  // defeated a rule whose whole claim is "you cannot alias what you cannot reference".
  // The claim only ever held INSIDE one file; now it holds across the set of files the
  // suite can reach locally.
  for (const support of suiteLocalModules(file)) {
    const sp = parse(support);
    const srel = path.relative(SRC_DIR, support);
    const svisit = (node: TS.Node): void => {
      const referenced = referencedName(node);
      if (referenced && !isDirectCallee(node) && !nodeIsExempt(sp, node)) {
        offences.push({
          file: srel,
          line: lineOf(sp, node),
          token: 'aliased-registrar-in-support-module',
          text: `\`${referenced}\` is referenced in a suite-local module imported by ${path.basename(file)} — an alias exported from next door registers suites the gate never sees`,
        });
      }
      ts.forEachChild(node, svisit);
    };
    svisit(sp.sf);
  }

  const visit = (node: TS.Node, insideGate: boolean): void => {
    let nowInsideGate = insideGate;

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const gateCall =
        (ts.isIdentifier(callee) && GATE_CALLS.includes(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          GATE_CALLS.includes(callee.expression.text));
      if (gateCall) nowInsideGate = true;
      else if (nodeIsExempt(p, node)) {
        // An excused registration excuses what it registers — whatever the wrapper is
        // called. `describeStreaming(...)` is a registration too; the marker on it is
        // the deliberate decision, so its nested describes are already accounted for.
        exemptRegistrationExists = true;
        nowInsideGate = true;
      }
    }

    // A reference can be spelled as an identifier OR as an element access with a
    // literal key — `globalThis['describe']` is statically just as visible as
    // `describe`, and reading only Identifier nodes (E3) let it walk past.
    const referenced = referencedName(node);
    if (referenced) {
      const isGateIdent = GATE_CALLS.includes(referenced);
      // Skip the import binding itself (`import { describeDb } from …`).
      const inImport =
        node.parent &&
        (ts.isImportSpecifier(node.parent) ||
          ts.isImportClause(node.parent) ||
          ts.isNamespaceImport(node.parent) ||
          ts.isExportSpecifier(node.parent));
      const call = isDirectCallee(node);
      const ok = inImport || (call !== null && (isGateIdent || insideGate));
      if (!ok && !nodeIsExempt(p, node)) {
        offences.push({
          file: rel,
          line: lineOf(p, node),
          token: isGateIdent ? 'gate-reference-not-called' : 'ungated-describe-reference',
          text: `\`${referenced}\` is referenced${call ? ' and called' : ''} outside a ${GATE_CALLS.join('/')} call — a reference can be aliased, stored or branched on, which is how a suite goes dark`,
        });
      }
    }

    ts.forEachChild(node, (c) => visit(c, nowInsideGate));
  };
  visit(p.sf, false);

  // --- (4) The file must import the gate — unless an exempted REGISTRATION exists.
  //         Determined from the AST above, not from a substring: the previous version
  //         accepted any line containing the marker and the word "describe", which a
  //         prose comment satisfies.
  const importsGate = p.specifiers.some((s) => s.includes(HELPER_SPECIFIER));
  if (!importsGate && !exemptRegistrationExists) {
    offences.push({
      file: rel,
      line: 0,
      token: 'no-gate-import',
      text: `${gatedByName ? 'named *.db/*.contract.test.*' : 'reaches pg / database/connection'} but never imports ${HELPER_SPECIFIER}`,
    });
  }

  // --- (5) The specific flag both CI gates set must not reappear in a test file. -----
  p.lines.forEach((text, i) => {
    if (text.includes('MANDREL_SKIP_DB_TESTS') && !text.includes(EXEMPT)) {
      offences.push({ file: rel, line: i + 1, token: 'MANDREL_SKIP_DB_TESTS', text: text.trim() });
    }
  });

  return offences;
}

function scan(files: string[]): Offence[] {
  const all = files.flatMap(scanFile);
  // A shared support module is imported by many suites; report each of ITS offences
  // once, or one helper produces twenty identical lines and the real finding is buried.
  const seen = new Set<string>();
  return all.filter((o) => {
    const key = `${o.file}:${o.line}:${o.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe('DB test-gate coverage — the old skip idiom cannot come back', () => {
  const collected = jestCollectedTests();

  it('scans EXACTLY what jest runs, and no test file exists that jest never runs', () => {
    // Scanning jest's list verbatim means the detector holds NO copy of testMatch, so
    // the two cannot drift. The walk below is a WIDER predicate on purpose: it asks
    // the other direction — does a file that looks like a test exist which jest will
    // never run? (A `.db.test.tsx` under the old `.endsWith('.test.ts')` filter was
    // exactly that: invisible to both sides while running nowhere.)
    const looksLikeTests = walkLooksLikeTests(SRC_DIR);
    const notRunByJest = looksLikeTests.filter((f) => !collected.includes(f));
    expect(notRunByJest).toEqual([]);
    expect(collected.length).toBeGreaterThan(40); // a config collecting nothing is also a bug
  });

  it('no test file registers a suite outside the shared gate', () => {
    const rendered = scan(collected)
      .map((o) => `  ${o.file}:${o.line}  [${o.token}]  ${o.text}`)
      .join('\n');
    expect(rendered).toBe('');
  });

  it("the gates' job-wide skip flag cannot switch a DB suite off", () => {
    // BEHAVIOURAL, not a text search: a grep for the flag's absence is
    // satisfied by prose and broken by a comment.
    const original = process.env.MANDREL_SKIP_DB_TESTS;
    try {
      jest.resetModules();
      process.env.MANDREL_SKIP_DB_TESTS = 'true'; // exactly what the CI gate + ci.yml export
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const gate = require('./helpers/dbContractGate');
      expect(gate.DB_SUITE_MODE).toBe('run');
      expect(gate.describeContract).toBe(describe);

      // Positive control: the decision is not hard-wired to 'run'.
      jest.resetModules();
      process.env.MANDREL_DB_CONTRACTS_OPTIONAL = 'true';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const optedOut = require('./helpers/dbContractGate');
      expect(optedOut.DB_SUITE_MODE).toBe('skip');
    } finally {
      delete process.env.MANDREL_DB_CONTRACTS_OPTIONAL;
      if (original === undefined) delete process.env.MANDREL_SKIP_DB_TESTS;
      else process.env.MANDREL_SKIP_DB_TESTS = original;
      jest.resetModules();
    }
  });

  it('the ONE helper is the only place the decision lives', () => {
    const helper = fs.readFileSync(HELPER_ABS, 'utf8');
    expect(helper).toContain("export const DB_SUITE_MODE: 'run' | 'skip'");
    expect(helper).toContain("export const describeContract = DB_SUITE_MODE === 'skip'");
    expect(helper).toContain("if (DB_SUITE_MODE === 'skip')");
  });

  describe('the detector itself has teeth (probe the probe)', () => {
    let tmp: string;

    beforeAll(() => {
      // Plant OUTSIDE jest's roots: a fixture inside src/ would be collected as a real
      // suite AND would perturb the population assertion above.
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgate-probe-'));
    });

    afterAll(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
      parseCache.clear();
      reachCache.clear();
    });

    function plant(name: string, body: string): Offence[] {
      const full = path.join(tmp, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
      parseCache.delete(full);
      reachCache.delete(full);
      return scanFile(full);
    }

    // --- D1: THE ORIGINAL DEFECT'S OWN IDIOM ---------------------------------------
    it('D1: catches `const d = FLAG ? describe : describe.skip` — the shape this task is named after', () => {
      const offences = plant(
        'aliasedTernary.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "const RUN = process.env.SOME_BESPOKE_FLAG === 'true';",
          'const d = RUN ? describe : describe.skip;',
          "d('dark DB suite', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      // Both `describe` references (the bare one and the `.skip` one) are caught AT the
      // reference. The dark `it` inside is caught too, hence filtering by name.
      expect(offences.filter((o) => o.text.includes('`describe`'))).toHaveLength(2);
    });

    it('D1b: catches the historical form with the CI flag as well', () => {
      const offences = plant(
        'historical.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "const SKIP = process.env.MANDREL_SKIP_DB_TESTS === 'true';",
          'const d = SKIP ? describe.skip : describe;',
          "d('x', () => { it('y', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toEqual(
        expect.arrayContaining([
          'ungated-describe-reference',
          'MANDREL_SKIP_DB_TESTS',
          'no-gate-import',
        ]),
      );
    });

    it('D1c: catches an aliased GATE (you cannot alias describeDb either)', () => {
      const offences = plant(
        'aliasedGate.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          'const g = describeDb;',
          "g('x', () => { it('y', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toContain('gate-reference-not-called');
    });

    // --- D2: the import graph --------------------------------------------------------
    it('D2: catches a DB connection reached through a local BARREL (non-DB filename)', () => {
      fs.writeFileSync(path.join(tmp, 'barrel.ts'), "export { Pool } from 'pg';\n");
      const offences = plant(
        'viaBarrel.test.ts',
        [
          "import { Pool } from './barrel';",
          "describe('looks innocent', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toEqual(
        expect.arrayContaining(['ungated-describe-reference', 'no-gate-import']),
      );
    });

    it('D2b: catches a helper that opens the connection on the suite\'s behalf', () => {
      fs.mkdirSync(path.join(tmp, 'support'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'support', 'index.ts'),
        "import { Pool } from 'pg';\nexport const open = () => new Pool({});\n",
      );
      const offences = plant(
        'viaHelper.test.ts',
        [
          "import { open } from './support';",
          "describe('two hops away', () => { it('t', () => { open(); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toContain('ungated-describe-reference');
    });

    // --- D3: aliased require ---------------------------------------------------------
    it('D3: catches `const req = require` and a computed require()', () => {
      const offences = plant(
        'aliasedRequire.test.ts',
        [
          'const req = require;',
          "const { Pool } = req('pg');",
          "describe('x', () => { it('y', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toContain('aliased-require');
    });

    it('D3b: catches require() with a non-literal specifier', () => {
      const offences = plant(
        'computedRequire.test.ts',
        [
          "const which = 'p' + 'g';",
          'const { Pool } = require(which);',
          "describe('x', () => { it('y', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toContain('computed-require');
    });

    // --- D4 / D5: exemptions ----------------------------------------------------------
    it('D4: a marker on a line with TWO registrations excuses NEITHER (ambiguity fails closed)', () => {
      const offences = plant(
        'twoOnOneLine.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "describe('a', () => { it('t', () => { new Pool({}); }); }); describe('b', () => { it('t', () => { new Pool({}); }); }); // db-gate-exempt: only the trailing one",
        ].join('\n'),
      );
      // One marker cannot name which of the two it excuses, so it excuses neither.
      expect(offences.filter((o) => o.text.includes('`describe`'))).toHaveLength(2);
    });

    it('D5: PROSE containing the word describe does not excuse a file', () => {
      const offences = plant(
        'proseExcuse.db.test.ts',
        [
          "import { Pool } from 'pg';",
          '// db-gate-exempt: this comment merely describes the harness',
          "describe('not actually excused', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      // The marker is on no registration node, so the file is still missing its gate.
      expect(offences.map((o) => o.token)).toContain('no-gate-import');
    });

    // --- D6: the population predicate --------------------------------------------------
    it('D6: a `.db.test.tsx` suite is judged like any other (no .test.ts suffix rule)', () => {
      const offences = plant(
        'tsxSuite.db.test.tsx',
        [
          "import { Pool } from 'pg';",
          "describe('a tsx suite', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toContain('ungated-describe-reference');
    });

    // --- E1: `it`/`test` register suites too -------------------------------------------
    it('E1: catches a dark top-level `it` sitting next to a decoy gated block', () => {
      const offences = plant(
        'darkIt.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "describeDb('trivial gated block', () => { it('ok', () => { expect(1).toBe(1); }); });",
          "const RUN = process.env.SOME_BESPOKE_FLAG === 'true';",
          "(RUN ? it : it.skip)('dark DB test', async () => { const p = new Pool({}); expect(p).toBeTruthy(); });",
        ].join('\n'),
      );
      // The decoy's own `it` is inside the gate and must NOT be flagged; the two
      // references on the last line must be.
      const dark = offences.filter((o) => o.line === 5);
      expect(dark.length).toBeGreaterThanOrEqual(2);
      expect(offences.filter((o) => o.line === 3)).toEqual([]);
    });

    // --- E2: the alias exported from next door ------------------------------------------
    it('E2: catches an alias exported from a suite-local support module', () => {
      fs.mkdirSync(path.join(tmp, 'helpers'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'helpers', 'zzReg.ts'),
        [
          "const RUN = process.env.SOME_BESPOKE_FLAG === 'true';",
          'export const reg = RUN ? describe : describe.skip;',
        ].join('\n'),
      );
      const offences = plant(
        'zzE2.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { reg } from './helpers/zzReg';",
          "reg('dark DB suite', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.map((o) => o.token)).toContain('aliased-registrar-in-support-module');
    });

    // --- E3: the literal element-access spelling ------------------------------------------
    it("E3: catches globalThis['describe'] — a literal key is not a computed one", () => {
      const offences = plant(
        'elementAccess.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "const g = globalThis as any;",
          "g['describe']('dark via element access', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.filter((o) => o.text.includes('`describe`')).length).toBeGreaterThanOrEqual(1);
    });

    // --- E4: ambiguity beyond the shape the old census counted ----------------------------
    it('E4: a marker cannot excuse a registration hidden in a block on the same line', () => {
      const withMarker = plant(
        'blockOnLine.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "if (true) { describe('A', () => { it('t', () => { new Pool({}); }); }); } describe('B', () => { it('t', () => { new Pool({}); }); }); // db-gate-exempt: ambiguous on purpose",
        ].join('\n'),
      );
      // Two outermost registrations share the line, so the marker excuses NEITHER.
      expect(withMarker.filter((o) => o.text.includes('`describe`'))).toHaveLength(2);

      // CONTROL: with the marker deleted the count is identical — proving the RED above
      // is the ambiguity rule refusing to excuse, not the marker being ignored entirely.
      const withoutMarker = plant(
        'blockOnLineNoMarker.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "if (true) { describe('A', () => { it('t', () => { new Pool({}); }); }); } describe('B', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(withoutMarker.filter((o) => o.text.includes('`describe`'))).toHaveLength(2);
    });

    // --- F1b: the alias TWO hops away (the depth bound, not the directory bound) ---------
    it('F1b: catches an alias re-exported through a SECOND suite-local barrel', () => {
      fs.mkdirSync(path.join(tmp, 'helpers'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'helpers', 'zzInner.ts'),
        [
          "const RUN = process.env.SOME_BESPOKE_FLAG === 'true';",
          'export const reg = RUN ? describe : describe.skip;',
          'export const tt = RUN ? it : it.skip;',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(tmp, 'helpers', 'zzOuter.ts'),
        "export { reg, tt } from './zzInner';\n",
      );
      const offences = plant(
        'zzF1.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { reg, tt } from './helpers/zzOuter';",
          "reg('dark DB suite', () => { tt('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      // BOTH registrars aliased, so nothing in the test file itself names one — the
      // catch has to come from following the barrel to its source.
      expect(offences.map((o) => o.token)).toContain('aliased-registrar-in-support-module');
      expect(offences.some((o) => o.file.includes('zzInner'))).toBe(true);
    });

    it('F2: catches pg reached through TWO suite-local barrels', () => {
      fs.mkdirSync(path.join(tmp, 'deep'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'deep', 'inner.ts'), "export { Pool } from 'pg';\n");
      fs.writeFileSync(path.join(tmp, 'deep', 'outer.ts'), "export { Pool } from './inner';\n");
      const offences = plant(
        'zzF2.test.ts', // deliberately NOT a *.db.test.ts name
        [
          "import { Pool } from './deep/outer';",
          "const RUN = process.env.SOME_BESPOKE_FLAG === 'true';",
          'const d = RUN ? describe : describe.skip;',
          "d('two barrels deep', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.filter((o) => o.text.includes('`describe`')).length).toBeGreaterThanOrEqual(1);
    });

    // --- F3: ambiguity, asked as a question about chains rather than a count -------------
    it('F3: a registration hidden in a CALLBACK on the marker line still blocks the exemption', () => {
      const offences = plant(
        'callbackOnLine.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "[1].forEach(() => { describe('A', () => { it('t', () => { new Pool({}); }); }); }); describe('B', () => { it('t', () => { new Pool({}); }); }); // db-gate-exempt: ambiguous on purpose",
        ].join('\n'),
      );
      // Neither describe is excused: each has a registration from a different chain
      // beginning on the marker's line.
      expect(offences.filter((o) => o.text.includes('`describe`'))).toHaveLength(2);
    });

    // --- the structural property that makes `it` worth more than a describe-only rule ----
    it('a suite registered outside the gate is caught through the `it`s it contains', () => {
      // Aliasing only the SUITE still leaves the tests inside it naming `it`, and `it`
      // must itself sit inside a gate. So a dark suite has to alias BOTH registrars to
      // have any chance — which is why adding the it/test family strengthened the rule
      // beyond the shape it was added for.
      const offences = plant(
        'suiteAliasedOnly.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "const RUN = process.env.SOME_BESPOKE_FLAG === 'true';",
          'const d = RUN ? describe : describe.skip;',
          "d('dark', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences.some((o) => o.text.includes('`it`'))).toBe(true);
    });

    // --- E5: the KNOWN GAP, pinned so it cannot be silently claimed as closed -------------
    it('E5 (KNOWN GAP, pinned): a re-export barrel ABOVE the test directory is NOT caught', () => {
      // This is the stated bound, not an oversight — but prose drifts and a pinned test
      // does not. If someone widens the walk, this goes RED and the header must be
      // updated in the same commit. That is the point: the gap is executable.
      fs.mkdirSync(path.join(tmp, 'support'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'support', 'barrel.ts'), "export { Pool } from 'pg';\n");
      fs.mkdirSync(path.join(tmp, 'suite'), { recursive: true });
      const offences = plant(
        path.join('suite', 'viaOuterBarrel.test.ts'),
        [
          "import { Pool } from '../support/barrel';",
          "describe('outside the bound', () => { it('t', () => { new Pool({}); }); });",
        ].join('\n'),
      );
      expect(offences).toEqual([]);
    });

    // --- anti-vacuous controls: the detector must NOT be blanket-RED -------------------
    it('passes a correctly-gated DB suite', () => {
      const offences = plant(
        'gated.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from './helpers/dbContractGate';",
          "describeDb('x', () => {",
          "  describe('a nested block is fine', () => { it('y', () => { new Pool({}); }); });",
          '});',
        ].join('\n'),
      );
      expect(offences).toEqual([]);
    });

    it('passes a non-DB suite using a plain describe (does not over-reach)', () => {
      const offences = plant(
        'pureUnit.test.ts',
        ["describe('pure unit', () => { it('y', () => { expect(1 + 1).toBe(2); }); });"].join('\n'),
      );
      expect(offences).toEqual([]);
    });

    it('passes a type-only pg import (erased — cannot connect)', () => {
      const offences = plant(
        'typeOnly.test.ts',
        [
          "import type { Pool } from 'pg';",
          "describe('types only', () => { it('y', () => { const p: Pool | null = null; expect(p).toBeNull(); }); });",
        ].join('\n'),
      );
      expect(offences).toEqual([]);
    });


    /**
     * ══ NAME SLOTS ARE NOT REFERENCES ═══════════════════════════════
     * A CLASS SWEEP, not a patch of the one instance that bit us. `referencedName` used
     * to return a name for ANY Identifier whose text was in SUITE_IDENTS — including
     * identifiers that occupy a NAME slot of their parent and therefore never resolve to
     * jest's global at all. `PATTERN.test(x)` is the one that turned the full backend
     * suite RED; the table below is every other position with the same shape.
     *
     * Each row is a WHOLE FILE that is otherwise a legitimate gated DB suite. If the
     * scanner reports ANY offence on it, the scanner is wrong about that row.
     */
    const NAME_SLOT_SHAPES: ReadonlyArray<{ what: string; line: string }> = [
      { what: 'RegExp.prototype.test — the measured false RED', line: "const ok = /x/.test(s);" },
      { what: 'a property access named `describe`', line: "const d = reporter.describe;" },
      { what: 'a method call named `it`', line: "const r = story.it();" },
      { what: 'an object literal KEY named `test`', line: "const cfg = { test: 1 };" },
      { what: 'an object literal key named `describe`', line: "const cfg = { describe: 'x' };" },
      { what: 'a local variable DECLARED as `test`', line: "const test = 1;" },
      { what: 'a function DECLARED as `test`', line: "function test() { return 1; }" },
      { what: 'a parameter named `test`', line: "const f = (test: number) => 1;" },
      { what: 'a class method named `test`', line: "class K { test() { return 1; } } void K;" },
      { what: 'an interface member named `test`', line: "interface I { test: string } const i: I = { test: 'a' }; void i;" },
      { what: 'a renamed destructure binding `{ q: test }`', line: "const { q: test } = { q: 1 };" },
      { what: 'a type member access in a qualified name', line: "type T = { it: string }; const t: T = { it: 'x' }; void t;" },
    ];

    it.each(NAME_SLOT_SHAPES)(
      'NAME SLOT is not a reference: $what is not an offence',
      ({ what, line }) => {
        const offences = plant(
          `nameslot_${Buffer.from(what).toString('hex').slice(0, 16)}.db.test.ts`,
          [
            "import { Pool } from 'pg';",
            "import { describeDb } from '../../src/__tests__/helpers/dbContractGate';",
            `describeDb('legit', () => { it('y', () => { ${line} new Pool({}); }); });`,
          ].join('\n'),
        );
        expect({ what, offences: offences.map((o) => `${o.token}:${o.text.slice(0, 40)}`) }).toEqual({
          what,
          offences: [],
        });
      },
    );

    /**
     * THE OTHER DIRECTION, in the same table. These shapes look like name slots and are
     * NOT: the identifier really is the value being read, so the scanner must still
     * catch them. Widening "skip name slots" past these is how the fix becomes a hole.
     */
    const STILL_CAUGHT: ReadonlyArray<{ what: string; line: string }> = [
      { what: 'shorthand destructure of the global — `const { test } = globalThis`', line: "const { test } = globalThis as any; void test;" },
      { what: 'renamed destructure whose KEY is the registrar', line: "const { describe: reg } = globalThis as any; void reg;" },
      { what: 'shorthand object property carrying the registrar', line: "const bag = { describe }; void bag;" },
      { what: 'the receiver of a property access — `describe.skip`', line: "const d = describe.skip; void d;" },
      { what: 'a literal element access — globalThis[\'it\'] (E3)', line: "const r = (globalThis as any)['it']; void r;" },
      { what: 'a bare reference passed as an argument', line: "const g = [test]; void g;" },
    ];

    /**
     * KNOWN GAP, PINNED — the limit of a syntax-only rule, stated as a test rather than a
     * sentence. `isNameSlot` can tell a DECLARATION of `test` from a reference to the
     * global, but it cannot tell a READ of that local from a read of the global: that
     * needs scope resolution, which means a full ts.Program per file. So a file that
     * declares a local named after a registrar AND USES IT still reports an offence.
     *
     * It fails toward a FALSE RED, which is the survivable direction — a suite cannot go
     * dark this way, an author is merely told to rename a local. Closing it costs
     * whole-program type resolution; leaving it costs a rename. Pinned so that if the
     * behaviour ever changes, someone changes this deliberately.
     */
    it('KNOWN GAP, pinned: READING a local shadowing a registrar is still reported', () => {
      const offences = plant(
        'shadowingLocalRead.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from '../../src/__tests__/helpers/dbContractGate';",
          "describeDb('legit', () => { it('y', () => { new Pool({}); }); });",
          'const test = 1;',
          'void test;',
        ].join('\n'),
      );
      // The DECLARATION is correctly silent; the READ on the next line is what is caught.
      expect(offences.map((o) => o.line)).toEqual([5]);
    });

    it.each(STILL_CAUGHT)('STILL CAUGHT: $what is an offence', ({ what, line }) => {
      const offences = plant(
        `caught_${Buffer.from(what).toString('hex').slice(0, 16)}.db.test.ts`,
        [
          "import { Pool } from 'pg';",
          "import { describeDb } from '../../src/__tests__/helpers/dbContractGate';",
          `describeDb('legit', () => { it('y', () => { new Pool({}); }); });`,
          line,
        ].join('\n'),
      );
      expect({ what, caught: offences.length > 0 }).toEqual({ what, caught: true });
    });

    it('honours a genuine per-node exemption on the registration itself', () => {
      const offences = plant(
        'exempt.db.test.ts',
        [
          "import { Pool } from 'pg';",
          "describe('excused', () => { it('y', () => { new Pool({}); }); }); // db-gate-exempt: measured reason",
        ].join('\n'),
      );
      expect(offences).toEqual([]);
    });
  });
});
