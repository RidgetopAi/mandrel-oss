/**
 * P5.4 — MODE and SPINE as FIELDS, with the prose regex kept as a fallback.
 *
 * WHAT THIS EXISTS TO CATCH. Until P5.4 the two highest-load lines of a boot document were
 * recovered by a regex over a handoff's free text (riverbend/runtime/lib/handoff-fields.sh).
 * Measured 2026-08-23 against a FOREIGN project: MODE and PATH both rendered "(none
 * recorded)", permanently, because no customer writes `MODE:` in prose. A configurable regex
 * would have made the PARSER configurable without making the DATA present.
 *
 * THE SIX PROPERTIES ASSERTED HERE, each named in the P5.4 acceptance:
 *   1. FIELD ALONE IS SUFFICIENT — a handoff whose body contains NO MODE/PATH prose at all
 *      still renders MODE and SPINE. This is the whole point of the change.
 *   2. LEGACY PROSE STILL WORKS — a REAL handoff from our own corpus, stored with no fields,
 *      renders via the fallback. Our history is 100% prose and this is not a flag day.
 *   3. BOTH → THE FIELD WINS, and the render SAYS which source it used.
 *   4. NEITHER → "(none recorded)". No fabrication, ever.
 *   5. AN UNRECOGNISED MODE IS STORED AND RENDERED, never rejected.
 *   6. (Live round-trip — proven against a running instance, not here. A unit test cannot
 *      prove a write path; see the run report.)
 *
 * EVERY EXPECTED STRING BELOW IS A LITERAL, deliberately. This file must not import the
 * labels it is checking from the config the renderer reads: an oracle that reads the value
 * under test from the same source as the subject cannot fail (the rule projectBriefingDropOrder
 * states and keeps). A change to a label shows up here as a diff someone has to approve.
 */
import { describe, test, expect } from 'vitest';
import {
  applyCarriedFields,
  readCarriedFields,
  extractProseField,
  extractProseSpine,
  NO_CARRIED_FIELDS,
} from '../services/handoffCarriedFields.js';
import {
  renderBriefing,
  type BriefingConfig,
  type BriefingData,
} from '../services/projectBriefing.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';
import {
  READ_HANDOFF_HEAD_MAX_HOPS,
  READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS,
  READ_HANDOFF_HEAD_REFUSAL_REMEDY,
} from '../config/handoffHeadConfig.js';

const HANDOFF_ID = '88888888-0000-0000-0000-000000000000';
const PROJECT_ID = '99999999-0000-0000-0000-000000000000';
const NOW = new Date('2026-08-23T00:00:00Z');

const CFG = (over: Partial<BriefingConfig> = {}): BriefingConfig => ({
  maxChars: 24000,
  conventionTags: ['convention'],
  openTaskStatuses: ['todo', 'in_progress', 'blocked'],
  sectionMaxRecords: 200,
  deadEndReservedChars: 4000,
  handoffHeadMaxHops: READ_HANDOFF_HEAD_MAX_HOPS(),
  handoffHeadCandidateHeadlineChars: READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS(),
  handoffHeadRefusalRemedy: READ_HANDOFF_HEAD_REFUSAL_REMEDY(),
  deadEndTags: ['dead-end'],
  handoffStampEnabled: true,
  handoffStampFormat: ' [now: {status}]',
  // OFF for this suite, for the same reason backfillEnabled/altitudeEnabled are: these cases
  // assert the earlier document and its char arithmetic, and the recording directive is
  // ~1k chars of frame that would shift every cap assertion here without being what they
  // measure. The directive's own behaviour — including that it is ON by default in the
  // shipped config — is asserted by projectBriefingRecordingDirective.contract.test.ts.
  recordingDirectiveEnabled: false,
  recordingDirective: 'FAB-RECORDING-DIRECTIVE-UNUSED',
  handoffStampDeletedLabel: 'deleted',
  excludedTaskTags: ['parked'],
  branchReservedChars: 4000,
  alwaysSurfaceTaskStatuses: ['blocked'],
  // P5.5, added by the P5.1/P5.4/P5.5 integration. OFF here for the reason this fixture
  // already switches altitude off: this suite asserts a render that predates the section.
  // It has its own reserved budget and is not in the global drop pool, so admitting it would
  // add a section these fixtures measure in chars without adding anything they assert about.
  // P5.1, added by the integration. OFF: this suite asserts the carried-fields render, not
  // altitude or selection. OFF is the pre-P5.1 document byte-for-byte (applyAltitudeFlag),
  // so these cases keep measuring exactly what they were written to measure.
  altitudeEnabled: false,
  selectMaxTasks: 28,
  selectMaxDecisions: 16,
  selectMaxConventions: 5,
  selectMaxDeadEnds: 15,
  selectMaxBranchMembers: 26,
  fullProseSlots: 3,
  fullProseTypes: ['task', 'decision'],
  fullProseMaxChars: 1200,
  fullProseExcludeTags: [],
  waitingSectionEnabled: false,
  waitingReservedChars: 2500,
  waitingMaxRecords: 25,
  waitingFallbackCaveat: 'FAB-FALLBACK-CAVEAT',
  waitingDueHintCaveat: 'FAB-HINT-CAVEAT',
  branchScopeEnabled: true,
  protectionRankBranchMember: 4,
  protectionRankAlwaysSurface: 3,
  protectionRankConvention: 3,
  // the briefing-budget decision's measurement knob, restated at its SHIPPED default (the floor) like the ranks
  // above it: a decision gets no band of its own until a measurement says it should.
  protectionRankDecision: 0,
  protectionRankStalePriority: 2,
  protectionRankPriority: 1,
  protectedTaskPriorities: ['urgent', 'high'],
  staleTaskDays: 7,
  backfillEnabled: false,
  ...over,
});

