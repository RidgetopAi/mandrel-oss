/**
 * SINGLE TRUST RENDERER — the class guard.
 *
 * THE BUG CLASS (a past incident — fix the class, not the instance): the trust hint was
 * hand-written at FOUR render sites and, with nothing holding them together, TWO drifted:
 *   - routes/search.routes.ts   truncated the cold-start clause to a bare ", cold-start"
 *   - routes/recall.routes.ts   lost the clause AND the score entirely — a bare band token,
 *                               on the ONE surface an orienting agent reads end-to-end.
 * A fifth copy would drift the same way. So this guard makes the drift STRUCTURALLY
 * impossible to add silently: the band token, the "🔐 Trust" line, and the BL-5 receipt can
 * only be rendered from ONE place (services/trustModel.ts :: explainTrust).
 *
 * FAIL-CLOSED BY CONSTRUCTION (a past incident — a coverage test is an allow-list unless it
 * fails closed): each rule anchors on a CHOKE-POINT TOKEN that any trust-rendering code must
 * pass through, and accounts for EVERY occurrence of that token in non-test source. An
 * unrecognized occurrence is a loud RED, never a silent pass. Legitimate non-rendering uses
 * carry their exemption marker CO-LOCATED on the line itself — so deleting/forgetting the
 * marker is a visible RED, and there is no central allow-list to drift.
 *
 * THE ANCHOR IS A WORD, NOT A SPELLING (Reviewer B1, 2026-07-25). Rules 4/6 used to grep the
 * LITERAL string `trust.band`. That is one spelling of the read, not the choke point — two
 * natural fifth-site shapes walked straight past it, PROVEN by Reviewer against this tree:
 *     const { band, score } = t;            // destructured   → MISSED (7/7 green)
 *     function headline(t: Trust) { ... t.band ... }  // aliased param → MISSED (7/7 green)
 * The aliased shape is not a strawman: it is exactly the shape of nodeHeadline(n: ThreadNode)
 * — the site this task fixed was caught only because it happened to spell `n.trust.band`.
 * So the anchor is now the WORD /\bband\b/ (and /\babstain\b/) over CODE lines, which no
 * rename or destructure can dodge. This is the org's FOURTH iteration of this class
 * (guards-need-guarding): the guard's own hole is the failure shape.
 *
 * MUTATION-PROBED with those exact two shapes (a real file under src/routes/, not a reverted
 * call site) — both go RED here. A guard nobody has seen fail is not a guard.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * KNOWN BOUND — read this before trusting the coverage (Reviewer NIT-2).
 *
 * These rules anchor on the words `band` and `abstain`. A fifth site that renders ONLY the
 * other trust fields — `score`, `reason`, `promotionRequirement` — and never mentions either
 * anchor word WILL PASS THIS GUARD (Reviewer's PROBE E, verified). That is a DELIBERATE
 * cost/benefit call, not an oversight: `score` and `reason` are ordinary English words all
 * over this codebase (relevance scores, error reasons, similarity scores), so anchoring on
 * them would sweep enormous unrelated code and the markers would become noise — and a marker
 * everywhere is a marker nowhere. What the guard DOES guarantee is that the trust VERDICT
 * (the band) and the DO-NOT-RELY marker (abstain) — the two things that mislead a reader when
 * they drift — cannot be rendered outside explainTrust().
 *
 * This header has overclaimed once already (it said "fail-closed by construction" while the
 * anchor was a spelling). Do not let it overclaim again by omission: if you extend the
 * renderer's surface, state the new bound HERE.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Pure source inspection: no DB, no network, deterministic.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..');

/** The single definition site of the renderer, and of the band-token/config table. */
const RENDERER_FILE = 'services/trustModel.ts';
const BAND_HINT_DEFINITION_FILE = 'config/trustConfig.ts';

/**
 * The DEFINITION sites of the trust vocabulary itself. Rules 4/6 sweep the whole tree for the
 * WORDS `band` / `abstain`; these two files are where those words are DEFINED (the band enum,
 * the hint table, the Trust type, the single renderer), so requiring a marker on every line
 * of them would be noise, not signal. Everything else in src/ must account for every hit.
 */
const VOCABULARY_DEFINITION_FILES = [RENDERER_FILE, BAND_HINT_DEFINITION_FILE];

/**
 * The render sites that MUST go through explainTrust(). This is a POSITIVE pin (it catches
 * a site that stops calling the renderer); it is NOT what makes the guard fail-closed —
 * Rules 1/2/4/6 do that by accounting for every occurrence of the choke-point WORDS, so a
 * BRAND-NEW site is caught even though it is absent from this list (proven by the
 * destructured + aliased-parameter mutation probes).
 */
const KNOWN_RENDER_SITES = [
  'routes/context.routes.ts',
  'routes/decisions.routes.ts',
  'routes/search.routes.ts',
  'routes/recall.routes.ts',
];

/**
 * The co-located marker a NON-rendering use of the trust vocabulary must carry, ON ITS OWN
 * LINE. One vocabulary for both rules (band + abstain): several lines trip both, and two
 * competing marker spellings would be the very drift this file exists to stop.
 */
