/**
 * Date axes render as LOCAL CALENDAR DAYS, never as raw ISO.
 *
 * The symptom on Operator's screenshot was an x-axis reading `2026-07-13T00:00:00.000Z`.
 * `grep -rn "tickFormatter" frontend/src` returned ZERO hits before this task: not one
 * chart in the app had an axis formatter, so every date axis printed whatever the backend
 * serialised.
 *
 * ── THE CHAIN THIS SUITE PROVES, IN THREE LINKS ─────────────────────────────────────────
 *   LINK 1 (rendered SVG): giving AreaChartCard/ThroughputChart a day formatter changes the
 *     TICK TEXT recharts actually draws — asserted against the drawn `<tspan>`s, with an
 *     unformatted CONTROL leg in the same suite showing the raw ISO is what appears without
 *     one. Charts are mounted NON-RESPONSIVE at a fixed size because jsdom has no layout and
 *     a ResponsiveContainer measures 0×0 and draws nothing (the repo's existing pattern).
 *   LINK 2 (SCAN — the choke point): EVERY `xKey=` call site in the frontend source must
 *     either pass an `xTickFormatter` or carry a co-located `non-date-axis:` marker
 *     explaining why its axis is not a calendar day. See the population note on that
 *     describe block. This is what makes a chart added TOMORROW fail closed.
 *   LINK 3 (values): the date-bearing sites pass formatters that produce the RIGHT day —
 *     presence alone would be satisfied by `(v) => String(v)`, which is the defect.
 *
 * ── WHY LINK 2 IS A SCAN AND NOT A LIST (nit N2) ────────────────────────────────────────
 * This suite previously enumerated three screens by name and called itself "every
 * date-bearing screen in the current IA". The claim was TRUE when written — all 12 `xKey=`
 * sites were enumerated and exactly three carried a date — and it would have stayed true
 * in the file long after it stopped being true in the tree. A list is not a choke point; a
 * fourth date chart would pass it silently. C3: anchor on the thing every instance must
 * pass through, and state the guard's own population next to the enumeration.
 *
 * The runner's timezone is pinned to America/New_York (vite.config.ts). Under UTC a
 * date-only bug is invisible and a green here would mean nothing. Assertions are
 * locale-independent (utils/dayFormatReference.testkit.ts) — see nit N1 there.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatDayShort, formatDayLong } from '../../utils/datetime';
import { shortDayRef, longDayRef } from '../../utils/dayFormatReference.testkit';

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

/** Every tick label recharts actually drew. */
function tickLabels(): string[] {
  return Array.from(container.querySelectorAll('.recharts-cartesian-axis-tick-value tspan')).map(
    (n) => n.textContent ?? '',
  );
}

const FIXED = { responsive: false as const, width: 640, height: 220 };

// What the backend actually sends. /api/sessions/trends `date` is a Postgres DATE that
// res.json turned into a full ISO string; /api/tasks/throughput `day` is a bare YYYY-MM-DD.
const TRENDS = [
  { date: '2026-07-13T00:00:00.000Z', total_contexts: 4 },
  { date: '2026-07-14T00:00:00.000Z', total_contexts: 9 },
];
const THROUGHPUT = [
  { day: '2026-07-13', completed: 2, created: 3 },
  { day: '2026-07-14', completed: 1, created: 0 },
];