const census = (n: number) => ({ fetched: n, fetchBoundReached: false, excluded: 0, excludedReason: null });

/**
 * Build a BriefingData whose ONLY interesting content is the handoff, so anything this file
 * asserts about the output is attributable to the carried-fields render and nothing else.
 * `carried` is computed by the REAL readCarriedFields from the same (metadata, content) the
 * gather would have handed it — not hand-written — so a change to the precedence ladder
 * reaches these assertions instead of being papered over by a fixture.
 */
function data(
  content: string,
  metadata: unknown,
  spineResolved: { kind: string; title: string } | null = null,
): BriefingData {
  return {
    projectId: PROJECT_ID,
    projectName: 'fab',
    handoffHead: resolvedHead({ id: HANDOFF_ID }),
    handoff: {
      id: HANDOFF_ID,
      content,
      createdAt: new Date('2026-08-22T00:00:00Z'),
      trustSignal: 'trust:test',
      stamps: NO_HANDOFF_STAMPS,
      carried: readCarriedFields(metadata, content),
      spineResolved,
    },
    tasks: [],
    decisions: [],
    conventions: [],
    deadEnds: [],
    excludedTaskCount: 0,
    census: {
      tasks: census(0),
      decisions: census(0),
      conventions: census(0),
      deadEnds: census(0),
      branchMembers: census(0),
    },
  } as unknown as BriefingData;
}

const render = (d: BriefingData): string => renderBriefing(d, CFG(), NOW).markdown;

