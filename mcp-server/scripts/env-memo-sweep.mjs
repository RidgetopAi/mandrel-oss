#!/usr/bin/env node
/**
 * env-memo-sweep.mjs — find MODULE-SCOPE env memoization that a TEST varies.
 *
 *   cd mcp-server && node scripts/env-memo-sweep.mjs
 *
 * WHY THIS EXISTS
 *   `config/embeddingConfig.ts` memoized the embedder selection in module-scope
 *   `export const`s evaluated at first import. Test files that flip `MANDREL_EMBEDDER`
 *   in `vi.hoisted()` could not reach that snapshot, and the authoritative clean gate
 *   returned GREEN then RED on the same ref. The hazard is not "config in a const" — it
 *   is the INTERSECTION: a value frozen at import time whose input a test changes.
 *
 * WHY IT IS A SCRIPT AND NOT A GATE
 *   Deliberate. A guard that bans module-scope env reads would forbid a great deal of
 *   legitimate config (221 vars are read that way here and almost none are a hazard), and
 *   a guard that blocks correct work gets deleted the first time it is inconvenient. This
 *   answers a question on demand instead: run it when you touch config, or when a suite
 *   starts disagreeing with itself.
 *
 * THE HISTORY THAT SHAPED THE METHOD — read this before trusting a number from it.
 *   The first version of this sweep was a regex, and it reported the intersection as 5
 *   when it was 9. It found module-scope memos correctly, but extracted env NAMES with a
 *   HARDCODED wrapper list (`process.env.X` plus the `envStr/envInt/envFloat/envBool`
 *   family). Any read through a different wrapper was invisible, so
 *   `getEnvVar('AIDIS_SKIP_DATABASE', ...)` in server/MandrelMcpServer.ts never entered
 *   the population at all. The stated method ("an initializer that REACHES process.env")
 *   was wider than the measured one, and nothing said so.
 *
 *   Hence: wrappers are DISCOVERED from the AST, never listed. And the shapes this still
 *   cannot see are MEASURED and printed (section 3) rather than left to the reader.
 *
 * METHOD
 *   A  Discover env-reading WRAPPERS: any function whose body reads
 *      `process.env[<one of its own parameters>]`. Record which parameter indexes carry a
 *      var name. (Finds getEnvVar's TWO name params, and the whole env* family.)
 *   B  For every TOP-LEVEL variable declaration in every non-test .ts under src/, walk the
 *      whole initializer subtree — so top-level IIFEs, object literals and nested calls are
 *      covered — and collect the env names it reads, directly or through a wrapper called
 *      with a string literal.
 *   C  Collect env names any TEST file WRITES (assignment, delete, vi.stubEnv) and
 *      intersect. That intersection is the hazard set.
 *
 * CONTROL: run it against a ref that still has the bug and MANDREL_EMBEDDER must appear —
 * at f9d1f00 it reports 9, at the fix commit 8. A sweep that cannot go RED proves nothing.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const list = (cmd) => execSync(cmd, { encoding: 'utf8' }).split('\n').filter(Boolean);
const PROD = list("find src -name '*.ts' ! -name '*.test.ts' ! -name '*.spec.ts' | sort");
const TESTS = list("find src \\( -name '*.test.ts' -o -name '*.spec.ts' \\) | sort");
const parse = (f) => ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
const walk = (n, fn) => { fn(n); n.forEachChild((c) => walk(c, fn)); };

const isProcessEnv = (n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)
  && n.expression.text === 'process' && n.name.text === 'env';
const anyEnvAccess = (n) => isProcessEnv(n)
  || ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isProcessEnv(n.expression));

/** process.env.FOO / process.env['FOO'] -> 'FOO' */
function directEnvName(n) {
  if (ts.isPropertyAccessExpression(n) && isProcessEnv(n.expression)) return n.name.text;
  if (ts.isElementAccessExpression(n) && isProcessEnv(n.expression)
      && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) {
    return n.argumentExpression.text;
  }
  return null;
}