const EXEMPT_MARKER = 'trust-render-exempt:';

/** Every .ts file under src/, EXCLUDING the tests dir (tests legitimately assert on tokens). */
function sourceFiles(dir: string = SRC_DIR, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'tests' || entry === 'node_modules') continue;
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = sourceFiles().map((full) => ({
  rel: relative(SRC_DIR, full),
  text: readFileSync(full, 'utf8'),
}));

/** Occurrences of `token` as "<relpath>:<lineNo>" + the line, across non-test source. */
function occurrences(token: string): Array<{ rel: string; line: number; text: string }> {
  const hits: Array<{ rel: string; line: number; text: string }> = [];
  for (const f of FILES) {
    f.text.split('\n').forEach((line, i) => {
      if (line.includes(token)) hits.push({ rel: f.rel, line: i + 1, text: line.trim() });
    });
  }
  return hits;
}

/**
 * THE DETECTOR — ONE definition, one line at a time (Reviewer NIT-1).
 *
 * Is this single line an UNACCOUNTED use of the trust word `word`? True when the line is
 * CODE (prose renders nothing), uses the word as a WHOLE WORD, and carries no co-located
 * exemption marker.
 *
 * This is the fail-closed core (Reviewer B1). Anchoring on a word rather than a spelling is
 * what makes `const { band } = t` and `t.band` (aliased parameter) impossible to sneak past:
 * however you reach the field, the WORD is on the line.
 *
 * WHY IT IS A SEPARATE FUNCTION: the teeth test below used to INLINE its own copy of this
 * predicate. That made the teeth test a RESTATEMENT of the detector rather than an exercise
 * of it — Reviewer proved the consequence by regressing the real sweep back to the literal
 * `trust.<word>` spelling (the exact B1 hole) with the suite still 8/8 GREEN. Both the sweep
 * and the teeth test now call THIS function, so weakening the anchor turns the teeth test RED.
 * Third layer of the same class in this one file; the fix is to stop having two copies.
 */
function isUnaccountedUse(line: string, word: string): boolean {
  if (!isCodeLine(line)) return false;
  if (line.includes(EXEMPT_MARKER)) return false;
  return new RegExp(`\\b${word}\\b`, 'i').test(line);
}

/**
 * Every CODE line outside the vocabulary-definition files that isUnaccountedUse() flags.
 * The sweep only walks the tree; the RULE itself lives in the predicate above.
 */