/** The rendered `## Handoff` section only — so a match cannot come from elsewhere. */
function handoffSection(text: string): string {
  const start = text.indexOf('## Handoff');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * JUST the three carried-field lines — the block between the head line and the blank line
 * that precedes the handoff BODY.
 *
 * WHY THIS EXISTS RATHER THAN MATCHING THE WHOLE SECTION, and it is the whole reason the
 * first draft of this file was wrong: the handoff BODY is rendered VERBATIM, so a fixture
 * whose prose says `MODE: research` will always contain that string somewhere in the
 * section — correctly, because the body is the archive of what its author wrote and nothing
 * may rewrite it. Asserting `not.toContain('MODE: research')` over the section therefore
 * tests the FIXTURE, not the precedence. The claim P5.4 actually makes is about the three
 * DERIVED lines, so that is what this narrows to.
 */
function carriedLines(text: string): string {
  const section = handoffSection(text);
  const lines = section.split('\n');
  const head = lines.findIndex((l) => l.includes('[head:chain-walk]'));
  expect(head).toBeGreaterThanOrEqual(0);
  const block = lines.slice(head + 1, head + 4);
  // The block is EXACTLY three lines and they are exactly these labels, in this order.
  // Pinned so a future change that drops or reorders one is caught here rather than
  // silently narrowing every assertion below to a smaller window.
  expect(block.map((l) => l.split(':')[0])).toEqual(['MODE', 'PATH', 'SPINE']);
  return block.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// CONTROL FIRST. Before any FAIL below is trusted, the same machinery must print PASS on a
// known-good input — a probe that fails closed on a null field reads as a false RED, and
// that produced three wrong conclusions on 2026-08-23.
// ═════════════════════════════════════════════════════════════════════════════════════════

describe('P5.4 control — the harness can see a value at all', () => {
  test('the section extractor finds the handoff section and its head line', () => {
    const s = handoffSection(render(data('body only', {})));
    expect(s).toContain('## Handoff');
    expect(s).toContain('[head:chain-walk]');
    expect(s).toContain('body only');
  });

  test('readCarriedFields returns a VALUE (not null) for a plainly-present field', () => {
    const c = readCarriedFields({ handoff: { mode: 'build', spine: 'b341f00d' } }, '');
    expect(c.mode).not.toBeNull();
    expect(c.mode!.value).toBe('build');
    expect(c.spine).not.toBeNull();
    expect(c.spine!.ref).toBe('b341f00d');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// PROOF 1 — THE FIELD ALONE IS SUFFICIENT.
// ═════════════════════════════════════════════════════════════════════════════════════════

describe('P5.4 proof 1 — field alone, with NO MODE/PATH prose anywhere in the body', () => {
  // The body is checked to contain no `MODE`/`PATH` token at all, so the render below
  // cannot be getting its answer from the fallback by accident. This is the assertion that
  // makes the test about the FIELD rather than about the regex.
  const BODY = 'Shipped the collapse wiring and the reserved slot. Next up is the eval wave.';

  test('the body genuinely carries no parseable prose (the premise, asserted)', () => {
    expect(BODY).not.toMatch(/MODE/i);
    expect(BODY).not.toMatch(/PATH/i);
    expect(extractProseField('MODE', BODY)).toBeNull();
    expect(extractProseField('PATH', BODY)).toBeNull();
  });

  test('MODE and SPINE render from the field, each labelled [source: field]', () => {
    const s = carriedLines(
      render(
        data(BODY, { handoff: { mode: 'build', spine: 'b341f00d' } }, {
          kind: 'task',
          title: 'P4 boot package',
        }),
      ),
    );
    expect(s).toContain('MODE: build  [source: field]');
    expect(s).toContain('SPINE: task b341f00d — P4 boot package  [source: field]');
    // PATH has no field equivalent and must NOT be invented from the spine.
    expect(s).toContain('PATH: (none recorded)');
  });

  test('the spine line reports what it resolves to TODAY, and says so when it resolves to nothing', () => {
    const s = carriedLines(
      render(data(BODY, { handoff: { spine: 'deadbeef' } }, null)),
    );
    expect(s).toContain('SPINE: record deadbeef — unresolved in this project  [source: field]');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// PROOF 2 — LEGACY PROSE STILL WORKS. The body below is a REAL handoff head from our own
// corpus (riverbend, 2026-08-22), reproduced verbatim in the two forms it was written in.
// ═════════════════════════════════════════════════════════════════════════════════════════

describe('P5.4 proof 2 — a legacy prose-only handoff renders via the fallback', () => {
  // Verbatim shape from the live corpus: house style renders every id in BACKTICKS, and the
  // MODE line is written as a bare label. Both of these broke the shell parser in production
  // (the backtick case cost a whole boot's branch walk on 2026-08-22).
  const LEGACY = [
    '★ HANDOFF — p4 boot package',
    '',
    'MODE: build — wiring collapse-by-equivalence into the walk. Do NOT re-open the eval wave.',
    'PATH: roots → tree:canonical → trunk(@moat/memory-layer) ⟶ branch:p4-boot-package (spine `b341f00d`)',
    '',
    'Three remain.',
  ].join('\n');

  test('MODE and PATH come back from the prose, labelled [source: prose]', () => {
    const s = carriedLines(render(data(LEGACY, {}, { kind: 'task', title: 'P4 boot package' })));
    expect(s).toContain(
      'MODE: build — wiring collapse-by-equivalence into the walk. Do NOT re-open the eval wave.  [source: prose]',
    );
    expect(s).toContain('PATH: roots → tree:canonical → trunk(@moat/memory-layer) ⟶ branch:p4-boot-package (spine `b341f00d`)  [source: prose]');
    expect(s).toContain('SPINE: task b341f00d — P4 boot package  [source: prose]');
  });

  test('the markdown-HEADING form is accepted too (a bare ^MODE: grep never matched it)', () => {
    const c = readCarriedFields({}, '## MODE: debug\n**PATH**: roots → branch:x (spine task deadbeef)');
    expect(c.mode).toEqual({ value: 'debug', source: 'prose' });
    expect(c.spine).toEqual({ ref: 'deadbeef', kind: 'task', source: 'prose' });
  });

  test('a bare `MODE:` with nothing after it is ABSENT, not a spurious empty match', () => {
    expect(extractProseField('MODE', 'MODE:')).toBeNull();
    expect(extractProseField('MODE', 'MODE:   ')).toBeNull();
  });

  test('the typeless and backticked spine forms both parse; an unknown type word does not', () => {
    expect(extractProseSpine('… (spine 7b8af00d) [CLOSED]')).toEqual({ ref: '7b8af00d', kind: 'record' });
    expect(extractProseSpine('… (spine `b341f00d`)')).toEqual({ ref: 'b341f00d', kind: 'record' });
    expect(extractProseSpine('… (spine decision e617f00d)')).toEqual({ ref: 'e617f00d', kind: 'decision' });
    // Refused on purpose: the id8 window must start right after `(spine ` or a KNOWN type.
    expect(extractProseSpine('… (spine session e617f00d)')).toBeNull();
    expect(extractProseSpine('… (spine zzzz)')).toBeNull();
    expect(extractProseSpine('… (spine)')).toBeNull();
    // The leading octet of a full uuid must not be read as a short id.
    expect(extractProseSpine('… (spine b341f00d-1111-2222-3333-444444444444)')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// PROOF 3 — BOTH PRESENT → THE FIELD WINS, VISIBLY.
// ═════════════════════════════════════════════════════════════════════════════════════════

describe('P5.4 proof 3 — precedence: the declared field beats the inferred prose', () => {
  const BOTH = [
    'MODE: research',
    'PATH: roots → trunk(@x) ⟶ branch:old (spine task deadbeef)',
  ].join('\n');

  test('the FIELD value renders and the prose value does not', () => {
    const c = carriedLines(
      render(data(BOTH, { handoff: { mode: 'build', spine: 'b341f00d' } }, { kind: 'task', title: 'T' })),
    );
    expect(c).toContain('MODE: build  [source: field]');
    expect(c).not.toContain('research');
    expect(c).toContain('SPINE: task b341f00d — T  [source: field]');
    expect(c).not.toContain('SPINE: task deadbeef');
  });

  test('the handoff BODY is still rendered verbatim — precedence never rewrites the archive', () => {
    // The losing prose must remain visible in the body. The field wins the DERIVED line;
    // it does not get to edit what the author wrote (the handoffStamp.ts rule).
    const s = handoffSection(
      render(data(BOTH, { handoff: { mode: 'build', spine: 'b341f00d' } }, { kind: 'task', title: 'T' })),
    );
    expect(s).toContain('MODE: research');
    expect(s).toContain('branch:old (spine task deadbeef)');
  });

  test('the PROSE PATH still renders — the two halves fall back INDEPENDENTLY', () => {
    // A field for `mode` must not suppress a prose PATH that has no field equivalent.
    // All-or-nothing fallback would discard a real value because a different one existed.
    const c = carriedLines(render(data(BOTH, { handoff: { mode: 'build' } })));
    expect(c).toContain('MODE: build  [source: field]');
    expect(c).toContain('PATH: roots → trunk(@x) ⟶ branch:old (spine task deadbeef)  [source: prose]');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// PROOF 4 — NEITHER → "(none recorded)". NEVER a fabricated value.
// ═════════════════════════════════════════════════════════════════════════════════════════

describe('P5.4 proof 4 — nothing declared and nothing parseable', () => {
  test('all three lines say "(none recorded)" and no mode is invented', () => {
    const s = carriedLines(render(data('Just some prose about the work.', {})));
    expect(s).toContain('MODE: (none recorded)');
    expect(s).toContain('PATH: (none recorded)');
    expect(s).toContain('SPINE: (none recorded)');
    // The vocabulary must not leak in as a default. If any recognised mode appears here,
    // something defaulted — which is the fabrication this feature exists to prevent.
    for (const m of ['facilitate', 'define-to-lock', 'build', 'debug', 'research']) {
      expect(s).not.toContain(`MODE: ${m}`);
    }
  });

  test('a hostile metadata shape degrades to absent rather than throwing', () => {
    for (const meta of [null, undefined, 'a string', 42, [], { handoff: 'not an object' }, { handoff: [] }]) {
      expect(readCarriedFields(meta, 'no prose here')).toEqual(NO_CARRIED_FIELDS);
    }
  });

  test('the lines are ALWAYS emitted, so absence is a measurement and not an ambiguity', () => {
    // If a line only appeared when it had a value, an absent MODE would be
    // indistinguishable from a MODE the renderer could not read.
    const s = carriedLines(render(data('body', {})));
    expect(s.match(/^MODE: /m)).not.toBeNull();
    expect(s.match(/^PATH: /m)).not.toBeNull();
    expect(s.match(/^SPINE: /m)).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// PROOF 5 — WARN AND STORE. An unrecognised mode is never a rejection.
// ═════════════════════════════════════════════════════════════════════════════════════════

describe('P5.4 proof 5 — the write path warns and stores; it never rejects', () => {
  test('an unrecognised mode is STORED, flagged unrecognised, and WARNED', () => {
    const r = applyCarriedFields('handoff', undefined, { mode: 'yak-shaving' });
    expect(r.metadata).toEqual({ handoff: { mode: 'yak-shaving' } });
    expect(r.report!.mode).toBe('yak-shaving');
    expect(r.report!.modeRecognised).toBe(false);
    expect(r.warnings.join(' ')).toContain('recognised vocabulary');
  });

  test('a RECOGNISED mode stores clean, with no warning — the negative control', () => {
    // Without this, "it warned" proves nothing: a layer that warns on everything is not
    // discriminating, it is noisy.
    const r = applyCarriedFields('handoff', undefined, { mode: 'build' });
    expect(r.report!.modeRecognised).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('casing / spaces / underscores normalize onto the vocabulary instead of warning', () => {
    for (const raw of ['Build', '  BUILD ', 'define to lock', 'define_to_lock']) {
      const r = applyCarriedFields('handoff', undefined, { mode: raw });
      expect(r.report!.modeRecognised).toBe(true);
    }
    expect(applyCarriedFields('handoff', undefined, { mode: 'Define To Lock' }).report!.mode)
      .toBe('define-to-lock');
  });

  test('an over-long mode is TRUNCATED and warned, never rejected', () => {
    const r = applyCarriedFields('handoff', undefined, { mode: 'x'.repeat(500) });
    expect(r.report!.mode!.length).toBe(64);
    expect(r.warnings.join(' ')).toContain('truncated');
  });

  test('a non-id-shaped spine is STORED and warned, and flagged unresolvable', () => {
    const r = applyCarriedFields('handoff', undefined, { spine: 'the-auth-branch' });
    expect(r.metadata).toEqual({ handoff: { spine: 'the-auth-branch' } });
    expect(r.report!.spineResolvable).toBe(false);
    expect(r.warnings.join(' ')).toContain('not a UUID or an 8+-hex short id');
  });

  test('an id-shaped spine passes the shape check clean — the negative control', () => {
    const r = applyCarriedFields('handoff', undefined, { spine: 'B341F00D' });
    expect(r.report!.spine).toBe('b341f00d');
    expect(r.report!.spineResolvable).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('mode/spine on a NON-handoff type are dropped WITH A WARNING, and metadata is untouched', () => {
    const meta = { keep: 'me' };
    const r = applyCarriedFields('completion', meta, { mode: 'build', spine: 'b341f00d' });
    expect(r.metadata).toBe(meta);
    expect(r.report).toBeNull();
    expect(r.warnings.join(' ')).toContain('are carried by `handoff` contexts');
  });

  test('supplying NEITHER field is inert — same metadata object, no report, no warnings', () => {
    const meta = { keep: 'me' };
    const r = applyCarriedFields('handoff', meta, {});
    expect(r.metadata).toBe(meta);
    expect(r.report).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  test('the caller own metadata survives, and a hand-written duplicate is reported', () => {
    const r = applyCarriedFields('handoff', { mine: 1, handoff: { mode: 'debug', mine2: 2 } }, { mode: 'build' });
    expect(r.metadata).toEqual({ mine: 1, handoff: { mode: 'build', mine2: 2 } });
    expect(r.warnings.join(' ')).toContain('replaced a value you also supplied');
  });

  test('an unrecognised mode ROUND-TRIPS to the render unchanged', () => {
    // Proof 5 is only complete if the odd value is also RENDERED — "stored" is half a claim.
    const stored = applyCarriedFields('handoff', undefined, { mode: 'yak-shaving' }).metadata;
    const s = carriedLines(render(data('no prose', stored)));
    expect(s).toContain('MODE: yak-shaving  [source: field]');
  });
});