// ------------------------------------------------------- A: discover wrappers
const WRAPPERS = new Map(); // name -> Set(param index carrying an env var name)
function recordWrapper(name, fn) {
  if (!name || !fn.body || !fn.parameters) return;
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
  const idxs = new Set();
  walk(fn.body, (n) => {
    if (ts.isElementAccessExpression(n) && isProcessEnv(n.expression)
        && n.argumentExpression && ts.isIdentifier(n.argumentExpression)) {
      const i = params.indexOf(n.argumentExpression.text);
      if (i >= 0) idxs.add(i);
    }
  });
  if (idxs.size) WRAPPERS.set(name, new Set([...(WRAPPERS.get(name) ?? []), ...idxs]));
}
for (const f of [...PROD, ...TESTS]) {
  walk(parse(f), (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) recordWrapper(n.name.text, n);
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
             && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      recordWrapper(n.name.text, n.initializer);
    } else if (ts.isMethodDeclaration(n) && n.name && ts.isIdentifier(n.name)) recordWrapper(n.name.text, n);
  });
}

const calleeName = (n) => ts.isIdentifier(n.expression) ? n.expression.text
  : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;

function envNamesIn(node) {
  const names = new Set();
  walk(node, (n) => {
    const d = directEnvName(n);
    if (d) names.add(d);
    if (ts.isCallExpression(n)) {
      const idxs = WRAPPERS.get(calleeName(n));
      if (idxs) for (const i of idxs) {
        const a = n.arguments[i];
        if (a && ts.isStringLiteralLike(a)) names.add(a.text);
      }
    }
  });
  return names;
}

// ------------------------------------- B: module-scope memos + the memo decl names
const MEMOS = new Map();            // envName -> [{file,line,decl}]
const MEMO_FILES = new Set();
const MEMO_DECLS = new Set();       // decl names that ARE env memos (for the transitive check)
const NONLITERAL = [];
for (const f of PROD) {
  const sf = parse(f);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      const line = sf.getLineAndCharacterOfPosition(decl.getStart()).line + 1;
      const declName = ts.isIdentifier(decl.name) ? decl.name.text : '(destructured)';
      walk(decl.initializer, (n) => {
        if (!ts.isCallExpression(n)) return;
        const idxs = WRAPPERS.get(calleeName(n));
        if (!idxs) return;
        for (const i of idxs) {
          const a = n.arguments[i];
          if (a && !ts.isStringLiteralLike(a)) NONLITERAL.push(`${f}:${line} ${declName}`);
        }
      });
      const names = envNamesIn(decl.initializer);
      if (!names.size) continue;
      MEMO_FILES.add(f);
      MEMO_DECLS.add(declName);
      for (const v of names) {
        if (!MEMOS.has(v)) MEMOS.set(v, []);
        MEMOS.get(v).push({ file: f, line, decl: declName });
      }
    }
  }
}

// -------------------------------------------------- C: env names a TEST writes
//
// A literal name is the easy half. The HARD half is the common save/restore idiom, where
// the name is one indirection away:
//     for (const k of ENV_KEYS)                 { process.env[k] = saved[k]; }
//     for (const [k, v] of Object.entries(TEST_ENV)) vi.stubEnv(k, v);
// Left unresolved these were 64 sites here — i.e. the "varied by a test" set would have
// been a LOWER BOUND, and the intersection with it likewise. So resolve identifiers to a
// same-file const whose initializer is an array/object of string literals. Anything still
// unresolved is counted and printed in section 3, never silently dropped.
const WRITTEN = new Map();
const addW = (v, f) => { if (!WRITTEN.has(v)) WRITTEN.set(v, new Set()); WRITTEN.get(v).add(f); };
const UNRESOLVED = [];

