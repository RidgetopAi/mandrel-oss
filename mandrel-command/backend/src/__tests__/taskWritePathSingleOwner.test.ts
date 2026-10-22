/**
 * taskWritePathSingleOwner — ONE owner for task field writes.
 *
 * =============================================================================
 * THE CLASS THIS CLOSES
 * =============================================================================
 * The Command backend had TWO ways to write a task: delegate to the mcp-server tool, or
 * run `UPDATE tasks SET …` against the pool. Two paths means every invariant is implemented
 * twice and stays correct only by luck, and it did not stay correct — `completed_at` and
 * the assignee TRANSITION STAMP each had to be DISCOVERED missing on one side and then
 * ported and guarded on both. `createTask` was converted first; this task
 * converted `updateTask` and `bulkUpdateStatus`.
 *
 * A comment asking the next author not to add a third is the weak version of this rule.
 * This is the strong version: a new raw task write is RED until someone states, in the
 * source, next to the statement, why it is not a field edit.
 *
 * =============================================================================
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (a past incident — state the guard's scope)
 * =============================================================================
 * EVERY `.ts` file under `mandrel-command/backend/src`, excluding `__tests__` — the same
 * tree the backend ships, walked the same way callToolWriteScopeCoverage walks it. NOT
 * "services/task.ts", which is merely where the writes happen to live today; a fourth
 * write added from a new service is exactly the shape this must catch. Verified non-empty
 * below, because a broken walk would make every assertion here vacuously green.
 *
 * IT IS THE PARSER, NOT A GREP. The population is "string and template
 * literals that contain a task-table write statement", collected with the TypeScript
 * compiler API. A grep matches the same words inside a COMMENT — and services/task.ts has
 * four such comments, each narrating a write that no longer exists — so a grep-based
 * version of this guard would report violations for prose and get deleted the first time
 * it was inconvenient.
 *
 * =============================================================================
 * THE RULE
 * =============================================================================
 * For every string/template literal containing `UPDATE tasks`, `INSERT INTO tasks` or
 * `DELETE FROM tasks`, the ONLY way to pass is a co-located marker with a REASON:
 *
 *     // task-write-path: raw-allowed — <why this is not a field edit the tool owns>
 *
 * "Co-located" means the leading comment block of the enclosing statement, or a trailing
 * comment on the same line — the same definition callToolWriteScopeCoverage uses. There is
 * deliberately no central allow-list to drift out of date.
 *
 * =============================================================================
 * WHAT THIS DOES NOT CLAIM (a past incident — verified narrow, claimed broad)
 * =============================================================================
 * It matches SQL that is written as a literal in this package. It does not and cannot
 * claim a raw write is impossible: a query string built by concatenation at runtime, or
 * assembled by a query builder, is outside what a static reader can see. It closes the
 * shape every task write in this repo has ever actually had, which is the shape the next
 * one will have too — and it fails CLOSED on anything it recognises but cannot explain.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

const SRC_ROOT = join(__dirname, '..');

/**
 * A write against the `tasks` table, as it appears inside a SQL literal. Whitespace is
 * `\s+` (not a single space) because these queries are multi-line template literals and the
 * statement is routinely split across lines.
 *
 * `UPDATE tasks` REQUIRES A FOLLOWING `SET`, and that is not a narrowing to the shapes we
 * happen to have — it is what separates SQL from ENGLISH. The first version of this regex
 * had no such requirement and immediately flagged two log strings in controllers/task.ts:
 * `'Bulk update tasks error'` and `'Failed to bulk update tasks'`. A guard that reports
 * error messages as raw SQL gets deleted the first time it is inconvenient, so
 * the discriminator is structural: an UPDATE with no SET writes nothing. `INSERT INTO` and
 * `DELETE FROM` need no such qualifier — neither is a phrase anyone writes in prose.
 */
const TASK_WRITE =
  /\bUPDATE\s+tasks\b[\s\S]*?\bSET\b|\bINSERT\s+INTO\s+tasks\b|\bDELETE\s+FROM\s+tasks\b/i;

/** Just the statement head, for a readable violation message. */
const writeHead = (matched: string): string =>
  matched.replace(/\s+/g, ' ').split(/\bSET\b/i)[0].trim() || matched.replace(/\s+/g, ' ');

/** The co-located exception, which must carry a reason after the dash. */
const MARKER = /task-write-path:\s*raw-allowed\s*(?:—|--|-)\s*(\S.*)$/m;

