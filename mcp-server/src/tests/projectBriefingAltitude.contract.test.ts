/**
 * P5.1 — RENDER ALTITUDE + THE STATED SELECTION RULE.
 *
 * WHAT THIS EXISTS TO CATCH, measured on prod `riverbend` 2026-08-24 through the REAL gather
 * and the REAL render (reports/artifacts/p5-1-briefing-altitude/precheck.json, taken BEFORE a
 * line of the feature was written):
 *
 *     sizeChars 23922 of a 24000 cap · droppedRecords 364
 *     served: tasks 5 of 179 · decisions 1 of 167 · conventions 0 of 1
 *
 * The renderer had ONE altitude, so a 24000-char budget ate the project and THE SIZE CAP
 * CHOSE THE CONTENT. And shape-rendering everything does not fit either — 416 records x a
 * measured 147-char mean = 61216 chars, 2.76x the cap with the exempt handoff added. So the
 * deliverable is SHAPE **plus a stated SELECTION RULE**, and the property this file guards is
 * that every record which does not render is attributable to a NAMED rule with a count.
 *
 * THE SHAPE OF THE ASSERTIONS. Everything here is an OUTCOME of a render — a rendered string,
 * or a field on the returned BriefingRender. Nothing reads the selector back out of itself:
 * an oracle that re-implements the comparator cannot fail when the comparator is wrong.
 *
 * CONFIG LITERALS, NOT IMPORTS. The numbers below are written by hand rather than read from
 * config/briefingAltitudeConfig.ts, matching the neighbouring drop-order suite: a test that
 * imports the value it is checking is a test that cannot fail.
 */
import { describe, test, expect } from 'vitest';
import {
  renderBriefing,
  type BriefingConfig,
  type BriefingData,
  type BriefingTask,
  type BriefingDecision,
  type BriefingConvention,
  type BriefingDeadEnd,
} from '../services/projectBriefing.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';
import { readCarriedFields } from '../services/handoffCarriedFields.js';
import {
  READ_HANDOFF_HEAD_MAX_HOPS,
  READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS,
  READ_HANDOFF_HEAD_REFUSAL_REMEDY,
} from '../config/handoffHeadConfig.js';

const FAB_HANDOFF_ID = '88888888-0000-0000-0000-000000000000';

