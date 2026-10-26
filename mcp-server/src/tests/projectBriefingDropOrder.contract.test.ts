/**
 * THE DROP-ORDER PROTECTION LADDER + THE BACKFILL (2026-08-20).
 *
 * WHAT THIS EXISTS TO CATCH. Measured on project `riverbend` through the real gather and the
 * real render (reports/artifacts/briefing-drop-order-2026-08-20/metrics-before.json): 43 open
 * high-priority tasks older than 7 days sat in the candidate pool and rendered ZERO times,
 * while 3233 of the 24000-char cap went unspent. The first is a sort defect, the second is the
 * cap loop stopping one step early. Both are asserted here as OUTCOMES of a render, never as
 * a property of the comparator read back out of itself.
 *
 * EVERY CONFIG NUMBER BELOW IS A LITERAL. This file must not import the rank constants it is
 * checking: an oracle that reads the value under test from the same source as the subject
 * cannot fail. The literals are the shipped defaults restated by hand, so a change to a
 * default shows up here as a diff someone has to approve.
 */
import { describe, test, expect } from 'vitest';
import {
  renderBriefing,
  briefingConfig,
  type BriefingConfig,
  type BriefingData,
  type BriefingTask,
} from '../services/projectBriefing.js';
import { BRIEFING_PROTECTION_RANK_NONE } from '../config/briefingConfig.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';
import {
  READ_HANDOFF_HEAD_MAX_HOPS,
  READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS,
  READ_HANDOFF_HEAD_REFUSAL_REMEDY,
} from '../config/handoffHeadConfig.js';

/**
 * The fabricated corpus's ONE handoff id. Named so `handoffHead` can be DERIVED from it
 * rather than repeating the literal — a resolution naming a different id than the record
 * it is shown beside would render a header about a record the document is not serving.
 */
const FAB_HANDOFF_ID = '88888888-0000-0000-0000-000000000000';


/** A fixed "now", so STALE is a property of the corpus and not of the day the suite runs. */
const NOW = new Date('2026-08-20T00:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const CFG = (maxChars: number, over: Partial<BriefingConfig> = {}): BriefingConfig => ({
  maxChars,
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
  // ON: the ladder's two priority bands are selection, and selection is behind this switch.
  branchScopeEnabled: true,
  protectionRankBranchMember: 4,
  protectionRankAlwaysSurface: 3,
  protectionRankConvention: 3,
  // an earlier change's measurement knob, restated at its SHIPPED default (the floor) like the ranks
  // above it: a decision gets no band of its own until a measurement says it should.
  protectionRankDecision: 0,
  protectionRankStalePriority: 2,
  protectionRankPriority: 1,
  protectedTaskPriorities: ['urgent', 'high'],
  staleTaskDays: 7,
  backfillEnabled: false,
  // P5.5: this suite asserts the CAP / DROP behaviour of the pre-P5.5 sections, so the
  // "Waiting on a human" section is switched OFF here rather than left to a default. It has
  // its own reserved budget and is not in the global drop pool, so admitting it would add a
  // section to the document these fixtures measure in chars without adding anything the
  // assertions are about. The section's own behaviour is asserted by its own suites.
  waitingSectionEnabled: false,
  waitingReservedChars: 2500,
  waitingMaxRecords: 25,
  waitingFallbackCaveat: 'FAB-FALLBACK-CAVEAT',
  waitingDueHintCaveat: 'FAB-HINT-CAVEAT',
  // OFF: this suite asserts WHICH records the size cap drops and in what order. P5.1's
  // selection quotas would remove records from the pool BEFORE the cap ever saw them, and
  // shape altitude would change every record's cost — so the drop order it measures would no
  // longer be the thing being measured. OFF is the pre-P5.1 document exactly
  // (applyAltitudeFlag), which is what these cases were written against. The cap backstop
  // they guard is unchanged by P5.1; the ON path has its own suite.
  altitudeEnabled: false,
  // The shipped defaults, restated by hand for the reason the ladder literals above are.
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

/**
 * A task whose rendered block has a KNOWN size: the body is padded so every task in a corpus
 * costs the same, which is what lets a cap be chosen to admit exactly N of them.
 *
 * THE DEFAULT PAD IS LARGE ON PURPOSE (measured, not chosen for looks). A drop ADDS frame —
 * the `omitted:` note plus the section's `note:` line, 536 chars on this corpus — so if a
 * record costs less than that, dropping one record never frees room for anything and the
 * intermediate states this file needs to observe are unreachable. A padded record costs
 * ~1260, comfortably more, so each drop is a net saving and every depth is reachable.
 */
function task(marker: string, opts: {
  priority: string;
  status?: string;
  ageDays: number;
  score: number;
  pad?: number;
}): BriefingTask {
  return {
    id: `00000000-0000-0000-0000-${marker.padStart(12, '0')}`,
    title: `${marker}-START`,
    description: `${'y'.repeat(opts.pad ?? 1200)} ${marker}-END`,
    status: opts.status ?? 'todo',
    priority: opts.priority,
    createdAt: daysAgo(opts.ageDays),
    trustSignal: 'trust:test',
    trustScore: opts.score,
    tags: [],
    metadata: null,
  };
}

const census = (n: number) => ({ fetched: n, fetchBoundReached: false, excluded: 0, excludedReason: null });

function data(tasks: BriefingTask[], extra: Partial<BriefingData> = {}): BriefingData {
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'fab',
    handoffHead: resolvedHead({ id: FAB_HANDOFF_ID }),
    handoff: {
      id: FAB_HANDOFF_ID,
      content: 'HANDOFF-START keep me whole HANDOFF-END',
      createdAt: daysAgo(1),
      trustSignal: 'trust:test',
      // No ids named in this fixture's handoff text -> nothing to stamp.
      stamps: NO_HANDOFF_STAMPS,
      // P5.4: this fixture's handoff carries no MODE/PATH prose and no stored
      // mode/spine field, so the carried-fields render is the honest empty one.
      carried: NO_CARRIED_FIELDS,
      spineResolved: null,
    },
    tasks,
    decisions: [],
    conventions: [],
    deadEnds: [],
    branch: null,
    // P5.5: no "Waiting on a human" section in this fabricated corpus — the section is
    // exercised by the waitingOnHuman contract tests. `null` says ABSENT, which is the true
    // claim here; a fabricated EMPTY section would assert a zero nobody measured.
    waiting: null,
    census: {
      tasks: census(tasks.length),
      decisions: census(0),
      conventions: census(0),
      deadEnds: census(0),
      branchMembers: census(0),
    },
    ...extra,
  };
}

