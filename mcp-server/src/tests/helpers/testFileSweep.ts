/**
 * The population both port guards sweep: every test file under the repo's test roots.
 *
 * WHY THIS IS A HELPER AND NOT AN EXPORT FROM ONE OF THE GUARDS:
 * `hardcodedTestPorts.contract.test.ts` first imported this walk directly from
 * `reservedTestPorts.contract.test.ts`. That works, and it also EXECUTES that module —
 * so the sibling guard's nine tests were re-registered inside the importer and ran twice
 * per suite (measured: the importer reported 19 tests where it defines 10). Worse, a
 * failure in either guard then failed both, which destroys attribution. A test file is
 * not an importable library; the shared thing belongs in a helper.
 *
 * A second copy of the walk in each guard would be the other wrong answer: the two scopes
 * could drift apart silently, one quietly stopping at a directory while both kept
 * reporting a clean sweep. The same reasoning now applies to stripComments below, which
 * a second text-scanning guard needed.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Roots scanned for test files. */
export const SCAN_ROOTS = ['mcp-server/src', 'mandrel-command'];

const TEST_FILE_RE = /\.test\.(ts|tsx|js|jsx|mts|cts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/** Every test file under a scan root. */
export function collectTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (TEST_FILE_RE.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Replace every comment with spaces, preserving newlines so line numbers stay exact.
 * Handles `//` to end-of-line and block comments.
 *
 * Comments are stripped by the text guards deliberately rather than lazily: a port or a
 * database name mentioned in PROSE binds nothing and connects to nothing, and forcing
 * annotations onto doc comments buys churn and no safety.
 *
 * A `//` PRECEDED BY `:` is a URL scheme, not a comment. Without that clause the stripper
 * ate `http://127.0.0.1:19097` and the URL-authority pattern in hardcodedTestPorts could
 * never fire on real code — a detector structurally unable to report one of the three
 * spellings it advertises. Its own teeth test caught it.
 *
 * Not a full JS lexer: a `//` inside a string literal is treated as a comment start. That
 * direction of error makes a guard MISS things, never invent them — stated here rather
 * than left to be discovered.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let state: 0 | 1 | 2 = 0; // 0 code, 1 line comment, 2 block comment
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === 0) {
      if (c === '/' && n === '/' && text[i - 1] !== ':') { state = 1; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 2; out += '  '; i += 2; continue; }
      out += c; i++; continue;
    }
    if (state === 1) {
      if (c === '\n') { state = 0; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    if (c === '*' && n === '/') { state = 0; out += '  '; i += 2; continue; }
    out += c === '\n' ? '\n' : ' ';
    i++;
  }
  return out;
}
