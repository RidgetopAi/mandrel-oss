/**
 * DENY-BY-DEFAULT COVERAGE OVER `callTool(` — an earlier task, Reviewer B2.
 *
 * =============================================================================
 * THE GAP THIS CLOSES
 * =============================================================================
 * On the mcp-server side, "every op declares what it does to persistent state" is
 * COMPILER-enforced: `effect` is a required field on OpRegistryEntry, so a new op that does
 * not classify itself fails to compile (TS2741). The Command backend had no equivalent. Its
 * writes reach the MCP server through exactly one seam — `McpService.callTool(...)` — and a
 * fourth write site could be added tomorrow with no project scope, exactly like the three
 * that shipped that way (`decision_record`, `decision_update`, `context_store`), and nothing
 * would notice.
 *
 * =============================================================================
 * THE ANCHOR IS THE CHOKE POINT, NOT THE SHAPES I HAD IN MIND
 * =============================================================================
 * Every backend→MCP call must pass through the token `callTool(`. So the population is
 * "every `callTool` call expression", and the DEFAULT for a site this file does not
 * recognise is a loud RED — never a silent pass. There is no central allow-list
 * of blessed sites to drift out of date: the exception is CO-LOCATED on the call, so
 * forgetting one is a visible RED rather than a hole in a registry nobody re-reads.
 *
 * =============================================================================
 * THE TEST IS THE PARSER, NOT A GREP
 * =============================================================================
 * The population is collected with the TypeScript compiler API, not a regex. A grep for
 * `callTool(` matches the word inside a comment (`services/session.ts:300`,
 * `services/surveyor.ts:582` both mention it in prose) and inside a string, and it MISSES
 * nothing only by accident. The parser answers the actual question — "is this a call
 * expression whose callee is named callTool" — and it distinguishes the DECLARATION
 * (`static async callTool(...)` in services/mcp.ts) from an invocation.
 *
 * =============================================================================
 * THE RULE
 * =============================================================================
 * For every `callTool` invocation:
 *   1. the tool name must be a STRING LITERAL — a dynamically-named call cannot be
 *      classified, so it is RED until someone makes it classifiable or annotates it;
 *   2. if the tool is in WRITE_TOOLS (pinned literally below), the ONLY ways to pass are
 *      `requireWriteProjectId` in the same enclosing function, or a co-located
 *      `self-scoped` annotation. An annotation can NOT downgrade it to `read` — that is the
 *      laundering move, and it is rejected explicitly;
 *   3. otherwise the call must carry a co-located annotation with a REASON:
 *        // mcp-write-scope: read — <why this persists nothing>
 *        // mcp-write-scope: self-scoped — <how this call names its own project>
 *        // mcp-write-scope: exempt — <why neither applies>
 *      "Co-located" is enforced by the parser too: the annotation must be in the leading
 *      comment block of the statement containing the call, or a trailing comment on the same
 *      line. A note three functions away does not count.
 *
 * WHAT THIS DOES NOT CLAIM (a past incident — verified narrow, claimed broad).
 * WRITE_TOOLS is a FLOOR, not an oracle. It cannot know that some future mcp-server op
 * became a write; it exists so the tools we KNOW write can never be annotated away. The
 * deny-by-default rule (3) is what covers the unknown: a tool name this file has never seen
 * is RED until a human states what it is.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

const SRC_ROOT = join(__dirname, '..');

/**
 * Tools that PERSIST on the mcp-server side. Stated literally here on purpose: a guard that
 * READS the product's list widens in lockstep with it (a past incident #7). Mirrors the
 * `effect: 'write'` / `'scope-switch'` rows of mcp-server/src/config/opRegistry.ts as of
 * 2026-07-28; the mcp-server's own contract test pins that side independently.
 */
const WRITE_TOOLS = new Set([
  'session_start', 'session_end', 'session_pin',
  'context_store', 'context_update', 'context_delete', 'context_restore',
  'project_create', 'project_update', 'project_delete', 'project_switch',
  'decision_record', 'decision_update', 'decision_delete', 'decision_restore',
  'task_create', 'task_update', 'task_bulk_update', 'task_delete', 'task_restore',
  'cancel_task', 'task_claim', 'task_renew', 'task_release',
  'link', 'unlink', 'thread_set', 'thread_clear',
]);

const ANNOTATION = /mcp-write-scope:\s*(read|self-scoped|exempt)\s*(?:—|--|-)\s*(\S.*)$/m;
const SCOPE_HELPER = 'requireWriteProjectId';

interface Violation {
  file: string;
  line: number;
  tool: string;
  why: string;
}

/** Every .ts under src/, excluding tests — the same tree the backend ships. */
function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      productFiles(p, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** The nearest enclosing function-like ancestor (where the scope helper would live). */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) ||
      ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) ||
      ts.isConstructorDeclaration(cur)
    ) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** The statement the call sits in — the node whose LEADING comments are "co-located". */
function enclosingStatement(node: ts.Node): ts.Node {
  let cur: ts.Node = node;
  while (cur.parent && !ts.isStatement(cur)) cur = cur.parent;
  return cur;
}

