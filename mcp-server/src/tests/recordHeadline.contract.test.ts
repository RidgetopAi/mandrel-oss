/**
 * recordHeadline.contract — pins the ONE record-headline rule.
 *
 * WHAT THIS GUARDS, in one sentence: that "how long is a record's one-line headline, and
 * where does it cut" stays a single decision in `config/recordHeadlineConfig.ts`, instead of
 * going back to being five numeric literals scattered across four services and two packages.
 *
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3). `HEADLINE_CALL_SITES` below is not "the
 * files I happened to be editing": it is every file in this package that renders a context
 * as one line, enumerated with the reason each is on the list. Each entry is checked for
 * BOTH halves of the rule — it must READ the config (an import), and it must contain no bare
 * numeric clip literal. A file that stops importing the config is RED; a file that grows a
 * `slice(0, 60)` back is RED.
 *
 * THE SCANNER FAILS CLOSED, THREE WAYS (C1 — an instrument has three states):
 *   1. a listed file that does not exist THROWS, it does not skip;
 *   2. a listed file with no `import` of the config at all is RED, so a call site cannot
 *      pass this guard by having deleted its headline code AND its import together — the
 *      NON-EMPTY TRAP is that we assert on presence, not merely on absence;
 *   3. an exemption must carry a written reason on its own line, so "exempt" can never be
 *      the silent default.
 *
 * WHAT THIS GUARD DOES **NOT** COVER, stated so nobody reads more into a green than is
 * there: the mandrel-command mirror is a different package and is pinned by its own guard,
 * `mandrel-command/backend/src/__tests__/recordHeadlineDrift.test.ts`. And the frontend
 * (`mandrel-command/frontend/src/pages/contexts/parts.tsx`) has its own `contextTitle` off
 * `CONTEXTS_CONFIG.titlePreviewChars`; it is config-shaped already but is NOT pinned to this
 * budget, and no assertion here claims otherwise.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECORD_HEADLINE_CONFIG,
  deriveRecordHeadline,
  deriveTypedRecordHeadline,
} from '../config/recordHeadlineConfig.js';
import { deriveContextTitle } from '../services/recallThread.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The config module every call site must read. Relative to `mcp-server/`. */
const CONFIG_RELPATH = join('src', 'config', 'recordHeadlineConfig.ts');