/** A fixed "now", so STALE is a property of the corpus and not of the day the suite runs. */
const NOW = new Date('2026-08-24T00:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

/**
 * A CAP SO LARGE IT CANNOT BIND, for every case that is about SELECTION rather than about the
 * budget. This is the whole point of the item: with the cap unable to bind, anything absent
 * from the document was absent because a RULE said so, and `evictedByCap` must read 0.
 */
const NO_CAP = 5_000_000;

const CFG = (over: Partial<BriefingConfig> = {}): BriefingConfig => ({
  maxChars: NO_CAP,
  conventionTags: ['convention', 'constraint'],
  openTaskStatuses: ['todo', 'in_progress', 'blocked'],
  sectionMaxRecords: 200,
  deadEndReservedChars: 4000,
  handoffHeadMaxHops: READ_HANDOFF_HEAD_MAX_HOPS(),
  handoffHeadCandidateHeadlineChars: READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS(),
  handoffHeadRefusalRemedy: READ_HANDOFF_HEAD_REFUSAL_REMEDY(),
  deadEndTags: ['dead-end', 'deadend', 'rejected'],
  handoffStampEnabled: true,
  handoffStampFormat: ' [now: {status}]',
  // OFF for this suite, for the same reason backfillEnabled/altitudeEnabled are: these cases
  // assert the pre-cfd2ec6c document and its char arithmetic, and the recording directive is
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
  waitingSectionEnabled: false,
  waitingReservedChars: 2500,
  waitingMaxRecords: 25,
  waitingFallbackCaveat: 'FAB-FALLBACK-CAVEAT',
  waitingDueHintCaveat: 'FAB-HINT-CAVEAT',
  branchScopeEnabled: true,
  protectionRankBranchMember: 4,
  protectionRankAlwaysSurface: 3,
  protectionRankConvention: 3,
  // f176d8a5's measurement knob, restated at its SHIPPED default (the floor) like the ranks
  // above it: a decision gets no band of its own until a measurement says it should.
  protectionRankDecision: 0,
  protectionRankStalePriority: 2,
  protectionRankPriority: 1,
  protectedTaskPriorities: ['urgent', 'high'],
  staleTaskDays: 7,
  backfillEnabled: false,
  // THE SHIPPED P5.1 DEFAULTS, restated by hand. Individual cases override the one knob they
  // are about, so an unexpected interaction shows up as a failure in a case that did not name
  // the knob it broke.
  altitudeEnabled: true,
  selectMaxTasks: 28,
  selectMaxDecisions: 16,
  selectMaxConventions: 5,
  selectMaxDeadEnds: 15,
  selectMaxBranchMembers: 26,
  fullProseSlots: 3,
  fullProseTypes: ['task', 'decision'],
  fullProseMaxChars: 1200,
  fullProseExcludeTags: [],
  ...over,
});

// ── Fabricated corpus ────────────────────────────────────────────────────────

function task(marker: string, opts: {
  priority?: string; status?: string; ageDays?: number; score?: number;
  body?: string; tags?: string[];
} = {}): BriefingTask {
  return {
    id: `00000000-0000-0000-0000-${marker.padStart(12, '0')}`,
    title: `${marker}-TITLE`,
    description: opts.body ?? `${marker}-BODYSTART body text ${marker}-BODYEND`,
    status: opts.status ?? 'todo',
    priority: opts.priority ?? 'medium',
    createdAt: daysAgo(opts.ageDays ?? 1),
    trustSignal: 'trust:test',
    trustScore: opts.score ?? 0.5,
    tags: opts.tags ?? [],
    metadata: null,
  };
}

function decision(marker: string, opts: { score?: number; tags?: string[]; why?: string } = {}): BriefingDecision {
  return {
    id: `10000000-0000-0000-0000-${marker.padStart(12, '0')}`,
    title: `${marker}-TITLE`,
    rationale: opts.why ?? `${marker}-WHYSTART because ${marker}-WHYEND`,
    decisionType: 'architecture',
    createdAt: daysAgo(1),
    trustSignal: 'trust:test',
    trustScore: opts.score ?? 0.5,
    tags: opts.tags ?? [],
    metadata: null,
  };
}

function convention(marker: string, opts: { tags?: string[] } = {}): BriefingConvention {
  return {
    id: `20000000-0000-0000-0000-${marker.padStart(12, '0')}`,
    content: `${marker}-CONVSTART all tunables live in named config ${marker}-CONVEND`,
    tags: opts.tags ?? ['convention'],
    createdAt: daysAgo(1),
    trustSignal: 'trust:test',
    trustScore: 0.5,
    metadata: null,
  };
}

function deadEnd(marker: string): BriefingDeadEnd {
  return {
    id: `30000000-0000-0000-0000-${marker.padStart(12, '0')}`,
    kind: 'context',
    basis: 'recorded',
    headline: `${marker}-DEADSTART approach that cannot work`,
    reason: `proved impossible ${marker}`,
    createdAt: daysAgo(1),
  };
}

const census = (n: number) => ({ fetched: n, fetchBoundReached: false, excluded: 0, excludedReason: null });

function data(parts: {
  tasks?: BriefingTask[]; decisions?: BriefingDecision[];
  conventions?: BriefingConvention[]; deadEnds?: BriefingDeadEnd[];
} = {}): BriefingData {
  const tasks = parts.tasks ?? [];
  const decisions = parts.decisions ?? [];
  const conventions = parts.conventions ?? [];
  const deadEnds = parts.deadEnds ?? [];
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'p51-fab',
    // P5.5, added by the integration. null = the section is absent, which is the state this
    // suite was written against — it asserts altitude and selection, not the waiting list.
    waiting: null,
    handoffHead: resolvedHead({ id: FAB_HANDOFF_ID }),
    handoff: {
      id: FAB_HANDOFF_ID,
      content: 'HANDOFF-START the resume point HANDOFF-END',
      createdAt: daysAgo(1),
      trustSignal: 'trust:test',
      stamps: NO_HANDOFF_STAMPS,
      // P5.4, added by the P5.1/P5.4/P5.5 integration. Built by P5.4's REAL reader on empty
      // metadata rather than a hand-written literal: a fixture that restates the shape can
      // drift from it silently, and this suite is not the one asserting carried-field
      // behaviour. Empty metadata + this content yields the honest "no field" result.
      carried: readCarriedFields({}, 'HANDOFF-START the resume point HANDOFF-END'),
      spineResolved: null,
    },
    tasks, decisions, conventions, deadEnds,
    branch: null,
    census: {
      tasks: census(tasks.length),
      decisions: census(decisions.length),
      conventions: census(conventions.length),
      deadEnds: census(deadEnds.length),
      branchMembers: census(0),
    },
  };
}