interface Violation {
  file: string;
  line: number;
  sql: string;
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

/** The statement the literal sits in — the node whose LEADING comments are "co-located". */
function enclosingStatement(node: ts.Node): ts.Node {
  let cur: ts.Node = node;
  while (cur.parent && !ts.isStatement(cur)) cur = cur.parent;
  return cur;
}

function coLocatedMarker(sf: ts.SourceFile, node: ts.Node): boolean {
  const full = sf.getFullText();
  const stmt = enclosingStatement(node);
  const chunks: string[] = [];
  for (const r of ts.getLeadingCommentRanges(full, stmt.getFullStart()) ?? []) {
    chunks.push(full.slice(r.pos, r.end));
  }
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const starts = sf.getLineStarts();
  chunks.push(full.slice(starts[line], starts[line + 1] ?? full.length));
  return chunks.some((c) => MARKER.test(c));
}

/**
 * THE DETECTOR — a pure function of (fileName, sourceText) so the mutation probe can run it
 * against MUTATED COPIES of the REAL file, rather than a hand-written fake that would prove
 * nothing about the real one.
 */
export function classifySource(fileName: string, text: string): Violation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const raw = node.getText(sf);
      const m = raw.match(TASK_WRITE);
      if (m && !coLocatedMarker(sf, node)) {
        violations.push({
          file: fileName,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          sql: writeHead(m[0]),
          why:
            'a raw task write: field edits must delegate to the mcp-server task_create / ' +
            'task_update / task_bulk_update tools. If this is NOT a field edit, say so with ' +
            'a co-located `// task-write-path: raw-allowed — <reason>`.',
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

const FILES = productFiles(SRC_ROOT);

// db-gate-exempt: reads SOURCE FILES off disk, opens no database connection.
describe('task field writes have ONE owner', () => {
  it('finds a NON-EMPTY population — an empty walk would pass over nothing', () => {
    // The zero-population trap. If the walker or the parser broke, every
    // assertion below would be vacuously green. Anchor on the literals actually being seen.
    const seen = FILES.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2020, true);
      let n = 0;
      const walk = (node: ts.Node): void => {
        if (
          (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
          TASK_WRITE.test(node.getText(sf))
        ) n++;
        ts.forEachChild(node, walk);
      };
      walk(sf);
      return n ? [{ f: relative(SRC_ROOT, f), n }] : [];
    });
    expect(FILES.length).toBeGreaterThan(20);
    // The two legitimate raw writes that remain (archive / un-archive). Re-home was the
    // third until punch fix round 1 delegated bulkMoveToProject to project_move_record.
    expect(seen.reduce((a, s) => a + s.n, 0)).toBeGreaterThanOrEqual(2);
    expect(seen.map((s) => s.f)).toContain('services/task.ts');
  });

  it('the two converted methods contain NO raw SQL at all', () => {
    // Direct evidence for the conversion itself, independent of the marker rule: whatever
    // else is true, these two functions must not be able to reach the table.
    const text = readFileSync(join(SRC_ROOT, 'services/task.ts'), 'utf8');
    const sf = ts.createSourceFile('services/task.ts', text, ts.ScriptTarget.ES2020, true);

    const bodyOf = (name: string): string => {
      let found: string | null = null;
      const walk = (node: ts.Node): void => {
        if (ts.isMethodDeclaration(node) && node.name.getText(sf) === name) {
          found = node.getText(sf);
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      if (found === null) {
        throw new Error(
          `TaskService.${name} was not found — this guard names it explicitly, so a rename ` +
            `must be a RED here rather than a silently skipped assertion.`
        );
      }
      return found;
    };

    for (const name of ['updateTask', 'bulkUpdateStatus']) {
      const body = bodyOf(name);
      // No write against the table…
      expect(body).not.toMatch(TASK_WRITE);
      // …and it delegates. (A method that wrote nothing at all would satisfy the line above.)
      expect(body).toContain('McpService.callTool');
    }
    expect(bodyOf('updateTask')).toContain("'task_update'");
    expect(bodyOf('bulkUpdateStatus')).toContain("'task_bulk_update'");
  });

  it('has ZERO unmarked raw task writes in the tree as it stands', () => {
    const violations = FILES.flatMap((f) =>
      classifySource(relative(SRC_ROOT, f), readFileSync(f, 'utf8'))
    );
    expect(violations.map((v) => `${v.file}:${v.line} [${v.sql}] ${v.why}`)).toEqual([]);
  });
});

/**
 * MUTATION PROBE — the detector must go RED on each way the rule can be broken, and the
 * unmutated text must be GREEN (the positive control, without which a RED proves nothing).
 * Every probe asserts the mutation LANDED first: a no-op mutation reports a perfect result.
 */
// db-gate-exempt: operates on in-memory strings, opens no database connection.
describe('MUTATION PROBE — the guard has teeth', () => {
  const REL = 'services/task.ts';
  const original = readFileSync(join(SRC_ROOT, REL), 'utf8');

  const assertLanded = (before: string, after: string, label: string): void => {
    if (after === before) {
      throw new Error(
        `mutation '${label}' did not change the source — the probe was a NO-OP, and a no-op ` +
          `probe reports a perfect result. Fix the mutation, not the assertion.`
      );
    }
  };

  it('positive control: the unmutated file is CLEAN', () => {
    expect(classifySource(REL, original)).toEqual([]);
  });

  it('RED when a THIRD raw write is added — the whole point of the guard', () => {
    const mutated = original.replace(
      '  static async deleteTask(',
      "  static async sneakyBulkArchive(ids: string[]): Promise<void> {\n" +
        "    await pool.query('UPDATE tasks SET status = $1 WHERE id = ANY($2::uuid[])', ['cancelled', ids]);\n" +
        "  }\n\n  static async deleteTask("
    );
    assertLanded(original, mutated, 'add an unmarked raw write');
    const v = classifySource(REL, mutated);
    expect(v.length).toBe(1);
    expect(v[0].sql.toUpperCase()).toBe('UPDATE TASKS');
  });

  it('RED when the delegation is torn out and the raw UPDATE put back', () => {
    // BREAK THE DELEGATION — the mutation the task asks for by name.
    const mutated = original.replace(
      "    const result = await McpService.callTool('task_update', toolArgs, actor);",
      "    const result = await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [updates.status, id]);"
    );
    assertLanded(original, mutated, 'un-delegate updateTask');
    const v = classifySource(REL, mutated);
    expect(v.length).toBe(1);
    expect(v[0].sql.toUpperCase()).toBe('UPDATE TASKS');
  });

  it('RED when a marker is STRIPPED from one of the three allowed raw writes', () => {
    const mutated = original.replace(/^\s*\/\/ task-write-path: raw-allowed.*$/m, '');
    assertLanded(original, mutated, 'strip one raw-allowed marker');
    expect(classifySource(REL, mutated).length).toBeGreaterThan(0);
  });

  it('RED when a marker is present but carries NO reason', () => {
    // A bare marker is the laundering move: it looks like a stated exception and states
    // nothing. The rule requires text after the dash, so this must NOT pass.
    const mutated = original.replace(
      /\/\/ task-write-path: raw-allowed — ARCHIVE[\s\S]*?unnoticed one\./,
      '// task-write-path: raw-allowed —'
    );
    assertLanded(original, mutated, 'blank the marker reason');
    expect(mutated).toContain('// task-write-path: raw-allowed —\n');
    expect(classifySource(REL, mutated).length).toBeGreaterThan(0);
  });

  it('a marker three functions away does NOT count (co-location is enforced)', () => {
    const stripped = original.replace(/^\s*\/\/ task-write-path: raw-allowed.*$/gm, '');
    const mutated =
      '// task-write-path: raw-allowed — a blanket blessing at the top of the file\n' + stripped;
    assertLanded(original, mutated, 'move every marker to the file header');
    // 2 raw writes (archive / un-archive), none of them co-located with the header comment.
    expect(classifySource(REL, mutated).length).toBe(2);
  });

  it('GREEN on an ENGLISH string containing "update tasks" (the measured false positive)', () => {
    // controllers/task.ts really does log 'Bulk update tasks error'. Pinned here so a future
    // sharpening of the regex cannot quietly reintroduce the cry-wolf.
    const mutated =
      "const msg = 'Failed to bulk update tasks';\nconst msg2 = 'Bulk update tasks error';\n" +
      original;
    assertLanded(original, mutated, 'add English strings mentioning update tasks');
    expect(classifySource(REL, mutated)).toEqual([]);
  });

  it('GREEN on a comment that merely MENTIONS a raw write (why this is a parser)', () => {
    // services/task.ts narrates deleted writes in prose. A grep-based guard would flag
    // those and be deleted for crying wolf; the parser never sees them.
    const mutated =
      '// A history note: this file used to run DELETE FROM tasks and UPDATE tasks directly.\n' +
      original;
    assertLanded(original, mutated, 'add prose mentioning a raw write');
    expect(classifySource(REL, mutated)).toEqual([]);
  });
});
