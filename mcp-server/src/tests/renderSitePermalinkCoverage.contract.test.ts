/**
 * RENDER-SITE PERMALINK COVERAGE — the population is the RENDER SITES, not the type array.
 * an earlier task (follows 31dd078e).
 *
 * =============================================================================
 * WHAT WENT WRONG, AND WHY NO EXISTING GUARD COULD HAVE CAUGHT IT
 * =============================================================================
 * `commandUrlConfig.unit.test.ts` guards the CROSS-BOUNDARY PARITY of two type
 * ENUMERATIONS: mcp-server's `RESOLVABLE_RECORD_TYPES` against the Command UI resolver's
 * own list. That guard is correct and stays. But a type being *declared* resolvable does
 * nothing on its own — there is no central annotator in this codebase. A permalink is a
 * PER-RENDER-SITE edit (`${formatRecordRef(x.id)}` appended to the rendered text).
 *
 * So on 2026-08-06 `project.routes.ts` and `session.routes.ts` shipped with ZERO permalink
 * emissions while every other id-rendering route file had between 1 and 5 — `project_info`
 * printed a bare uuid — and the parity guard was green the whole time, because the render
 * sites were not in ANY guard's population. Measured at the real surface, not inferred:
 *   project_info(riverbend) -> "🆔 ID: <uuid>"   has /r/ permalink: False
 *
 * That is the `guards-need-guarding` shape one layer out: the guard's population (two type
 * arrays) was narrower than reality (fourteen route files). This file adds the missing
 * population.
 *
 * =============================================================================
 * THE POPULATION THIS FILE ENUMERATES, AND WHY IT IS THE WHOLE ONE
 * =============================================================================
 * EVERY `.ts` file under `src/routes/`, AT ANY DEPTH — read off the directory, not a list
 * typed here (see `deriveRouteFiles`: it recurses, and the first cut of it did not, which is
 * the nit that produced this sentence). That directory is the whole set of MCP route modules;
 * a tool result reaching a user is rendered by one of these files or it is not rendered at
 * all. The ledger below then classifies each
 * file as emitting permalinks or not, WITH A WRITTEN REASON, and both halves are asserted:
 * an emitter that stops emitting is RED, and a declared non-emitter that starts emitting is
 * also RED (it must be reclassified deliberately, which is a one-line diff plus a reason).
 *
 * THE CHOKE POINT is `${formatRecordRef(` — the template interpolation. Every user-visible
 * Mandrel permalink in this codebase goes through it (`commandUrlConfig.ts` is the single
 * source; the id8 + base URL live nowhere else). It is deliberately NOT "the file mentions
 * formatRecordRef", because an `import { formatRecordRef }` line ALONE would satisfy that —
 * an assertion satisfiable by something other than the thing it names. `blankNonCode()`
 * removes imports, comments and string literals before counting, and Part D probes exactly
 * that hole with a fabricated import-only corpus.
 *
 * =============================================================================
 * THE THREE-PART SHAPE — derivation alone is a DOWNGRADE
 * =============================================================================
 *   1. DERIVE   — Part A reads the population off the filesystem, so a new route file
 *                 cannot be silently outside the guard.
 *   2. SNAPSHOT — the hand-written ledger. The only thing that can catch the DERIVATION
 *                 being wrong (a bad glob, a moved directory, a renamed file). If the two
 *                 disagree in either direction, this file is RED.
 *   3. CARDINALITY — explicit non-empty / minimum-count assertions. An empty population is
 *                 the value that slips through: a `forEach` over `[]` passes having tested
 *                 nothing. Probed for real in Part D.
 *
 * FAIL-CLOSED, asserted rather than hoped: a renamed/absent routes directory makes
 * `deriveRouteFiles` THROW (Part D), an emptied one fails the cardinality assertions
 * (Part D), and a moved/renamed file fails the snapshot (Part A).
 *
 * PART D is the guard guarding itself: every analyzer here is a pure function over a source
 * string, so it is fed FABRICATED corpora — empty, import-only, comment-only, string-literal
 * only, correct — and each classification is asserted. A product mutation going RED does not
 * prove the analyzer works; zero/empty/absent are the values that slip through.
 *
 * NO DB, NO NETWORK. Pure source analysis + one config import.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { RESOLVABLE_RECORD_TYPES } from '../config/commandUrlConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(__dirname, '../routes');

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE ANALYZERS — pure over a source string, so Part D can attack them directly
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * DERIVE the population: every `.ts` module under `dir`, AT ANY DEPTH, as a path relative to
 * `dir` (POSIX-separated, e.g. `nav/nav.routes.ts`).
 *
 * FAIL-CLOSED #1: throws (ENOENT) if `dir` does not exist — a renamed/moved routes directory
 * is a RED, never a silent pass over nothing.
 *
 * FAIL-CLOSED #2 — WHY THIS RECURSES (Reviewer nit). The first cut used a
 * non-recursive `readdirSync` + `.endsWith('.ts')` while the header above claimed "EVERY .ts
 * file in src/routes/". A subdirectory is not a `.ts` NAME, so it was silently dropped: it
 * never entered `derived`, the ledger still matched 14/14, and everything passed. A future
 * `src/routes/nav/nav.routes.ts` would have rendered ids ENTIRELY OUTSIDE this guard's
 * population — the exact `guards-need-guarding` shape this file exists to close, one level
 * down, with the population narrower than the sentence describing it.
 *
 * Recursing rather than asserting flatness is the deliberate choice: a legitimate
 * subdirectory must be CLASSIFIED (one ledger line plus a reason), not BANNED. A guard that
 * forbids correct work gets deleted the first time it is inconvenient.
 *
 * The routes tree is flat TODAY — asserted in Part A, so the claim is measured rather than
 * remembered — but the derivation no longer depends on it staying flat.
 */