/** Markers whose SHAPE line is present (the one-liner grammar: `[YYYY-MM-DD] [kind:id]`). */
const shapeMarkers = (md: string, markers: readonly string[]): string[] =>
  markers.filter((m) => new RegExp(`^- \\[\\d{4}-\\d{2}-\\d{2}\\] \\[\\w+:\\w+\\] ${m}-TITLE`, 'm').test(md));

/** Markers whose BODY was rendered (full altitude). */
const bodyMarkers = (md: string, markers: readonly string[]): string[] =>
  markers.filter((m) => md.includes(`${m}-BODYSTART`));

// ══════════════════════════════════════════════════════════════════════════════
// 1. THE SELECTION RULE — chosen before the budget, named, counted
// ══════════════════════════════════════════════════════════════════════════════

describe('P5.1 selection rule — a stated rule chooses, the cap is the backstop', () => {
  const CORPUS = Array.from({ length: 50 }, (_, i) => task(`T${String(i).padStart(2, '0')}`));

  test('the quota decides how many are served, with a cap that CANNOT bind', () => {
    const r = renderBriefing(data({ tasks: CORPUS }), CFG({ selectMaxTasks: 10 }), NOW);
    expect(r.included.tasks).toBe(10);
    // THE PROPERTY THE WHOLE ITEM IS FOR: nothing was lost to the budget.
    expect(r.evictedByCap).toBe(0);
    expect(r.excludedBySelection.total).toBe(40);
    expect(r.excludedBySelection.byRule['section quota (MANDREL_BRIEFING_SELECT_MAX_TASKS)']).toBe(40);
    // …and `droppedRecords` is still their sum, for callers that already read it.
    expect(r.droppedRecords).toBe(40);
  });

  test('the section heading NAMES the rule and its count — not "the size cap"', () => {
    const md = renderBriefing(data({ tasks: CORPUS }), CFG({ selectMaxTasks: 10 }), NOW).markdown;
    expect(md).toContain('## Open tasks (10 of 50)');
    expect(md).toContain('40 of 50 not served — section quota (MANDREL_BRIEFING_SELECT_MAX_TASKS)');
    // The cap is NOT named for absences it did not cause. This is the defect in miniature:
    // a footer that blames the budget sends every reader to the one knob that will not help.
    expect(md).not.toContain('not served — the size cap');
    expect(md).toContain('not served by RULE: 40 records were excluded by a stated selection rule');
  });

  test('the quota keeps the BEST-ranked, not the first in the array', () => {
    // The protection ladder's own vocabulary: `blocked` is the always-surface band. It sits
    // LAST in the array and is the OLDEST record, so a quota that kept "the first N" or "the
    // newest N" would drop it — and the pre-P5.1 cap would have dropped it last.
    const corpus = [
      task('FRESH1'), task('FRESH2'), task('FRESH3'),
      task('BLOCKED', { status: 'blocked', ageDays: 400 }),
    ];
    const r = renderBriefing(data({ tasks: corpus }), CFG({ selectMaxTasks: 1, fullProseSlots: 0 }), NOW);
    expect(shapeMarkers(r.markdown, ['FRESH1', 'FRESH2', 'FRESH3', 'BLOCKED'])).toEqual(['BLOCKED']);
    expect(r.evictedByCap).toBe(0);
  });

  test('QUOTA ZERO is a legitimate value — serve none, and say the rule did it', () => {
    // C3's empty population, from the config side: the value most likely to be mishandled.
    const r = renderBriefing(data({ tasks: CORPUS }), CFG({ selectMaxTasks: 0 }), NOW);
    expect(r.included.tasks).toBe(0);
    expect(r.evictedByCap).toBe(0);
    expect(r.excludedBySelection.total).toBe(50);
    expect(r.markdown).toContain('## Open tasks (0 of 50)');
    expect(r.markdown).toContain('50 of 50 not served — section quota (MANDREL_BRIEFING_SELECT_MAX_TASKS)');
    // `none` is an AFFIRMATIVE claim about the population and MUST NOT be emitted here:
    // 50 records exist, a rule chose against all of them.
    expect(r.markdown).not.toMatch(/## Open tasks \(0 of 50\)\nnone/);
  });

  test('an EMPTY population still renders, and claims nothing (C3)', () => {
    const r = renderBriefing(data(), CFG(), NOW);
    // P5.5, added by the P5.1/P5.4/P5.5 integration. `included` now reports the
    // Waiting-on-a-human section too, and these are EXACT-SHAPE assertions on purpose —
    // so the new key is stated rather than the assertion loosened to a subset match.
    // 0 because this suite's fixtures set `waiting: null` (section absent).
    expect(r.included).toEqual({ tasks: 0, decisions: 0, conventions: 0, deadEnds: 0, branchMembers: 0, waiting: 0 });
    expect(r.excludedBySelection.total).toBe(0);
    expect(r.evictedByCap).toBe(0);
    expect(r.droppedRecords).toBe(0);
    expect(r.fullProse).toEqual({ slots: 0, granted: 0, denied: 0 });
    expect(r.markdown).toContain('## Open tasks (0)');
    // Here `none` IS licensed — the population is genuinely zero.
    expect(r.markdown).toMatch(/## Open tasks \(0\)\nnone/);
    expect(r.markdown).not.toContain('not served by RULE');
  });

  test('EVERY section carries a quota, so no absence is attributable to a budget alone', () => {
    const r = renderBriefing(
      data({
        tasks: Array.from({ length: 4 }, (_, i) => task(`TT${i}`)),
        decisions: Array.from({ length: 4 }, (_, i) => decision(`DD${i}`)),
        conventions: Array.from({ length: 4 }, (_, i) => convention(`CC${i}`)),
        deadEnds: Array.from({ length: 4 }, (_, i) => deadEnd(`EE${i}`)),
      }),
      CFG({
        selectMaxTasks: 1, selectMaxDecisions: 1, selectMaxConventions: 1, selectMaxDeadEnds: 1,
        fullProseSlots: 0,
      }),
      NOW,
    );
    // P5.5, added by the P5.1/P5.4/P5.5 integration. `included` now reports the
    // Waiting-on-a-human section too, and these are EXACT-SHAPE assertions on purpose —
    // so the new key is stated rather than the assertion loosened to a subset match.
    // 0 because this suite's fixtures set `waiting: null` (section absent).
    expect(r.included).toEqual({ tasks: 1, decisions: 1, conventions: 1, deadEnds: 1, branchMembers: 0, waiting: 0 });
    expect(r.evictedByCap).toBe(0);
    expect(r.excludedBySelection.byRule).toEqual({
      'section quota (MANDREL_BRIEFING_SELECT_MAX_TASKS)': 3,
      'section quota (MANDREL_BRIEFING_SELECT_MAX_DECISIONS)': 3,
      'section quota (MANDREL_BRIEFING_SELECT_MAX_CONVENTIONS)': 3,
      'section quota (MANDREL_BRIEFING_SELECT_MAX_DEAD_ENDS)': 3,
      'section quota (MANDREL_BRIEFING_SELECT_MAX_BRANCH_MEMBERS)': 0,
    });
    for (const knob of ['TASKS', 'DECISIONS', 'CONVENTIONS', 'DEAD_ENDS']) {
      expect(r.markdown).toContain(`3 of 4 not served — section quota (MANDREL_BRIEFING_SELECT_MAX_${knob})`);
    }
  });

  test('the cap is still a backstop, and its evictions are reported SEPARATELY', () => {
    // A cap tight enough to bite AFTER selection: the two numbers must both be non-zero and
    // must not be conflated. Two absences, two names, one sum.
    const corpus = Array.from({ length: 20 }, (_, i) => task(`X${String(i).padStart(2, '0')}`, { body: 'z'.repeat(400) }));
    const full = renderBriefing(data({ tasks: corpus }), CFG({ selectMaxTasks: 10 }), NOW).markdown.length;
    const r = renderBriefing(data({ tasks: corpus }), CFG({ selectMaxTasks: 10, maxChars: full - 1200 }), NOW);
    expect(r.excludedBySelection.total).toBe(10);
    expect(r.evictedByCap).toBeGreaterThan(0);
    expect(r.droppedRecords).toBe(r.excludedBySelection.total + r.evictedByCap);
    expect(r.markdown).toContain('not served by RULE: 10 records were excluded');
    expect(r.markdown).toMatch(/^omitted: \d+ whole records dropped to honor the size cap/m);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. THE TWO ALTITUDES + THE RESERVED SLOTS
// ══════════════════════════════════════════════════════════════════════════════

describe('P5.1 altitude — shape by default, full prose in reserved slots', () => {
  const CORPUS = Array.from({ length: 6 }, (_, i) => task(`S${i}`, { score: 0.9 - i * 0.1 }));

  test('with ZERO slots every served record is a SHAPE line and no body is rendered', () => {
    const r = renderBriefing(data({ tasks: CORPUS }), CFG({ fullProseSlots: 0 }), NOW);
    const markers = CORPUS.map((_, i) => `S${i}`);
    expect(shapeMarkers(r.markdown, markers)).toEqual(markers);
    expect(bodyMarkers(r.markdown, markers)).toEqual([]);
    expect(r.fullProse).toEqual({ slots: 0, granted: 0, denied: 0 });
  });

  test('slots are spent BEST-FIRST and are bounded by the slot count', () => {
    const r = renderBriefing(data({ tasks: CORPUS }), CFG({ fullProseSlots: 2 }), NOW);
    // S0 has the highest trust score, S1 the next: the two best-ranked get the two slots.
    expect(bodyMarkers(r.markdown, CORPUS.map((_, i) => `S${i}`))).toEqual(['S0', 'S1']);
    expect(r.fullProse).toEqual({ slots: 2, granted: 2, denied: 0 });
    // Everything else is still SERVED — at shape altitude. Absence and brevity are different.
    expect(r.included.tasks).toBe(6);
  });

  test('a body longer than the bound is CUT, and says so where the cut happened', () => {
    const long = task('LONG', { score: 0.99, body: `LONG-BODYSTART ${'q'.repeat(3000)} LONG-BODYEND` });
    const r = renderBriefing(data({ tasks: [long] }), CFG({ fullProseMaxChars: 500 }), NOW);
    expect(r.markdown).toContain('LONG-BODYSTART');
    expect(r.markdown).not.toContain('LONG-BODYEND'); // the tail is past the bound
    expect(r.markdown).toContain('…truncated at 500 chars (MANDREL_BRIEFING_FULL_PROSE_MAX_CHARS)');
  });

  test('a body INSIDE the bound is rendered whole and nothing claims a truncation', () => {
    // The negative control for the case above: a probe that only ever sees the cut state
    // cannot tell "it truncates" from "it always prints the marker".
    const r = renderBriefing(data({ tasks: [task('SHORT', { score: 0.99 })] }), CFG({ fullProseMaxChars: 500 }), NOW);
    expect(r.markdown).toContain('SHORT-BODYSTART');
    expect(r.markdown).toContain('SHORT-BODYEND');
    expect(r.markdown).not.toContain('truncated at');
  });

  test('shape lines are NEVER truncated, however long the title', () => {
    // The failure mode the scope named explicitly: squeezing titles to make an impossible
    // budget appear to fit. A 900-char title survives whole at shape altitude.
    const huge = 'W'.repeat(900);
    const t: BriefingTask = { ...task('HUGE'), title: `${huge}-TITLE` };
    const r = renderBriefing(data({ tasks: [t] }), CFG({ fullProseSlots: 0 }), NOW);
    expect(r.markdown).toContain(`${huge}-TITLE`);
    expect(r.markdown).not.toContain('…truncated');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. THE SLOT IS NEVER REASSIGNED — a denial is spent, and it is IN-BAND
// ══════════════════════════════════════════════════════════════════════════════

describe('P5.1 full-prose gate — a denial consumes its slot and says why', () => {
  test('a type outside the vocabulary renders its denial in-band and does NOT pass the slot on', () => {
    const corpus = [task('BEST', { score: 0.9 }), task('NEXT', { score: 0.8 })];
    const r = renderBriefing(
      data({ tasks: corpus }),
      // `task` is deliberately absent, so the best-ranked record is refused.
      CFG({ fullProseSlots: 1, fullProseTypes: ['decision'] }),
      NOW,
    );
    expect(r.fullProse).toEqual({ slots: 1, granted: 0, denied: 1 });
    // NOT REASSIGNED: the runner-up did not inherit the refused slot.
    expect(bodyMarkers(r.markdown, ['BEST', 'NEXT'])).toEqual([]);
    // IN-BAND: the reader is told, next to the record, why it is a one-liner.
    expect(r.markdown).toContain(
      '[full-prose slot 1 DENIED: type not in MANDREL_BRIEFING_FULL_PROSE_TYPES: task] — rendered as shape; the slot is not reassigned',
    );
  });

  test('an excluded TAG denies the slot and names the tag that matched', () => {
    const corpus = [task('TAGGED', { score: 0.9, tags: ['component-registry'] }), task('CLEAN', { score: 0.8 })];
    const r = renderBriefing(data({ tasks: corpus }), CFG({ fullProseSlots: 1, fullProseExcludeTags: ['component-registry'] }), NOW);
    expect(r.fullProse).toEqual({ slots: 1, granted: 0, denied: 1 });
    expect(r.markdown).toContain('[full-prose slot 1 DENIED: tagged in MANDREL_BRIEFING_FULL_PROSE_EXCLUDE_TAGS: component-registry]');
    expect(bodyMarkers(r.markdown, ['TAGGED', 'CLEAN'])).toEqual([]);
  });

  test('THE EXCLUDE VOCABULARY SHIPS EMPTY — the same record is granted with the default', () => {
    // The negative control for the case above, and the product claim it protects: the
    // MECHANISM ships, our `component-registry` vocabulary does not (SCOPE §4). With the
    // shipped empty default the tag means nothing.
    const r = renderBriefing(
      data({ tasks: [task('TAGGED', { score: 0.9, tags: ['component-registry'] })] }),
      CFG({ fullProseSlots: 1 }),
      NOW,
    );
    expect(r.fullProse).toEqual({ slots: 1, granted: 1, denied: 0 });
    expect(bodyMarkers(r.markdown, ['TAGGED'])).toEqual(['TAGGED']);
  });

  test('the tag gate is checked BEFORE the type gate, and only ONE reason is given', () => {
    // A record that fails both must not render two denial lines on one slot: a slot is one
    // decision, and two reasons on one line item reads as two slots spent.
    const r = renderBriefing(
      data({ tasks: [task('BOTH', { score: 0.9, tags: ['skipme'] })] }),
      CFG({ fullProseSlots: 1, fullProseTypes: ['decision'], fullProseExcludeTags: ['skipme'] }),
      NOW,
    );
    expect(r.fullProse).toEqual({ slots: 1, granted: 0, denied: 1 });
    expect(r.markdown).toContain('DENIED: tagged in MANDREL_BRIEFING_FULL_PROSE_EXCLUDE_TAGS: skipme');
    expect(r.markdown).not.toContain('DENIED: type not in');
  });

  test('slots are a DOCUMENT budget, not a per-section one', () => {
    // A project whose best records are all decisions gets decisions in the slots.
    const r = renderBriefing(
      data({
        tasks: [task('LOWT', { score: 0.1 })],
        decisions: [decision('HIGHD1', { score: 0.99 }), decision('HIGHD2', { score: 0.98 })],
      }),
      CFG({ fullProseSlots: 2 }),
      NOW,
    );
    expect(r.fullProse).toEqual({ slots: 2, granted: 2, denied: 0 });
    expect(r.markdown).toContain('HIGHD1-WHYSTART');
    expect(r.markdown).toContain('HIGHD2-WHYSTART');
    expect(bodyMarkers(r.markdown, ['LOWT'])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. THE KILL SWITCH — OFF is pre-P5.1, and it is the SAME code path
// ══════════════════════════════════════════════════════════════════════════════

describe('P5.1 kill switch — MANDREL_BRIEFING_ALTITUDE_ENABLED=false is pre-P5.1', () => {
  const CORPUS = Array.from({ length: 40 }, (_, i) => task(`O${String(i).padStart(2, '0')}`));

  test('OFF: every record is served at FULL altitude and no quota excludes anything', () => {
    const r = renderBriefing(data({ tasks: CORPUS }), CFG({ altitudeEnabled: false }), NOW);
    const markers = CORPUS.map((_, i) => `O${String(i).padStart(2, '0')}`);
    expect(r.included.tasks).toBe(40);
    expect(bodyMarkers(r.markdown, markers)).toEqual(markers);
    expect(shapeMarkers(r.markdown, markers)).toEqual([]);
    expect(r.excludedBySelection.total).toBe(0);
    expect(r.evictedByCap).toBe(0);
    expect(r.markdown).not.toContain('not served by RULE');
    expect(r.markdown).not.toContain('DENIED');
  });

  test('OFF: a CONVENTION does not consume a slot, so no denial line appears', () => {
    // The specific way this could have gone wrong. `convention` is absent from the shipped
    // fullProseTypes, so an OFF path that collapsed only the slot COUNT would emit a denial
    // line for every convention — one line of difference per record from pre-P5.1.
    const r = renderBriefing(
      data({ conventions: [convention('CV1'), convention('CV2')] }),
      CFG({ altitudeEnabled: false }),
      NOW,
    );
    expect(r.markdown).toContain('CV1-CONVSTART');
    expect(r.markdown).toContain('CV2-CONVSTART');
    expect(r.markdown).not.toContain('DENIED');
    expect(r.fullProse.denied).toBe(0);
  });

  test('OFF: a 3000-char body is NOT truncated, whatever fullProseMaxChars says', () => {
    const long = task('LONGOFF', { body: `LONGOFF-BODYSTART ${'q'.repeat(3000)} LONGOFF-BODYEND` });
    const r = renderBriefing(data({ tasks: [long] }), CFG({ altitudeEnabled: false, fullProseMaxChars: 100 }), NOW);
    expect(r.markdown).toContain('LONGOFF-BODYEND');
    expect(r.markdown).not.toContain('truncated at 100 chars');
    expect(r.markdown).not.toContain('truncated:');
  });

  test('OFF: the pre-P5.1 footer wording is emitted VERBATIM when the cap drops records', () => {
    // The exact sentence pre-P5.1 ended on. It is asserted here because it is the observable
    // half of the byte-identity claim: the OFF path must not merely serve the same records,
    // it must produce the same bytes, and the footer is where a P5.1-shaped edit would leak.
    const corpus = Array.from({ length: 12 }, (_, i) => task(`F${i}`, { body: 'z'.repeat(600) }));
    const full = renderBriefing(data({ tasks: corpus }), CFG({ altitudeEnabled: false }), NOW).markdown.length;
    const r = renderBriefing(data({ tasks: corpus }), CFG({ altitudeEnabled: false, maxChars: full - 2000 }), NOW);
    expect(r.evictedByCap).toBeGreaterThan(0);
    expect(r.excludedBySelection.total).toBe(0);
    expect(r.markdown).toMatch(/^omitted: \d+ whole records dropped to honor the size cap .*nothing was truncated$/m);
    expect(r.markdown).not.toContain('not served by RULE');
  });
});