function coLocatedAnnotation(sf: ts.SourceFile, call: ts.Node): RegExpMatchArray | null {
  const full = sf.getFullText();
  const stmt = enclosingStatement(call);
  const chunks: string[] = [];
  for (const r of ts.getLeadingCommentRanges(full, stmt.getFullStart()) ?? []) {
    chunks.push(full.slice(r.pos, r.end));
  }
  // …plus a trailing comment on the SAME line as the call.
  const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
  const starts = sf.getLineStarts();
  const lineText = full.slice(starts[line], starts[line + 1] ?? full.length);
  chunks.push(lineText);
  for (const c of chunks) {
    const m = c.match(ANNOTATION);
    if (m) return m;
  }
  return null;
}

/**
 * THE DETECTOR — a pure function of (fileName, sourceText), so the mutation probe at the
 * bottom can re-run it against MUTATED COPIES of the real files rather than against a
 * hand-written fake that proves nothing about the real one.
 */
export function classifySource(fileName: string, text: string): Violation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee) ? callee.text : undefined;

      if (name === 'callTool') {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const first = node.arguments[0];
        const tool = first && ts.isStringLiteralLike(first) ? first.text : null;
        const ann = coLocatedAnnotation(sf, node);
        const fn = enclosingFunction(node);
        const guarded = fn ? fn.getText(sf).includes(SCOPE_HELPER) : false;

        if (tool === null) {
          violations.push({
            file: fileName, line, tool: '<non-literal>',
            why: 'the tool name is not a string literal, so this call cannot be classified',
          });
        } else if (WRITE_TOOLS.has(tool)) {
          if (ann?.[1] === 'read') {
            violations.push({
              file: fileName, line, tool,
              why: `'${tool}' PERSISTS — it cannot be annotated 'read'. Scope it with ${SCOPE_HELPER}().`,
            });
          } else if (!guarded && ann?.[1] !== 'self-scoped') {
            violations.push({
              file: fileName, line, tool,
              why: `'${tool}' writes: its enclosing function must call ${SCOPE_HELPER}(), ` +
                   `or the call must carry a co-located 'mcp-write-scope: self-scoped — <reason>'`,
            });
          }
        } else if (!ann && !guarded) {
          violations.push({
            file: fileName, line, tool,
            why: `'${tool}' is unrecognised here: state it with a co-located ` +
                 `'mcp-write-scope: read|self-scoped|exempt — <reason>' comment`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

const FILES = productFiles(SRC_ROOT);

function scanTree(): Violation[] {
  return FILES.flatMap((f) => classifySource(relative(SRC_ROOT, f), readFileSync(f, 'utf8')));
}

describe('every backend→MCP callTool site declares its write scope (deny-by-default)', () => {
  it('finds a NON-EMPTY population — an empty walk would pass over nothing', () => {
    // The zero-population trap: if the file walk or the parser broke, every assertion below
    // would be vacuously green. Anchor on the choke point actually being found.
    const sites = FILES.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2020, true);
      let n = 0;
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const c = node.expression;
          const nm = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : '';
          if (nm === 'callTool') n++;
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      return n ? [{ f, n }] : [];
    });
    const total = sites.reduce((a, s) => a + s.n, 0);
    expect(FILES.length).toBeGreaterThan(20);
    expect(total).toBeGreaterThan(10);
    // The three sites this task fixed must be in the population, by name.
    const decision = readFileSync(join(SRC_ROOT, 'controllers/decision.ts'), 'utf8');
    const context = readFileSync(join(SRC_ROOT, 'controllers/context.ts'), 'utf8');
    expect(decision).toContain("callTool('decision_record'");
    expect(decision).toContain("callTool('decision_update'");
    expect(context).toContain("callTool('context_store'");
  });

  it('has ZERO undeclared sites in the tree as it stands', () => {
    const violations = scanTree();
    expect(
      violations.map((v) => `${v.file}:${v.line} [${v.tool}] ${v.why}`)
    ).toEqual([]);
  });
});

/**
 * THE PREMISE BEHIND THE `exempt` ANNOTATIONS IN controllers/naming.ts.
 *
 * Seven callTool sites there are excused on the grounds that the naming_* surface does not
 * exist on the MCP server, so those calls persist nothing. That is a claim about ANOTHER
 * package, and a comment cannot hold it: if the surface is ever restored, `naming_register`
 * becomes a real write and seven `exempt` comments silently bless it. So the premise is
 * TESTED. This is a text search, and it is honest about being one — it guards a premise
 * ("no such opId is declared"), not a behaviour.
 */
describe('the naming_* exemption premise', () => {
  const REGISTRY = join(
    SRC_ROOT, '..', '..', '..', 'mcp-server', 'src', 'config', 'opRegistry.ts'
  );

  it('the mcp-server registry file is actually readable (a missing file must not pass)', () => {
    // Without this, a moved/renamed registry would make the assertion below vacuously true.
    const text = readFileSync(REGISTRY, 'utf8');
    expect(text).toContain('export const OP_REGISTRY');
    expect(text).toContain("opId: 'context_store'"); // a control: the reader really sees opIds
  });

  it('declares NO naming_* op — the premise the exempt annotations rest on', () => {
    const text = readFileSync(REGISTRY, 'utf8');
    const found = [...text.matchAll(/opId: '(naming_[a-z_]+)'/g)].map((m) => m[1]);
    expect(found).toEqual([]);
  });
});

/**
 * MUTATION PROBE — the detector must go RED on each way the rule can be broken, and the
 * unmutated text must be GREEN (the positive control, without which a RED proves nothing).
 * Each probe asserts the mutation LANDED before believing the result: a mutation that
 * silently changed nothing reports a perfect pass.
 */
describe('MUTATION PROBE — the guard has teeth', () => {
  const decisionPath = join(SRC_ROOT, 'controllers/decision.ts');
  const original = readFileSync(decisionPath, 'utf8');

  const assertLanded = (before: string, after: string, label: string): void => {
    if (after === before) {
      throw new Error(
        `mutation '${label}' did not change the source — the probe was a NO-OP, and a no-op ` +
          `probe reports a perfect result. Fix the mutation, not the assertion.`
      );
    }
  };

  it('positive control: the unmutated file is CLEAN', () => {
    expect(classifySource('controllers/decision.ts', original)).toEqual([]);
  });

  it('RED when requireWriteProjectId is removed from a write site', () => {
    const mutated = original.replace(
      /const projectId = requireWriteProjectId\([^;]*;/,
      "const projectId = 'whatever-the-shared-slot-points-at';"
    );
    assertLanded(original, mutated, 'drop requireWriteProjectId');
    const v = classifySource('controllers/decision.ts', mutated);
    expect(v.length).toBeGreaterThan(0);
    expect(v.map((x) => x.tool)).toContain('decision_record');
  });

  it('RED when a NEW unannotated callTool site is added', () => {
    const mutated = original.replace(
      'export class DecisionController',
      "export async function sneak() { await McpService.callTool('some_new_tool', {}); }\n\nexport class DecisionController"
    );
    assertLanded(original, mutated, 'add an unannotated site');
    const v = classifySource('controllers/decision.ts', mutated);
    expect(v.map((x) => x.tool)).toContain('some_new_tool');
  });

  it('RED when a WRITE tool is laundered with a `read` annotation', () => {
    // The annotation must be inserted as a LEADING comment of the statement — an earlier
    // version of this probe spliced it mid-statement (`const result = // …`), which changed
    // the text (so assertLanded passed) while creating a scenario the detector never sees.
    // A mutation that lands but does not reach the intended STATE is the same no-op in a
    // different costume.
    const mutated = original
      .replace(
        /const projectId = requireWriteProjectId\([^;]*;/,
        "const projectId = 'ambient';"
      )
      .replace(
        "      const result = await McpService.callTool('decision_record'",
        "      // mcp-write-scope: read — honestly it's fine\n" +
          "      const result = await McpService.callTool('decision_record'"
      );
    assertLanded(original, mutated, 'launder a write as read');
    // …and assert the mutation reached the STATE it is probing: the annotation is now where
    // the detector looks for it, and the scope helper is gone from that function.
    expect(mutated).toMatch(/\/\/ mcp-write-scope: read — honestly it's fine\n\s+const result = await McpService\.callTool\('decision_record'/);
    expect(mutated).not.toContain("requireWriteProjectId(req as AuthenticatedRequest, 'record a decision')");

    const v = classifySource('controllers/decision.ts', mutated);
    expect(v.some((x) => x.tool === 'decision_record' && /cannot be annotated/.test(x.why))).toBe(true);
  });

  it('RED when a read annotation is REMOVED from a read site', () => {
    const mutated = original.replace(/^\s*\/\/ mcp-write-scope: read.*$/m, '');
    assertLanded(original, mutated, 'strip a read annotation');
    expect(classifySource('controllers/decision.ts', mutated).length).toBeGreaterThan(0);
  });

  it('RED when the tool name stops being a string literal', () => {
    const mutated = original.replace(
      "await McpService.callTool('decision_stats'",
      'await McpService.callTool(TOOL_NAME'
    );
    assertLanded(original, mutated, 'dynamic tool name');
    const v = classifySource('controllers/decision.ts', mutated);
    expect(v.map((x) => x.tool)).toContain('<non-literal>');
  });

  it('ANTI-VACUOUS: an annotation that is NOT co-located does not satisfy the rule', () => {
    // A note parked at the top of the file must not excuse a call 200 lines down — otherwise
    // the "co-located" claim is decorative and one comment blesses the whole file.
    const stripped = original.replace(/^\s*\/\/ mcp-write-scope:.*$/gm, '');
    const mutated = '// mcp-write-scope: read — a blanket excuse at the top of the file\n' + stripped;
    assertLanded(original, mutated, 'move annotations to the file header');
    expect(classifySource('controllers/decision.ts', mutated).length).toBeGreaterThan(0);
  });
});