export function deriveRouteFiles(dir: string): string[] {
  const walk = (abs: string, prefix: string): string[] =>
    readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) return walk(join(abs, entry.name), rel);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [rel] : [];
    });
  return walk(dir, '').sort();
}

/** Subdirectories directly under `dir` — measured, so Part A can assert the tree's shape. */
export function routeSubdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Blank out everything that is NOT executable code — comments, imports, and string/template
 * literal CONTENT — replacing each with spaces so offsets are preserved.
 *
 * This is what makes the emission count mean "a call site", not "the token appears somewhere
 * in the file". Without it, a bare `import { formatRecordRef } from ...` would satisfy the
 * coverage assertion for a file that renders nothing (the incidental-pass class). Template
 * literals are handled specially: their `${...}` interpolations ARE code and are kept, since
 * `${formatRecordRef(x)}` is precisely the construct being counted.
 */
export function blankNonCode(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j++;
        j++;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      // Walk the template, blanking literal text but LEAVING `${ ... }` interpolations intact.
      let j = i + 1;
      blank(i, i + 1);
      while (j < source.length) {
        if (source[j] === '\\') {
          blank(j, j + 2);
          j += 2;
          continue;
        }
        if (source[j] === '`') {
          blank(j, j + 1);
          j++;
          break;
        }
        if (source[j] === '$' && source[j + 1] === '{') {
          // Keep the interpolation; skip to its matching close brace.
          let depth = 1;
          let k = j + 2;
          while (k < source.length && depth > 0) {
            if (source[k] === '{') depth++;
            else if (source[k] === '}') depth--;
            else if (source[k] === '`') {
              // A nested template inside the interpolation — recurse by blanking it in place.
              const nested = blankNonCode(source.slice(k));
              for (let n = 0; n < nested.length; n++) out[k + n] = nested[n];
              // Advance past the nested template's closing backtick.
              let d2 = 0;
              let m = k + 1;
              while (m < source.length) {
                if (source[m] === '\\') { m += 2; continue; }
                if (source[m] === '`' && d2 === 0) break;
                m++;
              }
              k = m;
            }
            k++;
          }
          j = k;
          continue;
        }
        blank(j, j + 1);
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }

  // Drop import statements wholesale — an import is a declaration, never a render site.
  return out
    .join('')
    .split('\n')
    .map((line) => (/^\s*import\s/.test(line) || /^\s*}\s*from\s/.test(line) ? '' : line))
    .join('\n');
}