/** Which markers survived, in corpus order. */
const survivors = (md: string, markers: readonly string[]): string[] =>
  markers.filter((m) => md.includes(`${m}-START`));

/**
 * THE LARGEST CAP AT WHICH EXACTLY `keep` RECORDS SURVIVE — DERIVED BY SEARCH, never guessed.
 *
 * A hand-picked cap ("full length minus ten") silently stops meaning what it says the moment
 * the frame's wording changes length, which is exactly how the previous version of the
 * neighbouring drop-order test broke. Searching costs a few hundred pure renders and is
 * correct by construction.
 */
function capKeeping(corpus: BriefingTask[], keep: number, over: Partial<BriefingConfig> = {}): number {
  const full = renderBriefing(data(corpus), CFG(1_000_000, over), NOW).markdown.length;
  for (let cap = full; cap >= 50; cap--) {
    const r = renderBriefing(data(corpus), CFG(cap, over), NOW);
    if (corpus.length - r.droppedRecords === keep) return cap;
  }
  throw new Error(`no cap keeps exactly ${keep} of ${corpus.length}`);
}

describe('briefing drop order — the protection ladder', () => {
  /**
   * THE MEASURED DEFECT, in miniature. STALEHI is exactly the record class that rendered zero
   * times on riverbend: open, high priority, older than the stale threshold — and therefore
   * the FIRST thing the old (trust, createdAt) order threw away, because old is what it
   * dropped first. FRESHMED is the record the old order kept: newest, most trusted, medium.
   */
  const STALEHI = task('STALEHI', { priority: 'high', ageDays: 60, score: 0.2 });
  const FRESHMED = task('FRESHMED', { priority: 'medium', ageDays: 1, score: 0.9 });

  /** The cap that admits exactly one of the two. Derived, never guessed. */
  const capForOne = (): number => capKeeping([STALEHI, FRESHMED], 1);

  test('a STALE high-priority task outranks a fresh, better-trusted medium one', () => {
    const r = renderBriefing(data([STALEHI, FRESHMED]), CFG(capForOne()), NOW);
    expect(r.markdown.length).toBeLessThanOrEqual(capForOne());
    expect(survivors(r.markdown, ['STALEHI', 'FRESHMED'])).toEqual(['STALEHI']);
  });

  test('THE FALSIFIER: with the two new bands demoted to 0, the stale task is thrown away again', () => {
    // This is the pre-ladder order restated as config — the ranks the comparator read before
    // this change existed. If the ladder were inert (a rank read from the wrong field, a
    // comparator that ignores it) this case and the one above would agree, and they must not.
    const preLadder = CFG(capForOne(), {
      protectionRankStalePriority: 0,
      protectionRankPriority: 0,
    });
    const r = renderBriefing(data([STALEHI, FRESHMED]), preLadder, NOW);
    expect(survivors(r.markdown, ['STALEHI', 'FRESHMED'])).toEqual(['FRESHMED']);
  });

  test('the bands are ordered blocked > stale-high > fresh-high > unprotected', () => {
    const corpus = [
      task('NONE', { priority: 'low', ageDays: 1, score: 0.99 }),
      task('FRESHHI', { priority: 'high', ageDays: 1, score: 0.98 }),
      task('STALEHI2', { priority: 'high', ageDays: 30, score: 0.97 }),
      task('BLOCKED', { priority: 'low', status: 'blocked', ageDays: 90, score: 0.01 }),
    ];
    const markers = ['NONE', 'FRESHHI', 'STALEHI2', 'BLOCKED'];
    const full = renderBriefing(data(corpus), CFG(1_000_000), NOW).markdown.length;

    // Sweep every cap. The survivor set must always be a SUFFIX of the band order, i.e. the
    // reverse of the drop order — nothing may survive while something above it is gone.
    const bandOrder = ['BLOCKED', 'STALEHI2', 'FRESHHI', 'NONE'];
    const seen = new Set<number>();
    for (let cap = 200; cap <= full + 23; cap += 23) {
      const md = renderBriefing(data(corpus), CFG(cap), NOW).markdown;
      const kept = new Set(survivors(md, markers));
      const idx = bandOrder.map((m) => (kept.has(m) ? 1 : 0));
      expect(idx, `cap=${cap} kept=${[...kept]}`).toEqual([...idx].sort((a, b) => b - a));
      seen.add(kept.size);
    }
    // The sweep has to reach every depth, or "always a suffix" is a claim about one state.
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  test('STALE is measured from created_at against the INJECTED clock, not the wall clock', () => {
    const t = task('EDGE', { priority: 'high', ageDays: 8, score: 0.5 });
    const other = task('OTHER', { priority: 'high', ageDays: 1, score: 0.9 });
    const cap = capKeeping([t, other], 1);
    // 8 days old at NOW -> stale (threshold 7) -> outranks the fresh one.
    expect(survivors(renderBriefing(data([t, other]), CFG(cap), NOW).markdown, ['EDGE', 'OTHER'])).toEqual(['EDGE']);
    // Rewind the clock four days: the SAME record is now 4 days old -> not stale -> same band
    // as OTHER, and the within-band key (trust, then age) keeps the better-trusted OTHER.
    const earlier = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000);
    expect(survivors(renderBriefing(data([t, other]), CFG(cap), earlier).markdown, ['EDGE', 'OTHER'])).toEqual(['OTHER']);
  });

  test('with the SK5 selection flag OFF, both priority bands are inert', () => {
    const off = CFG(capForOne(), { branchScopeEnabled: false });
    const r = renderBriefing(data([STALEHI, FRESHMED]), off, NOW);
    expect(survivors(r.markdown, ['STALEHI', 'FRESHMED'])).toEqual(['FRESHMED']);
  });

  test('the omitted note names the order the comparator actually performs', () => {
    const r = renderBriefing(data([STALEHI, FRESHMED]), CFG(capForOne()), NOW);
    expect(r.markdown).toContain('least-protected first (MANDREL_BRIEFING_PROTECTION_RANK_*)');
    expect(r.markdown).not.toContain('— oldest-least-trusted first');
  });
});

describe('briefing drop order — the backfill spends the leftover budget', () => {
  /**
   * BIG is too large to re-admit; SMALL is small enough to slot into what BIG's eviction
   * freed. Without a backfill the render stops the moment it fits and SMALL stays out.
   */
  const corpus = [
    task('SMALL', { priority: 'low', ageDays: 90, score: 0.01, pad: 20 }),
    task('BIG1', { priority: 'low', ageDays: 50, score: 0.5, pad: 600 }),
    task('BIG2', { priority: 'low', ageDays: 10, score: 0.9, pad: 600 }),
  ];
  const markers = ['SMALL', 'BIG1', 'BIG2'];
  const FULL = () => renderBriefing(data(corpus), CFG(1_000_000), NOW).markdown.length;

  test('ON is never worse than OFF at ANY cap, and is strictly better at some', () => {
    // A SWEEP rather than one hand-picked cap: whether a leftover happens to fit a record is
    // a property of the cap, and a single cap can only ever show one of the two outcomes.
    let strictlyBetter = 0;
    for (let cap = 200; cap <= FULL() + 50; cap += 13) {
      const off = renderBriefing(data(corpus), CFG(cap, { backfillEnabled: false }), NOW);
      const on = renderBriefing(data(corpus), CFG(cap, { backfillEnabled: true }), NOW);
      const kOff = new Set(survivors(off.markdown, markers));
      const kOn = new Set(survivors(on.markdown, markers));
      // MONOTONE: the backfill may only ADD. It must never evict something the cap loop kept.
      for (const m of kOff) expect(kOn.has(m), `cap=${cap}: backfill lost ${m}`).toBe(true);
      // The cap is still a bound — EXCEPT in the honest over-cap state, where the frame plus
      // the never-truncated handoff exceed it on their own and the renderer says so. That
      // state gets its own assertion rather than being folded into the bound: an over-cap
      // render must have nothing left to back-fill, so ON and OFF must be identical there.
      if (on.markdown.includes('size cap exceeded')) {
        expect(on.markdown, `cap=${cap}`).toBe(off.markdown);
      } else {
        expect(on.markdown.length, `cap=${cap}`).toBeLessThanOrEqual(cap);
      }
      // HONEST COUNT: droppedRecords must describe the post-backfill document, not the
      // pre-backfill one — a stale count here is the same defect one layer over.
      expect(on.droppedRecords, `cap=${cap}`).toBe(markers.length - kOn.size);
      if (kOn.size > kOff.size) strictlyBetter++;
    }
    // If this were zero the sweep would prove only that a disabled feature changes nothing.
    expect(strictlyBetter).toBeGreaterThan(0);
  });

  test('the small record is what comes back: first fit skips the one that cannot fit', () => {
    // The cap where the loop keeps exactly one record. BIG1 cannot fit in what is left; SMALL
    // can, and a walk that STOPPED at the first non-fitting candidate would return neither.
    const cap = capKeeping(corpus, 1, { backfillEnabled: false });
    const on = renderBriefing(data(corpus), CFG(cap, { backfillEnabled: true }), NOW);
    expect(survivors(on.markdown, markers)).toEqual(['SMALL', 'BIG2']);
    expect(on.markdown.length).toBeLessThanOrEqual(cap);
  });

  test('the backfill never touches the handoff, at any cap', () => {
    // The handoff is not a droppable, so the walk cannot reach it; asserted as an outcome
    // rather than trusted from the type, and asserted WHOLE (both markers) because the rule
    // it must not break is "complete or absent, never truncated".
    for (let cap = 100; cap <= 2000; cap += 43) {
      const md = renderBriefing(data(corpus), CFG(cap, { backfillEnabled: true }), NOW).markdown;
      expect(md, `cap=${cap}`).toContain('HANDOFF-START keep me whole HANDOFF-END');
    }
  });

  test('the backfill is deterministic: the same inputs give byte-identical output', () => {
    const a = renderBriefing(data(corpus), CFG(capKeeping(corpus, 1, { backfillEnabled: false }), { backfillEnabled: true }), NOW).markdown;
    const b = renderBriefing(data(corpus), CFG(capKeeping(corpus, 1, { backfillEnabled: false }), { backfillEnabled: true }), NOW).markdown;
    expect(a).toBe(b);
  });
});

/**
 * THE CONVENTION BAND (2026-08-24).
 *
 * WHAT THIS EXISTS TO CATCH. Measured on prod project `riverbend` 2026-08-24 through the
 * live `project_briefing`: `## Conventions (0 of 1)`, note `1 of 1 not served — the size
 * cap`. Conventions carried no protection band, so the project's single standing constraint
 * sat at BRIEFING_PROTECTION_RANK_NONE — the tier the cap drains first — and was evicted on
 * every render.
 *
 * THE ORACLE IS BUILT SO ONLY THE BAND CAN SAVE IT. The convention below is deliberately the
 * WORST record in the corpus on every key the comparator falls through to: unscored trust
 * (`null`, which the comparator floors below every real score) and the oldest `createdAt`.
 * A convention that survived because it was newer or better-trusted would prove nothing.
 */
describe('briefing drop order — a convention is a standing constraint, not a spare record', () => {
  const CONV_ID = '00000000-0000-0000-0000-00000000c0de';

  /** Padded to a task-sized block, for the reason `task()`'s default pad is large. */
  const CONVENTION = {
    id: CONV_ID,
    content: `CONV-START ${'z'.repeat(1200)} CONV-END`,
    tags: ['convention'],
    createdAt: daysAgo(365),
    trustSignal: 'trust:test',
    trustScore: null,
    metadata: null,
  };

  /** The rank-1 band (fresh + high) and the floor band, both newer and better-trusted. */
  const FRESHHI = task('CFRESHHI', { priority: 'high', ageDays: 1, score: 0.99 });
  const PLAIN = task('CPLAIN', { priority: 'low', ageDays: 1, score: 0.98 });

  const MARKERS = ['CONV', 'CFRESHHI', 'CPLAIN'];

  const corpusData = (): BriefingData => data([FRESHHI, PLAIN], {
    conventions: [CONVENTION],
    census: {
      tasks: census(2),
      decisions: census(0),
      conventions: census(1),
      deadEnds: census(0),
      branchMembers: census(0),
    },
  });

  /** `capKeeping`, over a corpus that is not all tasks. Derived by search, never guessed. */
  const capKeepingMixed = (keep: number, over: Partial<BriefingConfig> = {}): number => {
    const full = renderBriefing(corpusData(), CFG(1_000_000, over), NOW).markdown.length;
    for (let cap = full; cap >= 50; cap--) {
      const r = renderBriefing(corpusData(), CFG(cap, over), NOW);
      if (MARKERS.length - r.droppedRecords === keep) return cap;
    }
    throw new Error(`no cap keeps exactly ${keep} of ${MARKERS.length}`);
  };

  test('CONTROL: with room for everything, all three render', () => {
    // The probe prints PASS on known-good input before its RED is trusted: if the corpus or
    // the markers were wrong, every other case here would be vacuously satisfied.
    const md = renderBriefing(corpusData(), CFG(1_000_000), NOW).markdown;
    expect(survivors(md, MARKERS)).toEqual(MARKERS);
  });

  test('the convention survives a cap pass that evicts both tasks', () => {
    const cap = capKeepingMixed(1);
    const r = renderBriefing(corpusData(), CFG(cap), NOW);
    expect(r.markdown.length).toBeLessThanOrEqual(cap);
    expect(survivors(r.markdown, MARKERS)).toEqual(['CONV']);
  });

  test('THE FALSIFIER: with the band reverted to NONE, the convention is evicted first', () => {
    // The pre-2026-08-24 order restated as config — a convention at the floor rank. If the
    // band were inert (read from the wrong field, or never reaching the pool) this case and
    // the one above would agree, and they must not.
    const cap = capKeepingMixed(1);
    const reverted = CFG(cap, { protectionRankConvention: 0 });
    const r = renderBriefing(corpusData(), reverted, NOW);
    const kept = survivors(r.markdown, MARKERS);
    expect(kept).not.toContain('CONV');
    expect(kept).toEqual(['CFRESHHI']);
  });

  test('the convention band does not outrank the reader OWN branch position', () => {
    // Ceiling check: the one population the reader explicitly declared they are resuming
    // still wins. PLAIN is a branch member here, so it takes the top band and the convention
    // — worst on every secondary key — is the one that goes.
    const cap = capKeepingMixed(1);
    const withBranch = (): BriefingData => {
      const d = corpusData();
      return {
        ...d,
        branch: {
          spineId: PLAIN.id,
          members: [{
            id: PLAIN.id,
            type: 'task' as const,
            headline: 'CPLAIN-START',
            spineSource: 'recorded' as const,
            createdAt: daysAgo(1),
          }],
        },
        census: { ...d.census, branchMembers: census(1) },
      };
    };
    const kept = survivors(renderBriefing(withBranch(), CFG(cap), NOW).markdown, MARKERS);
    expect(kept).not.toContain('CONV');
  });

  /**
   * THE OFF PATH (added 2026-08-24, Reviewer verdict).
   *
   * WHAT THIS EXISTS TO CATCH, and it is not hypothetical: the first version of this band was
   * left OUT of applySelectionFlag. With MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED off, that flag
   * empties `alwaysSurfaceTaskStatuses` and `protectedTaskPriorities`, so EVERY task falls to
   * the floor rank — and an uncollapsed convention band at 3 made a convention the single
   * most-protected record in the document, ABOVE blocked work. Measured across the live fleet
   * that day (`docker exec <c> printenv MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED`, all 8
   * containers): 6 of 8 instances run OFF, three of them customer tenants. The ON path was
   * correct throughout, which is why no existing case here could see it.
   *
   * The corpus is local to this case because it needs a BLOCKED task — the record the
   * inversion displaced — and the cases above deliberately have none.
   */
  describe('with the branch-scope master switch OFF', () => {
    const CBLOCK = task('CBLOCK', { priority: 'low', status: 'blocked', ageDays: 90, score: 0.5 });

    const offCorpus = (): BriefingData => data([CBLOCK], {
      conventions: [CONVENTION],
      census: {
        tasks: census(1),
        decisions: census(0),
        conventions: census(1),
        deadEnds: census(0),
        branchMembers: census(0),
      },
    });
    const OFF_MARKERS = ['CONV', 'CBLOCK'];

    /** The cap that admits exactly one of the two, derived by search under the given config. */
    const offCapKeeping = (over: Partial<BriefingConfig>): number => {
      const full = renderBriefing(offCorpus(), CFG(1_000_000, over), NOW).markdown.length;
      for (let cap = full; cap >= 50; cap--) {
        const r = renderBriefing(offCorpus(), CFG(cap, over), NOW);
        if (OFF_MARKERS.length - r.droppedRecords === 1) return cap;
      }
      throw new Error('no cap keeps exactly 1 of 2');
    };

    /** Survivors on the OFF path, under an optional rank override. */
    const offSurvivors = (over: Partial<BriefingConfig> = {}): string[] => {
      const cfg = { branchScopeEnabled: false, ...over };
      const cap = offCapKeeping(cfg);
      return survivors(renderBriefing(offCorpus(), CFG(cap, cfg), NOW).markdown, OFF_MARKERS);
    };

    test('CONTROL: with room for everything, both records render', () => {
      const md = renderBriefing(offCorpus(), CFG(1_000_000, { branchScopeEnabled: false }), NOW).markdown;
      expect(survivors(md, OFF_MARKERS)).toEqual(OFF_MARKERS);
    });

    test('the convention band does not reorder the OFF path', () => {
      // Stated as a NAMED outcome and not only as an equality, so it cannot pass vacuously:
      // if both sides returned [] this would still be RED.
      expect(offSurvivors()).toEqual(['CBLOCK']);
      // And the same order the document had before this band existed. `protectionRankConvention: 0`
      // is the pre-band world restated as config; the OFF path must be indistinguishable from it.
      expect(offSurvivors()).toEqual(offSurvivors({ protectionRankConvention: 0 }));
    });

    test('a convention does not outrank blocked work when the switch is off', () => {
      // The inversion in plain terms. Rendered as its own case because this is the sentence a
      // future reader needs to see fail, not a rank comparison.
      expect(offSurvivors()).not.toContain('CONV');
    });
  });
});

/**
 * THE SHIPPED DEFAULT (Reviewer M4, 2026-08-24). Every rank in this file is a hand-restated
 * literal on purpose (see the header), which means flipping a shipped default to 0 leaves this
 * whole suite GREEN — the band would be inert in production and nothing here would notice.
 * ONE assertion closes that for the band this commit adds. `BRIEFING_PROTECTION_RANK_NONE` is
 * the one constant it is safe to import: it is a hard 0, not env-overridable, so this compares
 * the shipped default against the floor rather than against itself.
 */
describe('briefing drop order — the convention band is actually ON in the shipped config', () => {
  test('the shipped default is not the floor rank', () => {
    expect(briefingConfig().protectionRankConvention).not.toBe(BRIEFING_PROTECTION_RANK_NONE);
  });
});