/** name -> [string literals] for same-file top-level consts holding an array/object of strings */
function literalNameTables(sf) {
  const t = new Map();
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!d.initializer || !ts.isIdentifier(d.name)) continue;
      const vals = [];
      if (ts.isArrayLiteralExpression(d.initializer)) {
        for (const e of d.initializer.elements) if (ts.isStringLiteralLike(e)) vals.push(e.text);
      } else if (ts.isObjectLiteralExpression(d.initializer)) {
        for (const pr of d.initializer.properties) {
          if ((ts.isPropertyAssignment(pr) || ts.isShorthandPropertyAssignment(pr)) && pr.name) {
            if (ts.isIdentifier(pr.name) || ts.isStringLiteralLike(pr.name)) vals.push(pr.name.text);
          }
        }
      } else if (ts.isNewExpression(d.initializer) && d.initializer.arguments?.[0]
                 && ts.isArrayLiteralExpression(d.initializer.arguments[0])) {
        for (const e of d.initializer.arguments[0].elements) if (ts.isStringLiteralLike(e)) vals.push(e.text);
      } else if (ts.isStringLiteralLike(d.initializer)) {
        vals.push(d.initializer.text);      // const KEY = 'MANDREL_X'
      }
      if (vals.length) t.set(d.name.text, vals);
    }
  }
  return t;
}

for (const f of TESTS) {
  const sf = parse(f);
  const tables = literalNameTables(sf);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  /** record an env-name expression: literal, or an identifier we can resolve to literals */
  const record = (expr, node) => {
    if (!expr) return;
    if (ts.isStringLiteralLike(expr)) { addW(expr.text, f); return; }
    if (ts.isIdentifier(expr)) {
      // the key identifier itself (const KEY = 'X'), or the loop variable of `for (const k of TABLE)`
      const direct = tables.get(expr.text);
      if (direct) { direct.forEach((v) => addW(v, f)); return; }
      const bound = LOOPVARS.get(expr.text);
      if (bound) { bound.forEach((v) => addW(v, f)); return; }
    }
    UNRESOLVED.push(`${f}:${line(node)}`);
  };
  // map loop variables bound over a literal name table -> those literals
  const LOOPVARS = new Map();
  walk(sf, (n) => {
    if (ts.isForOfStatement(n)) {
      let srcName = null;
      const e = n.expression;
      if (ts.isIdentifier(e)) srcName = e.text;
      else if (ts.isCallExpression(e) && calleeName(e) === 'entries'
               && e.arguments[0] && ts.isIdentifier(e.arguments[0])) srcName = e.arguments[0].text;
      else if (ts.isCallExpression(e) && calleeName(e) === 'keys'
               && e.arguments[0] && ts.isIdentifier(e.arguments[0])) srcName = e.arguments[0].text;
      const vals = srcName ? tables.get(srcName) : null;
      if (!vals) return;
      const decl = ts.isVariableDeclarationList(n.initializer) ? n.initializer.declarations[0] : null;
      if (!decl) return;
      if (ts.isIdentifier(decl.name)) LOOPVARS.set(decl.name.text, vals);
      else if (ts.isArrayBindingPattern(decl.name) && decl.name.elements[0]
               && ts.isBindingElement(decl.name.elements[0])
               && ts.isIdentifier(decl.name.elements[0].name)) {
        LOOPVARS.set(decl.name.elements[0].name.text, vals);   // for (const [k, v] of entries(T))
      }
    }
  });
  walk(sf, (n) => {
    // process.env.X = ... | process.env['X'] = ... | process.env[k] = ...
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const d = directEnvName(n.left);
      if (d) { addW(d, f); return; }
      if (ts.isElementAccessExpression(n.left) && isProcessEnv(n.left.expression)) record(n.left.argumentExpression, n);
    }
    // delete process.env.X | delete process.env[k]
    if (ts.isDeleteExpression(n)) {
      const d = directEnvName(n.expression);
      if (d) { addW(d, f); return; }
      if (ts.isElementAccessExpression(n.expression) && isProcessEnv(n.expression.expression)) {
        record(n.expression.argumentExpression, n);
      }
    }
    // vi.stubEnv(<name>, ...)
    if (ts.isCallExpression(n) && calleeName(n) === 'stubEnv') record(n.arguments[0], n);
  });
}