describe('LINK 1 — the formatter changes the drawn axis', () => {
  it('CONTROL: without a formatter the raw ISO string is drawn (the reported bug)', async () => {
    const { AreaChartCard } = await import('./index');
    mount(
      <AreaChartCard
        data={TRENDS as unknown as Array<Record<string, number | string>>}
        xKey="date"
        series={[{ key: 'total_contexts', name: 'Contexts' }]}
        showAxes
        {...FIXED}
      />,
    );
    expect(tickLabels().some((l) => l.includes('2026-07-13T00:00:00.000Z'))).toBe(true);
  });

  it('with formatDayShort the ticks are the 13th and 14th — no ISO, and NOT the day before', async () => {
    const { AreaChartCard } = await import('./index');
    mount(
      <AreaChartCard
        data={TRENDS as unknown as Array<Record<string, number | string>>}
        xKey="date"
        series={[{ key: 'total_contexts', name: 'Contexts' }]}
        xTickFormatter={(v) => formatDayShort(v as string)}
        tooltipLabelFormatter={(v) => formatDayLong(v as string)}
        showAxes
        {...FIXED}
      />,
    );
    const labels = tickLabels();
    // Locale-independent (nit N1): the reference renders the SAME explicit day in whatever
    // locale the runtime reports, so this asserts the DAY and not the glyph order.
    expect(labels).toContain(shortDayRef(2026, 7, 13));
    expect(labels).toContain(shortDayRef(2026, 7, 14));
    for (const l of labels) expect(l).not.toMatch(/T\d{2}:\d{2}/);
    // The date-only trap, stated directly: in this UTC-4 runtime a naive read gives the 12th.
    expect(labels).not.toContain(shortDayRef(2026, 7, 12));
  });

  it('the Throughput chart formats its bare YYYY-MM-DD days the same way', async () => {
    const { ThroughputChart } = await import('../../pages/tasks/ThroughputChart');
    mount(<ThroughputChart series={THROUGHPUT} rangeLabel="30d" responsive={false} />);
    const labels = tickLabels();
    expect(labels).toContain(shortDayRef(2026, 7, 13));
    expect(labels).toContain(shortDayRef(2026, 7, 14));
    expect(labels).not.toContain(shortDayRef(2026, 7, 12));
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 *  LINK 2 — THE SCAN. IT PARSES; IT DOES NOT READ TEXT.
 * ════════════════════════════════════════════════════════════════════════════════════════
 * ── WHY THIS IS AN AST WALK AND NOT A STRING SCAN (REJECT ROUND 1) ──────────────────────
 * The first version of this guard delimited a JSX element by hand: back-scan to the last
 * `<`, forward to the next `/>`. That is a TEXT instrument answering a STRUCTURAL question,
 * and it was not merely incomplete — it produced a FALSE GREEN.
 *
 * MEASURED on this branch. Convert the first `AreaChartCard` in `PrimitivesGallery.tsx` to
 * children form (`></AreaChartCard>`) and delete its marker, leaving an UNCLASSIFIED,
 * date-keyed axis:
 *      npx vitest run src/components/charts/dateAxis.test.tsx  ->  21 passed
 *      npx tsc --noEmit                                        ->  0 errors
 * because `indexOf('/>')` ran past the end of that element and captured 517 characters
 * spanning THREE elements, picking up the `non-date-axis` marker belonging to a
 * `LineChartCard` two elements later. The same bleed can borrow a neighbour's
 * `xTickFormatter` and mark an unformatted date axis as formatted.
 *
 * The rule we keep re-learning, and this is its second instance on this branch:
 * **STRUCTURE → compiler/AST. BYTES → grep.** A depth-tracking string scanner would have
 * been a better regex and still on the wrong side of that line. TypeScript is already in
 * this toolchain, so the parser that decides what an element IS is the one that answers.
 * With a real parse there is no delimiter to get wrong: an element's attributes are a
 * property of the node, self-closing and children forms are the same question, and the
 * marker lookup is bounded by the node's own range.
 *
 * ── THE POPULATION THIS GUARD ENUMERATES (stated here so nobody reads it as wider, C3) ──
 * Every JSX element — `JsxSelfClosingElement` OR `JsxOpeningElement`, the distinction that
 * broke the old version — in every `.ts`/`.tsx` file under `frontend/src`, EXCLUDING
 * `*.test.ts(x)` and `src/components/charts/` (those DECLARE `xKey`, they do not pass it),
 * that is EITHER
 *   (a) passing a literal `xKey` attribute, or
 *   (b) named as one of the chart components that DECLARE an `xKey` prop — a set derived
 *       by parsing `src/components/charts/` rather than hardcoded — AND carrying a spread
 *       (`{...props}`), which could be hiding an `xKey` the parser cannot resolve.
 *
 * (b) closes the blind spot the text version documented and could not fix: a spread call
 * site is now UNRESOLVABLE and therefore RED, not invisible. There is no such site today,
 * so this leg is dormant by design — its probe is in the mutation list below.
 *
 * ── THE RULE, AND IT FAILS CLOSED ───────────────────────────────────────────────────────
 * Each site must either pass `xTickFormatter`, or carry the co-located marker
 * `non-date-axis:` with a reason INSIDE ITS OWN opening tag. A new chart with an
 * unclassified axis is RED until someone decides which it is. The marker is co-located and
 * reasoned rather than kept in a central allow-list — the reason belongs where
 * the decision is, and a central list rots out of sight.
 *
 * ── "COULD NOT MEASURE" HAS ITS OWN BRANCH, AND IT IS RED (C1's third state) ────────────
 * A file with SYNTAX ERRORS is emitted as an unresolvable site and fails, so a file nobody
 * could read never reads as "no charts here". This is checked against `parseDiagnostics`
 * rather than a `try`/`catch`, because `ts.createSourceFile` does not throw — see the note
 * on `parseErrorsIn`. So does a chart that spreads its props.
 *
 * The version of this claim in the string-scanning guard was ITSELF too wide, and the
 * comment is called out here because a comment is what the next person trusts instead of
 * re-probing: it said an unparseable element is reported empty and fails closed. That was
 * true only at END OF FILE (no `/>` ahead, so the capture came back empty) and FALSE in the
 * middle of a file, which is the common case — there the scan found SOME later `/>` and
 * confidently classified the site using another element's attributes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Where the chart wrappers DECLARE `xKey`; declarations are not call sites. */
const DECLARATION_DIR = resolve(SRC_ROOT, 'components/charts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

interface XKeySite {
  file: string;
  line: number;
  tag: string;
  /** The opening tag's OWN source text — exact node range, no scanning. */
  element: string;
  hasFormatter: boolean;
  marker: string | null;
  /** Set when the site cannot be decided by parsing. Always RED; never excusable. */
  unresolvable: string | null;
}

function parseSource(text: string, name: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function parse(file: string): ts.SourceFile {
  return parseSource(readFileSync(file, 'utf8'), file);
}

/**
 * Why this is checked explicitly rather than trusted to a `try`/`catch`:
 * `ts.createSourceFile` DOES NOT THROW on malformed input. It returns a SourceFile
 * containing error nodes and records the problems on `parseDiagnostics`. A guard that
 * wrapped the call in try/catch and claimed "a file that fails to parse goes RED" would be
 * making a claim its mechanism could not keep — the parser would hand back a half-built
 * tree, the walk would find no JSX in the broken region, and the file would report ZERO
 * sites and pass. That is the same shape as the delimiter defect this rewrite exists to
 * fix, so it is checked, not assumed.
 *
 * `parseDiagnostics` is not on the public `ts` type surface, hence the cast. Verified
 * present and populated on TypeScript 5.9.3: a malformed `.tsx` yields 1 diagnostic
 * ("Identifier expected."), a clean one yields 0.
 */
function parseErrorsIn(sf: ts.SourceFile): string | null {
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(diags)) {
    return 'this TypeScript build does not expose parseDiagnostics, so a malformed file ' +
      'cannot be distinguished from a file with no charts. Failing closed rather than ' +
      'guessing (C1: "could not measure" is not "fine").';
  }
  if (diags.length === 0) return null;
  return `file did not parse cleanly (${diags.length} syntax error(s)): ` +
    ts.flattenDiagnosticMessageText(diags[0].messageText, ' ');
}

function eachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/**
 * The chart components that DECLARE an `xKey` prop, derived by parsing the declaration
 * directory. Deriving beats listing: a fourth chart wrapper joins this set by existing.
 */
function chartComponentsDeclaringXKey(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(DECLARATION_DIR)) {
    const sf = parse(file);
    let declaresXKey = false;
    eachNode(sf, (n) => {
      if (ts.isPropertySignature(n) && n.name && n.name.getText(sf) === 'xKey') declaresXKey = true;
    });
    // The component's exported name matches its file (the repo's convention, and the
    // barrel re-exports it under exactly that name).
    if (declaresXKey) names.add(file.split('/').pop()!.replace(/\.tsx?$/, ''));
  }
  return names;
}

const CHART_COMPONENTS = chartComponentsDeclaringXKey();

/**
 * The co-located marker for THIS tag: a `non-date-axis:` comment inside the opening tag's
 * own range and OUTSIDE any JSX nested in its attribute values.
 *
 * The nested-JSX exclusion is not hypothetical — `ActivityTrend`'s `AreaChartCard` passes
 * `caption={<Provenance …>…</Provenance>}`, so an opening tag legitimately contains other
 * elements. Without the exclusion a marker written on a nested element would excuse the
 * chart around it, which is the same borrowing bug one level in.
 */
function markerIn(open: ts.JsxOpeningLikeElement, sf: ts.SourceFile): string | null {
  const start = open.getStart(sf);
  const end = open.getEnd();

  // Ranges of any JSX nested inside this tag's attribute values.
  const nested: Array<[number, number]> = [];
  open.attributes.forEachChild(function visit(n: ts.Node) {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      nested.push([n.getStart(sf), n.getEnd()]);
      return; // everything deeper is already covered by this range
    }
    n.forEachChild(visit);
  });
  const inNested = (pos: number) => nested.some(([a, b]) => pos >= a && pos < b);

  const text = sf.text.slice(start, end);
  for (const m of text.matchAll(/non-date-axis:\s*([^*\n]*)/g)) {
    if (inNested(start + m.index)) continue;
    return m[1].trim();
  }
  return null;
}

function findXKeySites(): XKeySite[] {
  const sites: XKeySite[] = [];
  for (const file of walk(SRC_ROOT)) {
    if (file.startsWith(DECLARATION_DIR)) continue;
    const rel = relative(SRC_ROOT, file);
    const sf = parse(file);
    const parseError = parseErrorsIn(sf);
    if (parseError) {
      // A file we could not read is a SITE, and an always-RED one. It is emitted even
      // though it has no known chart, because "no charts found" and "could not look" are
      // the two answers that must never share a branch.
      sites.push({
        file: rel, line: 0, tag: '?', element: '', hasFormatter: false, marker: null,
        unresolvable: parseError,
      });
      continue;
    }

    eachNode(sf, (n) => {
      // BOTH forms. `<X ... />` and `<X ...>children</X>` are the same question, and
      // treating them as one is the entire fix — the old scanner only ever terminated on
      // `/>`, so the children form ran into whatever came next.
      if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return;
      const open = n as ts.JsxOpeningLikeElement;
      const tag = open.tagName.getText(sf);

      const attrs = open.attributes.properties;
      const named = (name: string) =>
        attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === name);
      const spreads = attrs.filter(ts.isJsxSpreadAttribute);

      const passesXKey = named('xKey');
      // A spread on a component KNOWN to take xKey could be hiding one. Unresolvable by
      // parsing alone, so it is a site and it is RED — the blind spot the text version
      // could only document.
      const spreadOnChart = spreads.length > 0 && CHART_COMPONENTS.has(tag);
      if (!passesXKey && !spreadOnChart) return;

      sites.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(open.getStart(sf)).line + 1,
        tag,
        element: sf.text.slice(open.getStart(sf), open.getEnd()),
        hasFormatter: named('xTickFormatter'),
        marker: markerIn(open, sf),
        unresolvable:
          !passesXKey && spreadOnChart
            ? `<${tag}> spreads props ({...}), so whether it passes xKey cannot be decided ` +
              `by parsing. Pass xKey explicitly at this call site.`
            : null,
      });
    });
  }
  return sites;
}

const X_KEY_SITES = findXKeySites();

describe('LINK 2 — the SCAN: every xKey call site is classified (fail-closed)', () => {
  it('the scan found call sites at all — an empty population would pass everything below', () => {
    // The instrument's own sanity check. A broken walker returns [] and every `it.each`
    // below silently becomes zero assertions.
    expect(X_KEY_SITES.length).toBeGreaterThanOrEqual(10);
  });

  it('the scan derived the chart component set by parsing, not from a list', () => {
    // If this set were empty the spread leg would be silently dead.
    expect(CHART_COMPONENTS.size).toBeGreaterThanOrEqual(3);
    expect(CHART_COMPONENTS.has('AreaChartCard')).toBe(true);
  });

  it('BOTH JSX forms are in the population — self-closing AND children', () => {
    // The children form is what defeated the previous string-scanning version: it only
    // ever terminated on `/>`, so `<X ...>…</X>` ran into the next element and could be
    // excused, or marked formatted, by a NEIGHBOUR's attributes. This asserts the parser
    // reaches both shapes at all, so that hole cannot silently reopen.
    const parsed = ts.createSourceFile(
      'probe.tsx',
      'const a = <AreaChartCard xKey="d" />;\nconst b = <AreaChartCard xKey="d"></AreaChartCard>;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const forms: string[] = [];
    eachNode(parsed, (n) => {
      if (ts.isJsxSelfClosingElement(n)) forms.push('self-closing');
      if (ts.isJsxOpeningElement(n)) forms.push('opening');
    });
    expect(forms.sort()).toEqual(['opening', 'self-closing']);
  });

  it.each(X_KEY_SITES.map((s) => [`${s.file}:${s.line} <${s.tag}>`, s] as const))(
    '%s — passes xTickFormatter, or says why its axis is not a calendar day',
    (_label, site) => {
      // "Could not decide" is its own branch and is always RED — it never shares one with
      // "fine" (C1's third state).
      expect(site.unresolvable, `${_label}: ${site.unresolvable}`).toBeNull();

      const formatted = site.hasFormatter;
      const excused = site.marker !== null;
      // Exactly one of the two, and never neither. The message names the fix because a
      // guard that fires on someone else's PR should tell them what to do.
      expect(
        formatted || excused,
        `${_label}: a chart x axis must either pass xTickFormatter (use utils/datetime ` +
          `formatDayShort for a calendar day) or carry a co-located ` +
          `/* non-date-axis: <reason> */ marker inside ITS OWN opening tag. Neither found.`,
      ).toBe(true);
    },
  );

  it('a formatted site does not ALSO claim to be a non-date axis', () => {
    for (const s of X_KEY_SITES) {
      expect(
        s.hasFormatter && s.marker !== null,
        `${s.file}:${s.line} <${s.tag}> claims both`,
      ).toBe(false);
    }
  });

  it('every excused site gives a REASON, not a bare marker', () => {
    for (const s of X_KEY_SITES) {
      if (s.marker === null) continue;
      expect(
        s.marker.length,
        `${s.file}:${s.line} <${s.tag}> — empty or too-short non-date-axis reason`,
      ).toBeGreaterThan(10);
    }
  });

  /**
   * ════════════════════════════════════════════════════════════════════════════════════
   *  THE PERMANENT REGRESSION CASE (REJECT ROUND 1)
   * ════════════════════════════════════════════════════════════════════════════════════
   * A frozen copy of the exact source shape that produced the false GREEN, kept because
   * it reproduces a CLASS we expect to recur — "the delimiter walked into the next
   * element" — and because the defect is no longer in the tree, so nothing else can
   * regression-test it. The classifier runs against this fixture text the same way it
   * runs against the repo.
   *
   * Each fixture is a chart in CHILDREN form whose neighbour carries the attribute the
   * broken scanner would have borrowed. Under the old `indexOf('/>')` delimiter every
   * one of these classified as excused/formatted; under the parser each is correctly
   * seen as unclassified.
   */
  const BLEED_FIXTURES: Array<{ name: string; src: string }> = [
    {
      name: 'children form, neighbour has the MARKER',
      src: `const a = (<div>
        <AreaChartCard data={d} xKey="day" caption="unclassified"></AreaChartCard>
        <LineChartCard data={e} xKey="t" /* non-date-axis: a synthetic tick index here */ />
      </div>);`,
    },
    {
      name: 'children form, neighbour has the FORMATTER',
      src: `const a = (<div>
        <AreaChartCard data={d} xKey="day" caption="unclassified"></AreaChartCard>
        <LineChartCard data={e} xKey="t" xTickFormatter={(v) => String(v)} />
      </div>);`,
    },
  ];

  /** The classifier, applied to a source string instead of a file. Same rule, same code path. */
  function classify(src: string) {
    const sf = ts.createSourceFile('probe.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const out: Array<{ tag: string; formatted: boolean; excused: boolean }> = [];
    eachNode(sf, (n) => {
      if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return;
      const open = n as ts.JsxOpeningLikeElement;
      if (!open.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'xKey')) return;
      out.push({
        tag: open.tagName.getText(sf),
        formatted: open.attributes.properties.some(
          (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'xTickFormatter',
        ),
        excused: markerIn(open, sf) !== null,
      });
    });
    return out;
  }

  it.each(BLEED_FIXTURES.map((f) => [f.name, f.src] as const))(
    'REGRESSION — %s: the unclassified chart is NOT excused by its neighbour',
    (_name, src) => {
      const [first, second] = classify(src);
      // The premise: the neighbour really does carry the thing that could be borrowed.
      expect(second.formatted || second.excused).toBe(true);
      // The guarantee: none of it reaches the element before it.
      expect(first.tag).toBe('AreaChartCard');
      expect(first.formatted).toBe(false);
      expect(first.excused).toBe(false);
    },
  );

  it('REGRESSION — the old text delimiter really would have been fooled by these', () => {
    // Without this leg the fixtures above prove nothing: they could be shapes that were
    // never a problem. This runs the PRE-FIX algorithm and watches it produce the false
    // GREEN, so the regression cases are pinned to a defect that demonstrably existed.
    for (const { src } of BLEED_FIXTURES) {
      const at = src.indexOf('xKey=');
      const tagStart = src.slice(0, at).lastIndexOf('<');
      const close = src.indexOf('/>', at);
      const captured = src.slice(tagStart, close + 2);
      const oldVerdict = captured.includes('xTickFormatter') || /non-date-axis:/.test(captured);
      expect(oldVerdict).toBe(true); // ← the false GREEN, reproduced
      expect((captured.match(/<[A-Za-z]/g) ?? []).length).toBeGreaterThan(1); // ← the bleed
    }
  });

  it('no site captures text beyond its own opening tag', () => {
    // The bleed, stated as an invariant. The old scanner captured 517 chars spanning three
    // elements here; a node range ends where the tag ends, so the captured text must not
    // contain a tag TERMINATOR before its last character.
    for (const s of X_KEY_SITES) {
      if (s.unresolvable) continue;
      expect(s.element.startsWith(`<${s.tag}`), `${s.file}:${s.line}`).toBe(true);
      const body = s.element.slice(0, -1);
      expect(
        body.includes('/>'),
        `${s.file}:${s.line} <${s.tag}> — captured text runs past its own tag:\n${s.element.slice(0, 200)}`,
      ).toBe(false);
    }
  });

  it('a MALFORMED file is an unresolvable site, not a file with no charts', () => {
    // The third state, probed rather than asserted in prose. createSourceFile does not
    // throw here — it returns a half-built tree — so without the parseDiagnostics check
    // this file would contribute ZERO sites and pass silently.
    const broken = parseSource('const a = <AreaChartCard xKey="day" ;', 'broken.tsx');
    expect(parseErrorsIn(broken)).not.toBeNull();
    expect(parseErrorsIn(broken)).toContain('did not parse cleanly');

    // ...and the control: a well-formed file yields no such verdict.
    expect(parseErrorsIn(parseSource('const a = <AreaChartCard xKey="day" />;', 'ok.tsx'))).toBeNull();

    // The real tree is clean, so no site in the live population is unresolvable.
    expect(X_KEY_SITES.filter((s) => s.unresolvable)).toEqual([]);
  });

  it('a chart that SPREADS its props is unresolvable, not invisible', () => {
    // The blind spot the text version could only document. A spread on a component known
    // to take xKey cannot be decided by parsing, so it becomes an always-RED site.
    const sf = parseSource('const a = <AreaChartCard {...cfg} />;', 'spread.tsx');
    let found = false;
    eachNode(sf, (n) => {
      if (!ts.isJsxSelfClosingElement(n)) return;
      const open = n as ts.JsxOpeningLikeElement;
      const tag = open.tagName.getText(sf);
      const spreads = open.attributes.properties.filter(ts.isJsxSpreadAttribute);
      const hasXKey = open.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'xKey',
      );
      if (!hasXKey && spreads.length > 0 && CHART_COMPONENTS.has(tag)) found = true;
    });
    expect(found).toBe(true);
    // Premise: the tag really is one of the derived chart components.
    expect(CHART_COMPONENTS.has('AreaChartCard')).toBe(true);
  });

  it('a marker on JSX NESTED in an attribute does not excuse the chart around it', () => {
    // Real shape: ActivityTrend passes `caption={<Provenance …>}`, so an opening tag can
    // legitimately contain other elements. A marker written in there is the borrowing bug
    // one level in, and the nested-range exclusion in markerIn() is what stops it.
    const sf = ts.createSourceFile(
      'probe.tsx',
      `const a = <AreaChartCard xKey="date" caption={<Provenance /* non-date-axis: this belongs to Provenance, not the chart */ kind="live" />} />;`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let chart: ts.JsxOpeningLikeElement | undefined;
    eachNode(sf, (n) => {
      if (
        (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
        (n as ts.JsxOpeningLikeElement).tagName.getText(sf) === 'AreaChartCard'
      ) {
        chart = n as ts.JsxOpeningLikeElement;
      }
    });
    expect(chart).toBeDefined();
    // The premise: the marker text really is inside the chart tag's range.
    expect(sf.text.slice(chart!.getStart(sf), chart!.getEnd())).toContain('non-date-axis:');
    // The guarantee: it still does not count as the chart's own marker.
    expect(markerIn(chart!, sf)).toBeNull();
  });
});

describe('LINK 3 — the date-bearing screens pass a formatter that produces the RIGHT day', () => {
  /**
   * Capture the props AreaChartCard is handed, then assert the formatters are present AND
   * that they produce the right day. Asserting only "a function was passed" would pass with
   * `(v) => String(v)` — the exact defect.
   *
   * This block IS a hardcoded list, and that is fine now that LINK 2 above is the choke
   * point: these three are named because they are the ones whose VALUES are worth pinning,
   * not because the set is claimed to be complete.
   */
  const captured: Array<Record<string, unknown>> = [];

  /**
   * Install the AreaChartCard spy, then let the caller import + render its screen. The
   * import must happen INSIDE, after `doMock`, and via dynamic `import()` — `require` does
   * not exist in this ESM runner, and a static import would bind the real component before
   * the mock is registered.
   */
  async function capturePropsFrom(render: () => Promise<React.ReactElement>) {
    captured.length = 0;
    vi.doMock('../../components/charts', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('../../components/charts');
      return {
        ...actual,
        AreaChartCard: (props: Record<string, unknown>) => {
          captured.push(props);
          return <div data-captured="area" />;
        },
      };
    });
    vi.resetModules();
    mount(await render());
    return captured;
  }

  afterEach(() => {
    vi.doUnmock('../../components/charts');
    vi.resetModules();
  });

  it('Dashboard → Workspace activity', async () => {
    vi.doMock('../../pages/dashboard/hooks', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('../../pages/dashboard/hooks');
      return {
        ...actual,
        useActivityTrends: () => ({
          data: TRENDS,
          isPending: false,
          isError: false,
          error: null,
        }),
      };
    });
    const seen = await capturePropsFrom(async () => {
      const { ActivityCard } = await import('../../pages/dashboard/ActivityCard');
      return <ActivityCard projectId="p1" projectName="mandrel" scope={(() => ({})) as never} />;
    });
    expect(seen).toHaveLength(1);
    const p = seen[0];
    expect(p.xKey).toBe('date');
    expect((p.xTickFormatter as (v: unknown, i: number) => string)('2026-07-13T00:00:00.000Z', 0)).toBe(shortDayRef(2026, 7, 13));
    expect((p.tooltipLabelFormatter as (v: unknown) => string)('2026-07-13T00:00:00.000Z')).toBe(longDayRef(2026, 7, 13));
    vi.doUnmock('../../pages/dashboard/hooks');
  });

  it('Analytics → Activity over time', async () => {
    const seen = await capturePropsFrom(async () => {
      const { ActivityTrend } = await import('../../pages/analytics/ActivityTrend');
      return (
        <ActivityTrend
          trends={TRENDS as never}
          days={30 as never}
          isLoading={false}
          isError={false}
        />
      );
    });
    expect(seen).toHaveLength(1);
    const p = seen[0];
    expect(p.xKey).toBe('date');
    // The row must still carry the REAL bucket value — pre-formatting it in the data is
    // what left the tooltip printing raw ISO in the first place.
    expect((p.data as Array<{ date: string }>)[0].date).toBe('2026-07-13T00:00:00.000Z');
    expect((p.xTickFormatter as (v: unknown, i: number) => string)('2026-07-13T00:00:00.000Z', 0)).toBe(shortDayRef(2026, 7, 13));
    expect((p.tooltipLabelFormatter as (v: unknown) => string)('2026-07-13T00:00:00.000Z')).toBe(longDayRef(2026, 7, 13));
  });

  it('Tasks → Throughput vs created', async () => {
    const seen = await capturePropsFrom(async () => {
      const { ThroughputChart } = await import('../../pages/tasks/ThroughputChart');
      return <ThroughputChart series={THROUGHPUT} rangeLabel="30d" />;
    });
    expect(seen).toHaveLength(1);
    const p = seen[0];
    expect(p.xKey).toBe('day');
    expect((p.xTickFormatter as (v: unknown, i: number) => string)('2026-07-13', 0)).toBe(shortDayRef(2026, 7, 13));
    expect((p.tooltipLabelFormatter as (v: unknown) => string)('2026-07-13')).toBe(longDayRef(2026, 7, 13));
  });
});