function unaccountedWordUses(word: string): Array<{ rel: string; line: number; text: string }> {
  const hits: Array<{ rel: string; line: number; text: string }> = [];
  for (const f of FILES) {
    if (VOCABULARY_DEFINITION_FILES.includes(f.rel)) continue;
    f.text.split('\n').forEach((line, i) => {
      if (isUnaccountedUse(line, word)) {
        hits.push({ rel: f.rel, line: i + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

const fmt = (hits: Array<{ rel: string; line: number; text: string }>) =>
  hits.map((h) => `  ${h.rel}:${h.line}  ${h.text}`).join('\n');

/**
 * Lines that are CODE, not prose. Rule 3 asks "does this site actually CALL the renderer?" —
 * a plain text search answers YES to a file that merely MENTIONS explainTrust() in a doc
 * comment. (The mutation probe proved that hole: the mutated route kept its JSDoc, and Rule 3
 * stayed green while Rules 1+4 caught it. Guard the guard — a past incident.)
 */
function isCodeLine(l: string): boolean {
  const t = l.trim();
  return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}

function codeLines(text: string): string[] {
  return text.split('\n').filter(isCodeLine);
}

describe('trust explainability — ONE renderer, no fifth copy', () => {
  test('the source sweep actually found the source tree (harness sanity)', () => {
    // If this ever reads zero files, EVERY rule below would vacuously pass — the exact
    // silent-allow-list failure mode this guard exists to prevent.
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.map((f) => f.rel)).toContain(RENDERER_FILE);
  });

  test('RULE 1 — TRUST_BAND_HINT is read ONLY by the single renderer', () => {
    const allowed = new Set([BAND_HINT_DEFINITION_FILE, RENDERER_FILE]);
    const strays = occurrences('TRUST_BAND_HINT').filter((h) => !allowed.has(h.rel));
    expect(
      strays,
      'A band token was rendered outside explainTrust() — that is how the four copies ' +
        'drifted apart. Call explainTrust(trust) and use .line (per-record ' +
        'rows) or .compact (dense node lists) instead of indexing TRUST_BAND_HINT:\n' +
        fmt(strays)
    ).toEqual([]);
  });

  test('RULE 2 — the "🔐 Trust" line is composed ONLY by the single renderer', () => {
    const strays = occurrences('🔐 Trust').filter((h) => h.rel !== RENDERER_FILE);
    expect(
      strays,
      'A trust line is being composed by hand. Render it with explainTrust(trust).line:\n' +
        fmt(strays)
    ).toEqual([]);
  });

  test('RULE 3 — every known render site CALLS explainTrust() in code (a doc mention does not count)', () => {
    for (const site of KNOWN_RENDER_SITES) {
      const f = FILES.find((x) => x.rel === site);
      expect(f, `render site ${site} not found — did it move? update this guard`).toBeTruthy();
      const calls = codeLines(f!.text).some((l) => l.includes('explainTrust('));
      expect(
        calls,
        `${site} no longer calls explainTrust() in CODE — it has re-grown its own trust ` +
          'formatting (the exact drift an earlier task removed).'
      ).toBe(true);
    }
  });

  test('RULE 4 — every CODE use of the word `band` outside the renderer is CO-LOCATED-exempt (defeats destructuring + parameter renames)', () => {
    const unaccounted = unaccountedWordUses('band');
    expect(
      unaccounted,
      'A trust BAND is touched outside the single renderer. If it RENDERS the band, call ' +
        'explainTrust(trust) and use .line / .compact. If it genuinely renders nothing ' +
        `(ranking, a schema key, a description string), put "${EXEMPT_MARKER} <why>" on the ` +
        'SAME line — co-located, so forgetting it is a visible RED rather than a silent ' +
        'hole. NOTE the anchor is the WORD, not the spelling `trust.band`: destructuring ' +
        '(`const { band } = t`) and parameter renames (`t.band`) are exactly how the ' +
        'previous version of this rule was defeated:\n' + fmt(unaccounted)
    ).toEqual([]);
  });

  test('RULE 6 — every CODE use of the word `abstain` outside the renderer is CO-LOCATED-exempt (one marker spelling, not two)', () => {
    const unaccounted = unaccountedWordUses('abstain');
    expect(
      unaccounted,
      'The ABSTAIN marker is trust presentation and belongs to the single renderer — ' +
        'recall_thread used to hand-roll " ⛔ABSTAIN" at the call site while the other three ' +
        'surfaces printed " · abstain" (nit N2). Render it via explainTrust(trust) ' +
        '(.compact/.line already carry it; .abstainMark exposes it), or, if the line renders ' +
        `nothing (the thread-level abstain LIST, a schema key), put "${EXEMPT_MARKER} <why>" ` +
        'on the SAME line:\n' + fmt(unaccounted)
    ).toEqual([]);
  });

  test('RULE 5 — the BL-5 supersession receipt is rendered only through the single renderer', () => {
    const strays = occurrences('supersessionReceiptHint(').filter(
      (h) => h.rel !== RENDERER_FILE && !h.rel.startsWith('services/trust.ts')
    );
    expect(
      strays,
      'The receipt clause is being appended by hand again. explainTrust() already folds it ' +
        'into .line/.compact (and exposes it as .receipt):\n' + fmt(strays)
    ).toEqual([]);
  });

  /**
   * TEETH — run the REAL rule functions over synthetic fifth-site source, so the detector
   * itself is proven and not merely the current clean tree.
   *
   * These are the exact two shapes Reviewer proved slipped past the old literal-`trust.band`
   * anchor while the suite reported 7/7 green. They are checked here AND driven as live
   * mutation probes (real files under src/routes/) before hand-back.
   */
  const FIFTH_SITE_SHAPES: Array<{ what: string; src: string }> = [
    {
      what: 'DESTRUCTURED — the field never appears as `trust.band` at all',
      src: [
        'const BADGE = { trusted: "OK", unproven: "NEW" } as const;',
        'export function badge(t: Trust): string {',
        '  const { band, score } = t;',
        '  return `${BADGE[band]} ${score}`;',
        '}',
      ].join('\n'),
    },
    {
      what: 'ALIASED PARAMETER — same shape as nodeHeadline(n: ThreadNode)',
      src: [
        'export function headline(t: Trust): string {',
        '  return `[${t.band}] ${t.abstain ? " ABSTAIN" : ""}`;',
        '}',
      ].join('\n'),
    },
  ];

  test('the guard has TEETH — a destructured or aliased fifth site is detected by the REAL detector', () => {
    for (const { what, src } of FIFTH_SITE_SHAPES) {
      // Calls isUnaccountedUse — the SAME function the live sweep uses (NIT-1). Inlining the
      // regex here made this test a restatement: the real anchor could be regressed to the
      // literal spelling and this stayed green.
      const flagged = src
        .split('\n')
        .filter((l) => isUnaccountedUse(l, 'band') || isUnaccountedUse(l, 'abstain'));
      expect(flagged.length, `${what} must be flagged by the word-boundary rules`).toBeGreaterThan(
        0
      );

      // ...and prove the OLD anchor would have MISSED it — the regression Reviewer caught.
      const caughtByOldLiteralAnchor = src.includes('trust.band');
      expect(
        caughtByOldLiteralAnchor,
        `${what}: the old literal 'trust.band' anchor should NOT catch this (that is why the ` +
          'anchor is now a word) — if this ever becomes true the sample stopped testing the hole'
      ).toBe(false);
    }
  });
});