/** The one construct every user-visible Mandrel permalink in a route's TEXT goes through. */
const PERMALINK_EMISSION = /\$\{\s*formatRecordRef\s*\(/g;

/**
 * Count REAL permalink emissions in a route source: `${formatRecordRef(...)}` inside rendered
 * text. Imports, comments and inert string literals are removed first (see `blankNonCode`).
 */
export function countPermalinkEmissions(source: string): number {
  return (blankNonCode(source).match(PERMALINK_EMISSION) ?? []).length;
}

const readRoute = (file: string): string => readFileSync(join(ROUTES_DIR, file), 'utf8');

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE HAND-WRITTEN SNAPSHOT — part 2 of the three-part shape
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

interface RouteLedgerEntry {
  /** Does this file render a Mandrel record id into user-visible TEXT? */
  readonly emitsPermalinks: boolean;
  /** WHY. A `false` here is an exception with a reason, not an oversight. */
  readonly why: string;
}

/**
 * EVERY route module, classified. Hand-written on purpose: this is the only thing that can
 * catch `deriveRouteFiles` being wrong, and it forces whoever ADDS a route module to answer
 * "does it render a record id?" rather than inheriting silence.
 *
 * The four `false` entries were each checked against the file (2026-08-06):
 * none of them renders a Mandrel record id into a tool RESULT.
 */
const ROUTE_LEDGER: Readonly<Record<string, RouteLedgerEntry>> = Object.freeze({
  'artifact.routes.ts': { emitsPermalinks: true, why: 'renders artifact-linked record ids' },
  // WS1 MACHINE-LEAN (D2): READ/list/search text no longer carries per-row
  // permalink lines — each structured row carries `url` instead (recordPermalinks.contract
  // asserts both directions). The WRITE acks below keep their single text permalink.
  'context.routes.ts': { emitsPermalinks: true, why: 'renders the created context id (store ack); read surfaces carry url in structuredContent only' },
  'decisions.routes.ts': { emitsPermalinks: true, why: 'renders the recorded decision id (record ack); read surfaces carry url in structuredContent only' },
  'links.routes.ts': { emitsPermalinks: true, why: 'renders both endpoints of a typed edge' },
  'project.routes.ts': { emitsPermalinks: true, why: 'renders project ids on the create/update acks; info/list are machine-lean reads' },
  'recall.routes.ts': { emitsPermalinks: false, why: 'WS1 machine-lean read surface — every structured node carries url = recordUrl(id); the text channel renders no permalink lines' },
  'search.routes.ts': { emitsPermalinks: false, why: 'WS1 machine-lean read surface — resolvable structured rows carry url = recordUrl(id); the text channel renders no permalink lines' },
  'session.routes.ts': { emitsPermalinks: true, why: 'renders session ids (start/end/status/get/list/pin)' },
  'tasks.routes.ts': { emitsPermalinks: true, why: 'renders the created task id (create ack); read surfaces carry url in structuredContent only' },
  // PHASE 1: branch.routes renders the spine id; thread.routes became a
  // pure WARN-and-delegate alias layer — its text is the deprecation prefix plus the
  // delegated branch.routes response, so IT renders no record id of its own.
  'branch.routes.ts': { emitsPermalinks: true, why: 'renders the branch spine id' },
  'thread.routes.ts': { emitsPermalinks: false, why: 'deprecated aliases — all rendering is delegated to branch.routes.ts' },

  'gateway.ts': {
    emitsPermalinks: false,
    why: 'action dispatcher — it forwards to the gateways above and renders no record of its own',
  },
  'index.ts': {
    emitsPermalinks: false,
    // NAME THE CONSTRUCT, NOT THE COORDINATES (Reviewer nit): this reason
    // originally cited `(:213, :232)`. Both were accurate and were really checked — but a
    // line number rots on the next edit to that file, and a ledger whose whole value is that
    // its reasons are trustworthy cannot afford a reason that quietly becomes false.
    why: 'route registry + the lazy-session gate. Its only session ids are arguments to logger.info inside the lazy-session gate, never into a tool result',
  },
  'system.routes.ts': {
    emitsPermalinks: false,
    why: 'ping/status/help — renders process + tool metadata, no record ids',
  },
});

/**
 * The five NAV record types the `/r/:id` resolver serves, mapped to the route module that
 * OWNS each one's render sites. Hand-written; the assertion below ties it back to the
 * product's own `RESOLVABLE_RECORD_TYPES`, so a SIXTH resolvable type with no declared
 * render site is a RED here rather than a silent hole.
 */
const RECORD_TYPE_OWNING_ROUTE: Readonly<Record<string, string>> = Object.freeze({
  context: 'context.routes.ts',
  task: 'tasks.routes.ts',
  decision: 'decisions.routes.ts',
  session: 'session.routes.ts',
  project: 'project.routes.ts',
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART A — the derived population vs the snapshot, and the cardinality floor
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('render-site permalink coverage — PART A: the population', () => {
  const derived = deriveRouteFiles(ROUTES_DIR);
  const ledgerFiles = Object.keys(ROUTE_LEDGER).sort();

  test('the derived population is NON-EMPTY and meets its cardinality floor', () => {
    // The empty population is what slips through: every per-file assertion below is inside a
    // loop, and a loop over [] is green having checked nothing. Asserted, not assumed.
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.length).toBeGreaterThanOrEqual(14);
    expect(ledgerFiles.length).toBe(derived.length);
  });

  test('the routes tree is FLAT today — measured, so the ledger keys mean what they look like', () => {
    // Not a rule, a MEASUREMENT. The derivation recurses, so a subdirectory is handled
    // correctly either way; this exists so the bare filenames in the ledger are known to be
    // the whole story rather than assumed to be.
    expect(
      routeSubdirectories(ROUTES_DIR),
      'A subdirectory appeared under src/routes/. Nothing is broken and nothing needs to be ' +
        'moved: deriveRouteFiles recurses, so its modules are ALREADY in the population as ' +
        'e.g. "nav/nav.routes.ts". Add a ledger entry for each one (that relative path as the ' +
        'key) with a written reason, then update this expectation to name the new directory.'
    ).toEqual([]);
  });

  test('the DERIVED population matches the HAND-WRITTEN ledger, both directions', () => {
    // A new route module lands in `derived` but not the ledger -> RED (classify it).
    // A renamed/moved/deleted module lands in the ledger but not `derived` -> RED.
    expect(derived).toEqual(ledgerFiles);
  });

  test('the ledger has both populations — emitters AND reasoned exceptions', () => {
    const emitters = ledgerFiles.filter((f) => ROUTE_LEDGER[f].emitsPermalinks);
    const exceptions = ledgerFiles.filter((f) => !ROUTE_LEDGER[f].emitsPermalinks);
    // WS1: recall + search flipped to reasoned exceptions (machine-lean
    // read surfaces), so the emitter floor is the 8 files with write-ack/session renders.
    expect(emitters.length).toBeGreaterThanOrEqual(8);
    expect(exceptions.length).toBeGreaterThanOrEqual(1);
    // Every exception carries a written reason — never a bare `false`.
    for (const f of exceptions) expect(ROUTE_LEDGER[f].why.trim().length).toBeGreaterThan(20);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART B — the actual guarantee: an id-rendering route EMITS a permalink
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('render-site permalink coverage — PART B: every render site emits a ref line', () => {
  const emitters = Object.keys(ROUTE_LEDGER)
    .filter((f) => ROUTE_LEDGER[f].emitsPermalinks)
    .sort();
  const exceptions = Object.keys(ROUTE_LEDGER)
    .filter((f) => !ROUTE_LEDGER[f].emitsPermalinks)
    .sort();

  test('the two sub-populations are non-empty (a loop over [] proves nothing)', () => {
    expect(emitters.length).toBeGreaterThan(0);
    expect(exceptions.length).toBeGreaterThan(0);
  });

  test.each(emitters)('%s emits at least one ${formatRecordRef(...)} render', (file) => {
    // NOT "the file mentions formatRecordRef" — an import alone would satisfy that. This
    // counts CALL SITES inside rendered text; see blankNonCode + Part D.
    expect(countPermalinkEmissions(readRoute(file))).toBeGreaterThanOrEqual(1);
  });

  test.each(exceptions)('%s emits none — and must be RECLASSIFIED if that changes', (file) => {
    // The other direction of the ledger. If someone adds a permalink here, the honest fix is
    // to flip `emitsPermalinks` and write the reason, not to leave the classification lying.
    expect(countPermalinkEmissions(readRoute(file))).toBe(0);
  });

  test('project + session are covered — the two files this task exists for', () => {
    // The literal regression. Named explicitly so a future ledger edit that quietly drops
    // them cannot pass; the generated cases above would simply stop existing. (WS1 an earlier task
    // moved project's read-surface permalinks to structuredContent, so its floor
    // is its two WRITE acks — create + update.)
    expect(countPermalinkEmissions(readRoute('project.routes.ts'))).toBeGreaterThanOrEqual(2);
    expect(countPermalinkEmissions(readRoute('session.routes.ts'))).toBeGreaterThanOrEqual(7);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART C — the type layer: every resolvable record type has an emitting render site
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('render-site permalink coverage — PART C: resolvable type -> emitting route', () => {
  test('every declared resolvable record type has an OWNING route module', () => {
    // Ties the render-site population back to the product's own type enumeration. A sixth
    // entry in RESOLVABLE_RECORD_TYPES with no owning route is a RED here — which is the
    // check that was missing when 'session'/'project' were declared resolvable while their
    // render sites emitted nothing.
    for (const type of RESOLVABLE_RECORD_TYPES) {
      expect(Object.keys(RECORD_TYPE_OWNING_ROUTE)).toContain(type);
    }
    expect(RESOLVABLE_RECORD_TYPES.length).toBeGreaterThanOrEqual(3);
  });

  test.each(Object.entries(RECORD_TYPE_OWNING_ROUTE))(
    '%s ids are rendered by %s, which is a ledger EMITTER and actually emits',
    (_type, file) => {
      expect(ROUTE_LEDGER[file]).toBeDefined();
      expect(ROUTE_LEDGER[file].emitsPermalinks).toBe(true);
      expect(countPermalinkEmissions(readRoute(file))).toBeGreaterThanOrEqual(1);
    }
  );

  test('the type->route map is non-empty and covers the five NAV types', () => {
    const types = Object.keys(RECORD_TYPE_OWNING_ROUTE).sort();
    expect(types.length).toBeGreaterThanOrEqual(5);
    expect(types).toEqual(['context', 'decision', 'project', 'session', 'task']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART D — the guard guarding itself (fail-closed + the incidental-pass hole)
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('render-site permalink coverage — PART D: the guard guards itself', () => {
  test('FAIL CLOSED: a renamed/absent routes directory THROWS, it does not return []', () => {
    // If this returned [] the whole file would go green over an empty population — the exact
    // failure mode this part exists to make unreachable.
    expect(() => deriveRouteFiles(join(ROUTES_DIR, '__no_such_dir__'))).toThrow();
  });

  test('FAIL CLOSED: a NESTED route module is IN the population (the nit that was found)', () => {
    // The probe the original derivation would have failed. A fabricated tree, because the
    // real one is flat — and "it is flat today" is exactly the reasoning that let a
    // non-recursive readdir look correct. Assert the capability, not the current shape.
    const fixture = mkdtempSync(join(tmpdir(), 'render-site-nested-'));
    try {
      mkdirSync(join(fixture, 'nav'));
      writeFileSync(join(fixture, 'top.routes.ts'), '// top\n');
      writeFileSync(join(fixture, 'nav', 'nav.routes.ts'), '// nested\n');
      writeFileSync(join(fixture, 'nav', 'notes.md'), 'not a module\n');
      mkdirSync(join(fixture, 'nav', 'deep'));
      writeFileSync(join(fixture, 'nav', 'deep', 'deep.routes.ts'), '// deeper\n');

      const found = deriveRouteFiles(fixture);
      expect(found).toEqual(['nav/deep/deep.routes.ts', 'nav/nav.routes.ts', 'top.routes.ts']);

      // And the CONTROL for the bug itself: the old non-recursive derivation saw only the
      // top-level file, so a nested route module was invisible to the whole guard.
      const nonRecursive = readdirSync(fixture).filter((f) => f.endsWith('.ts')).sort();
      expect(nonRecursive).toEqual(['top.routes.ts']);
      expect(found.length).toBeGreaterThan(nonRecursive.length);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('FAIL CLOSED: a nested module absent from the ledger fails the snapshot', () => {
    // The consequence of the fix: being IN the population is only useful if an unclassified
    // member is RED. Simulated against the real ledger keys.
    const withNested = [...Object.keys(ROUTE_LEDGER), 'nav/nav.routes.ts'].sort();
    expect(() => expect(withNested).toEqual(Object.keys(ROUTE_LEDGER).sort())).toThrow();
  });

  test('FAIL CLOSED: an EMPTY population fails the cardinality assertions', () => {
    const empty: string[] = [];
    // Written as the assertions Part A makes, run against the degenerate input, so the two
    // cannot drift: if Part A ever loses its floor, this stops describing it.
    expect(() => expect(empty.length).toBeGreaterThan(0)).toThrow();
    expect(() => expect(empty.length).toBeGreaterThanOrEqual(14)).toThrow();
  });

  test('FAIL CLOSED: a PARTIAL population fails the snapshot comparison', () => {
    const partial = Object.keys(ROUTE_LEDGER).sort().slice(0, -1);
    expect(() => expect(partial).toEqual(Object.keys(ROUTE_LEDGER).sort())).toThrow();
  });

  test('INCIDENTAL PASS: an import line alone does NOT count as an emission', () => {
    // The hole this analyzer exists to close. `grep -c formatRecordRef` would return 1 here.
    const importOnly = `import { formatRecordRef } from '../config/commandUrlConfig.js';\n` +
      `export const x = 1;\n`;
    expect(importOnly).toContain('formatRecordRef');
    expect(countPermalinkEmissions(importOnly)).toBe(0);
  });

  test('INCIDENTAL PASS: a multi-line import block does NOT count as an emission', () => {
    const block = `import {\n  formatRecordRef,\n  recordUrl,\n} from '../config/commandUrlConfig.js';\n`;
    expect(countPermalinkEmissions(block)).toBe(0);
  });

  test('INCIDENTAL PASS: a commented-out call does NOT count as an emission', () => {
    expect(countPermalinkEmissions(`// text = \`\${formatRecordRef(x.id)}\`;\n`)).toBe(0);
    expect(countPermalinkEmissions(`/* \${formatRecordRef(x.id)} */\n`)).toBe(0);
  });

  test('INCIDENTAL PASS: the token inside an inert string literal does NOT count', () => {
    expect(countPermalinkEmissions(`const doc = "call \${formatRecordRef(id)} here";\n`)).toBe(0);
  });

  test('INCIDENTAL PASS: a non-interpolated call in dead code does NOT count', () => {
    // `recordUrl(x)` in structuredContent is a permalink too, but it is NOT the user-visible
    // TEXT guarantee this file owns; counting it would let a file satisfy the text assertion
    // without rendering anything a human can click.
    expect(countPermalinkEmissions(`const u = recordUrl(task.id);\n`)).toBe(0);
  });

  test('the CONTROL is GREEN: a real render site DOES count', () => {
    const real = `import { formatRecordRef } from '../config/commandUrlConfig.js';\n` +
      `const text = \`🆔 ID: \${task.id}\\n\${formatRecordRef(task.id)}\`;\n`;
    expect(countPermalinkEmissions(real)).toBe(1);
  });

  test('the CONTROL is GREEN on the real exemplar: the task_create ack is counted', () => {
    // Anchors the analyzer to the shipped house pattern rather than to a fixture I wrote.
    // (WS1 tasks.routes' one remaining text permalink is the create ack.)
    expect(countPermalinkEmissions(readRoute('tasks.routes.ts'))).toBeGreaterThanOrEqual(1);
  });

  test('MUTATION SIM: deleting the emissions from a route source makes the count 0', () => {
    // The mutation the product probe performs, run here in-memory so the property is pinned
    // even when nobody is hand-mutating the tree.
    const mutated = readRoute('project.routes.ts').replace(/\$\{formatRecordRef\(/g, '${(');
    expect(countPermalinkEmissions(mutated)).toBe(0);
    expect(countPermalinkEmissions(readRoute('project.routes.ts'))).toBeGreaterThan(0);
  });
});
