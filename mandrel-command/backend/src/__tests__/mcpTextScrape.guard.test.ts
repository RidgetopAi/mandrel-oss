/**
 * GUARD: no backend consumer may read the MCP prose text channel.
 *
 * THE CLASS THIS STOPS (instance four): reading a MACHINE fact out of a HUMAN
 * rendering. Three instances landed in one day (2026-07-30): the ANSI-poisoned CI
 * regex (fixed 40af00d), the decision read model, and this backend's
 * six text parsers (deleted by an earlier task). Every number those parsers scraped is
 * carried by the structured channel (`data` sibling or `structuredContent`, which the
 * bridge guarantees on every response). A rendered string is a representation the
 * renderer is free to change; scraping it re-couples the UI's numbers to prose
 * wording with no gate in between.
 *
 * CHOKE POINT: to scrape MCP prose you must first OBTAIN it, and the only place it
 * exists is the response's `content[0].text` block. So the guard bans the ACCESSOR,
 * not the regexes — you cannot scrape text you never read. This catches a scrape
 * whatever shape the extraction takes (match/exec/split/includes/slice), which a
 * regex-shaped ban would not (never narrow the pattern to remembered
 * shapes).
 *
 * POPULATION (why it is the whole one — C3): every `*.ts` file under `backend/src`,
 * enumerated by a live recursive walk at test time, minus `*.test.ts`. backend/src IS
 * the entire set of code that can consume an McpService response in this package —
 * routes, controllers, services, middleware all live under it, and new files join the
 * walk automatically. Test files are excluded because a test that mentions
 * `content[0].text` is building or asserting on its OWN stub fixture, not consuming
 * the live channel; banning that would outlaw the very fixtures the contract tests
 * (and this guard's mutation probe) need — a guard that blocks correct work gets
 * deleted (C3 corollary).
 *
 * EXCEPTIONS: a co-located marker on the accessor's line or the line above —
 *   // mcp-text-passthrough-allowed: <non-empty reason>
 * A marker only covers VERBATIM passthrough of the prose as an opaque string (e.g.
 * surfacing the tool's human error message, or McpService's legacy text fallback).
 * It never covers extracting a field. Co-located marker with a written reason, never
 * a central allow-list.
 *
 * KNOWN-MISSES (accepted): this is a LINE-based lexical guard; it
 * catches every single-expression spelling of the accessor (dot, optional-chaining,
 * bracket-quoted `["text"]`/`['text']`, and `.at(0)`), but it cannot follow
 * DATAFLOW. Two shapes are known to slip through:
 *   - destructuring:          `const [{ text }] = res.content;`
 *                             `const { text } = res.content[0];`
 *   - intermediate variable:  `const block = res.content[0]; ... block.text`
 * Catching those requires AST/type-directed analysis (an ESLint rule over the
 * TypeScript program), which is a different instrument than a source grep. The miss
 * is accepted because (a) every scrape DELETED by the text-scrape removal used the direct-accessor
 * shape, (b) the split forms are conspicuous in review precisely because they take
 * two lines to do what one banned line would, and (c) a half-strength lexical guard
 * that runs on every test invocation beats an AST guard that never ships. If a
 * dataflow-shaped scrape ever lands, upgrade this to an ESLint rule rather than
 * widening the regex again.
 */
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');

/**
 * The accessor for the MCP prose channel, whitespace/optional-chaining tolerant.
 * Element step: `[0]` / `?.[0]` / `.at(0)` / `?.at(0)` / `.at?.(0)`.
 * Field step:   `.text` / `?.text` / `["text"]` / `['text']` / `?.["text"]`.
 * Covered spellings include:
 *   content[0].text · content[0]?.text · content?.[0]?.text · content [0] . text
 *   content[0]["text"] · content[0]['text'] · content.at(0).text · content?.at(0)?.text
 */
const TEXT_CHANNEL_ACCESSOR =
  /\bcontent\s*(?:(?:\?\s*\.)?\s*\[\s*0\s*\]|(?:\?\s*)?\.\s*at\s*(?:\?\s*\.)?\s*\(\s*0\s*\))\s*(?:(?:\?\s*)?\.\s*text\b|(?:\?\s*\.)?\s*\[\s*(?:'text'|"text")\s*\])/;

const EXCEPTION_MARKER = /mcp-text-passthrough-allowed:\s*\S+/;

/**
 * Floor on the walked population. backend/src held 150+ .ts files when this guard
 * shipped; if the walk ever returns fewer than this, the guard is inspecting the
 * wrong directory (or an empty one) and must fail RED as could-not-measure rather
 * than report a hollow green (C1: never map "could not measure" onto "no").
 */
const MIN_EXPECTED_FILES = 50;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('MCP prose channel is machine-opaque (guard)', () => {
  const files = walk(SRC_ROOT);

  it(`walks the real population (>= ${MIN_EXPECTED_FILES} source files under backend/src)`, () => {
    // Empty/absent population probe: a walk of the wrong root would pass a bare
    // "no violations" assertion vacuously. Refuse to report green on a population
    // that cannot be the real one.
    expect(files.length).toBeGreaterThanOrEqual(MIN_EXPECTED_FILES);
  });

  it('no non-test source file reads content[0].text without a co-located passthrough marker', () => {
    const violations: string[] = [];

    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!TEXT_CHANNEL_ACCESSOR.test(line)) return;
        const prev = i > 0 ? lines[i - 1] : '';
        if (EXCEPTION_MARKER.test(line) || EXCEPTION_MARKER.test(prev)) return;
        violations.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }

    expect({
      help:
        'These lines read the MCP prose text channel. Machine facts must come from ' +
        'the structured channel (`data` / `structuredContent`) — see services/mcp.ts. ' +
        'If this is a VERBATIM passthrough of the prose as an opaque string (no field ' +
        'extraction), mark the line (or the line above) with ' +
        '`// mcp-text-passthrough-allowed: <reason>`.',
      violations,
    }).toEqual({ help: expect.any(String), violations: [] });
  });
});