// ------------------------------------------ 3: the shapes this sweep CANNOT see
const blind = { lazyLet: [], classStatic: [], transitive: [] };
for (const f of PROD) {
  const sf = parse(f);
  const topLet = new Set();
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s) && !(s.declarationList.flags & ts.NodeFlags.Const)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) topLet.add(d.name.text);
    }
  }
  walk(sf, (n) => {
    const ln = () => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    // a top-level `let` filled later, from inside a function
    if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && topLet.has(n.left.text)
        && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
            ts.SyntaxKind.BarBarEqualsToken].includes(n.operatorToken.kind)) {
      let reads = false; walk(n.right, (m) => { if (anyEnvAccess(m)) reads = true; });
      if (reads) blind.lazyLet.push(`${f}:${ln()} ${n.left.text}`);
    }
    // env read in a class STATIC initializer
    if (ts.isPropertyDeclaration(n) && n.initializer
        && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Static)) {
      let reads = false; walk(n.initializer, (m) => { if (anyEnvAccess(m)) reads = true; });
      if (reads) blind.classStatic.push(`${f}:${ln()}`);
    }
  });
  // a const frozen FROM an env memo: reads no env itself, so B cannot see it (the EMBED_DIM shape)
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!d.initializer || !ts.isIdentifier(d.name)) continue;
      if (ts.isCallExpression(d.initializer)) continue;      // a call re-reads at use time
      if (envNamesIn(d.initializer).size) continue;          // already reported by B
      let src = null;
      walk(d.initializer, (m) => { if (ts.isIdentifier(m) && MEMO_DECLS.has(m.text) && !src) src = m.text; });
      if (src) blind.transitive.push(`${f}:${sf.getLineAndCharacterOfPosition(d.getStart()).line + 1} ${d.name.text} <- ${src}`);
    }
  }
}

// ------------------------------------------------------------------- REPORT
const p = (s = '') => console.log(s);
p('=== 1. WRAPPERS DISCOVERED (name -> env-name param indexes) ===');
[...WRAPPERS.keys()].sort().forEach((k) => p(`   ${k}(${[...WRAPPERS.get(k)].sort().join(',')})`));
p();
p('=== 2. POPULATION ===');
p(`   prod (non-test) .ts under src           : ${PROD.length}`);
p(`   test files under src                    : ${TESTS.length}`);
p(`   prod files with a module-scope env memo : ${MEMO_FILES.size}`);
p(`   distinct env vars read at module scope  : ${MEMOS.size}`);
p(`   distinct env vars WRITTEN by a test     : ${WRITTEN.size}`);
p();
const inter = [...MEMOS.keys()].filter((v) => WRITTEN.has(v)).sort();
p(`=== THE INTERSECTION — memoized at import time AND varied by a test: ${inter.length} ===`);
for (const v of inter) {
  p(`\n   ${v}`);
  for (const m of MEMOS.get(v)) p(`       memoized  : ${m.file}:${m.line}  (${m.decl})`);
  p(`       varied by : ${[...WRITTEN.get(v)].sort().join(', ')}`);
}
p();
p('=== 3. WHAT THIS SWEEP CANNOT SEE (measured, not assumed) ===');
const sec = (label, arr) => {
  p(`\n   ${label}: ${new Set(arr).size}`);
  [...new Set(arr)].sort().forEach((s) => p(`       ${s}`));
};
sec('module-scope LAZY memo (top-level `let` filled from a function)', blind.lazyLet);
sec('env read in a CLASS STATIC initializer', blind.classStatic);
sec('TRANSITIVE memo (const frozen from another env memo — the EMBED_DIM shape)', blind.transitive);
sec('TEST env-name expression still UNRESOLVED after literal-table resolution', UNRESOLVED);
sec('wrapper called with a NON-LITERAL name at module scope', NONLITERAL);
p('\n   Also outside scope by construction: files outside mcp-server/src (incl.');
p('   mcp-server/scripts/*.ts), non-.ts files, and wrappers matched BY NAME only —');
p('   no symbol resolution, so an aliased/namespaced import of a wrapper is missed and a');
p('   same-named non-env function over-matches (over-inclusion, the safe direction).');