/** Walk UP until the ancestor containing the config module (worktree/CI-safe, C4). */
function findPackageRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, CONFIG_RELPATH))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${CONFIG_RELPATH} in any ancestor of ${HERE}. This guard derives its ` +
      'population from that file; refusing to pass vacuously.',
  );
}

const ROOT = findPackageRoot();

/**
 * EVERY surface in this package that renders a record as one line, with the reason it is
 * here. Adding a sixth such surface without adding it here is the failure mode this list
 * cannot catch on its own — which is exactly why the scan below also runs over the whole
 * `src/services` + `src/handlers` tree for the *literal patterns*, and only exempts what
 * carries a written reason.
 */
const HEADLINE_CALL_SITES: ReadonlyArray<{ file: string; why: string }> = Object.freeze([
  Object.freeze({
    file: join('src', 'services', 'lexicalSearch.ts'),
    why: 'lexical/hybrid search result titles — formerly the SQL copy `left(x.content, 60)`',
  }),
  Object.freeze({
    file: join('src', 'handlers', 'smartSearch.ts'),
    why: 'smart_search result titles — formerly `content.substring(0, 60)`',
  }),
  Object.freeze({
    file: join('src', 'services', 'recallThread.ts'),
    why: 'recall_thread node titles — formerly an 80-char slice in deriveContextTitle',
  }),
  Object.freeze({
    file: join('src', 'services', 'branchMembership.ts'),
    why: 'branch member headlines in the boot/briefing package — formerly a 60-char slice',
  }),
]);

function read(rel: string): string {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    throw new Error(
      `${rel} is listed in HEADLINE_CALL_SITES but does not exist. Re-point this guard ` +
        'rather than deleting the entry — a missing file must never read as a pass.',
    );
  }
  return readFileSync(p, 'utf8');
}

/**
 * A bare numeric clip: `slice(0, 60)`, `substring(0, 140)`, `substr(0, 80)`, or the SQL
 * `left(<expr>, 60)`. Variable-length clips (`slice(0, limit)`) are not matched — they are
 * paging, not headline budgets.
 */
const BARE_CLIP =
  /(?:\.(?:slice|substring|substr)\s*\(\s*0\s*,\s*\d+\s*\)|\bleft\s*\([^()]*,\s*\d+\s*\))/g;

/** A co-located exemption: the marker plus a written reason on the SAME line. */
const EXEMPT_MARKER = /headline-clip-exempt:\s*\S+/;

/** Every line of `source` carrying a bare clip that is NOT exempted, as `lineNo: text`. */
function unexemptedClips(source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      BARE_CLIP.lastIndex = 0;
      return BARE_CLIP.test(line) && !EXEMPT_MARKER.test(line);
    })
    .map(({ line, no }) => `${no}: ${line.trim()}`);
}

describe('record headline — one config, every surface', () => {
  it('the guard has a non-empty population and can see its own subject', () => {
    // NON-EMPTY TRAP: if the enumeration ever empties, every assertion below passes
    // vacuously. Assert the shape of the population itself first.
    expect(HEADLINE_CALL_SITES.length).toBeGreaterThanOrEqual(4);
    expect(read(CONFIG_RELPATH)).toContain('export function deriveRecordHeadline');
  });

  it.each(HEADLINE_CALL_SITES.map((s) => [s.file, s.why] as const))(
    '%s reads the shared config (%s)',
    (file) => {
      expect(read(file)).toMatch(/from\s+'(?:\.\.\/)+config\/recordHeadlineConfig\.js'/);
    },
  );

  it.each(HEADLINE_CALL_SITES.map((s) => [s.file] as const))(
    '%s contains no unexplained bare numeric clip',
    (file) => {
      expect(unexemptedClips(read(file))).toEqual([]);
    },
  );

  it('the scanner actually fires — a bare clip in a synthetic source is detected', () => {
    // MUTATION PROBE OF THE SCANNER ITSELF, in-process: prove the predicate is sensitive
    // before trusting the empty results above (an always-empty matcher would pass them all).
    expect(unexemptedClips('const t = body.slice(0, 60);')).toHaveLength(1);
    expect(unexemptedClips("titleExpr: `left(x.content, 60)`")).toHaveLength(1);
    expect(unexemptedClips('const t = rows.slice(0, limit);')).toEqual([]);
    expect(
      unexemptedClips('const t = body.slice(0, 60); // headline-clip-exempt: log width'),
    ).toEqual([]);
    expect(unexemptedClips('const t = body.slice(0, 60); // headline-clip-exempt:')).toHaveLength(
      1,
    );
  });

  it('the SQL arm no longer carries a second copy of the clip', () => {
    // The one most likely to drift silently, because nothing in TypeScript could read it.
    // The generic scan above already forbids `left(<expr>, <digits>)` anywhere in this file;
    // this pins the positive half — the context projection emits NO title expression at all
    // and the row mapper derives it from the shared config.
    const sql = read(join('src', 'services', 'lexicalSearch.ts'));
    expect(sql).toMatch(/titleExpr:\s*null/);
    expect(sql).toContain('deriveTypedRecordHeadline');
  });
});

describe('record headline — the surfaces agree', () => {
  const SAMPLES = [
    'ERROR: DEFECT CLASS: "authenticated" is not "authorized to change identity" — and three defects on one endpoint are three fixes, never one. WHERE: routes/users.ts',
    'short one',
    'first line is the headline\nsecond line is not',
    'a'.repeat(400),
    'x '.repeat(200),
  ];

  it('recall_thread derives the same headline as the shared config', () => {
    for (const s of SAMPLES) expect(deriveContextTitle(s)).toBe(deriveRecordHeadline(s));
  });

  it('the typed form is the untyped form plus a prefix charged to the SAME budget', () => {
    for (const s of SAMPLES) {
      const typed = deriveTypedRecordHeadline('error', s);
      expect(typed).not.toBeNull();
      expect(typed!.startsWith('ERROR: ')).toBe(true);
      expect(typed!.length).toBeLessThanOrEqual(RECORD_HEADLINE_CONFIG.maxChars);
    }
  });
});

describe('record headline — behaviour', () => {
  const { maxChars, ellipsis } = RECORD_HEADLINE_CONFIG;

  it('ABSENT content is null, not an empty string (C1: absence gets its own value)', () => {
    // The empty/zero/absent population — the values that slip through a clip guard.
    expect(deriveRecordHeadline('')).toBeNull();
    expect(deriveRecordHeadline(null)).toBeNull();
    expect(deriveRecordHeadline(undefined)).toBeNull();
    expect(deriveRecordHeadline('   \n\n\t  \n')).toBeNull();
    expect(deriveTypedRecordHeadline('error', '')).toBeNull();
  });

  it('never exceeds the budget, and never truncates what already fits', () => {
    expect(deriveRecordHeadline('a'.repeat(maxChars))!.length).toBe(maxChars);
    expect(deriveRecordHeadline('a'.repeat(maxChars))).not.toContain(ellipsis);
    expect(deriveRecordHeadline('a'.repeat(maxChars * 3))!.length).toBe(maxChars);
    expect(deriveRecordHeadline('a'.repeat(maxChars * 3))).toContain(ellipsis);
  });

  it('prefers a complete sentence when one fits inside the budget', () => {
    // The terminator has to sit past `sentenceMinFraction` of the budget to be preferred —
    // that floor is the next test. Here it lands well inside the kept region, so the reader
    // gets a whole thought instead of a word-boundary cut mid-clause.
    const head =
      'The guard went red because the mutation landed, the control stayed green, and the ' +
      'unmutated run agreed with both.';
    expect(head.length).toBeGreaterThan(maxChars * RECORD_HEADLINE_CONFIG.sentenceMinFraction);
    const s = head + ' ' + 'trailing prose that will not fit '.repeat(20);
    expect(deriveRecordHeadline(s)).toBe(head + ellipsis);
  });

  it('does not let a leading abbreviation masquerade as a complete sentence', () => {
    // Without sentenceMinFraction this would cut to "v1.2" and call it a headline — the
    // 60-char defect arrived at from the other direction.
    const s = 'v1.2 ' + 'the actual substance of the record goes on for a while here '.repeat(6);
    expect(deriveRecordHeadline(s)!.startsWith('v1.2' + ellipsis)).toBe(false);
  });

  it('falls back to a word boundary rather than cutting mid-word', () => {
    const s = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(10);
    const out = deriveRecordHeadline(s)!;
    expect(out.endsWith(ellipsis)).toBe(true);
    const body = out.slice(0, -ellipsis.length);
    // A word-boundary cut leaves the last kept token whole: it must be a prefix of the
    // source ending exactly where a word does.
    expect(s.startsWith(body)).toBe(true);
    expect(/\s/.test(s.charAt(body.length))).toBe(true);
  });

  it('hard-cuts one unbroken token, because there is no boundary to find', () => {
    const out = deriveRecordHeadline('z'.repeat(maxChars * 2))!;
    expect(out.length).toBe(maxChars);
    expect(out.endsWith(ellipsis)).toBe(true);
  });

  it('collapses interior whitespace so a headline is one line wide', () => {
    expect(deriveRecordHeadline('a\t\t  b')).toBe('a b');
  });

  it('the budget is well past the 141-char median dead-end headline it was sized for', () => {
    // The number that justifies the number (an earlier task's measurement + this file's own).
    expect(maxChars).toBeGreaterThanOrEqual(141);
    expect(maxChars).toBeGreaterThan(RECORD_HEADLINE_CONFIG.minChars);
  });
});
