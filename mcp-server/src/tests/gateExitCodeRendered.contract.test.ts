/**
 * THE GATE'S EXIT CODE MUST SURVIVE THE RENDER — contract.
 *
 * GUARDS-CLASS: renderer-drops-structured-fact
 *
 * THE DEFECT THIS LOCKS, MEASURED BEFORE THE FIX rather than imagined. On 2026-09-03 the
 * SHIPPED renderers were driven with five records differing ONLY in their stored gate result
 * (harness: the same renderThreadText/renderCurrentStateText calls this file makes). Output:
 *
 *   rc=0  → [context verdict:APPROVE] ★ REVIEWER VERDICT — an earlier task … — trust:trusted
 *   rc=1  → [context verdict:REJECT]  ★ REVIEWER VERDICT — an earlier task … — trust:trusted
 *   rc=2  → [context verdict:REJECT]  ★ REVIEWER VERDICT — an earlier task … — trust:trusted
 *   rc=40 → [context]                 ★ BUILDER REPORT   — an earlier task … — trust:trusted
 *   no rc → [context verdict:APPROVE-PENDING-GATE] …
 *
 * Three things are true of that output and each is a test below:
 *   1. THE EXIT CODE APPEARS NOWHERE. The task's framing — "the boot package speaks only in
 *      GREEN/RED" — is generous: at the `headline` altitude a boot package uses there is no
 *      body at all, so GREEN/RED survive only if an author happened to put them inside the
 *      first line, before the title clip.
 *   2. rc=1 AND rc=2 RENDER BYTE-IDENTICAL LINES. A MEASURED failure and "I could not
 *      measure" are opposite instructions — one is a bug to fix, the other is an instrument
 *      to repair (CLASSES.md C1; the same rule captureVocab.ts keeps for `absent`).
 *   3. THE REF IS NOT ON THE LINE, so when a run went RED a reader cannot tell WHICH tree
 *      failed. The pre-registered fact class was "gate refs + exit codes", both halves.
 *
 * WHY THESE GUARDS ASSERT ON THE SHIPPED RENDERERS' OUTPUT and not on gateOutcomeOf alone:
 * a derivation-only suite stays green if the stamp is deleted from the lines tomorrow, which
 * is exactly the failure mode the sibling an earlier task was written against. Mutation-probed:
 * deleting `${gateOutcomeStamp(n)}` from the two renderers takes §1 and §2 RED.
 *
 * EVERY EXPECTED STRING IS A LITERAL, deliberately — the same rule
 * reviewOutcomeRendered.contract.test.ts states and keeps. An oracle that reads the label it
 * is checking out of the config the renderer reads proves only that the code agrees with
 * itself. §5 is the one exception and says so: it compares two SOURCES against each other.
 *
 * NO DATABASE IS PROVISIONED OR QUERIED — but this file is not importable without database
 * ENV (importing recall.routes pulls in handlers/project). Run it with the gate's Stage 1
 * pins, not standalone.
 */

import { describe, test, expect } from 'vitest';

import { renderThreadText, renderCurrentStateText } from '../routes/recall.routes.js';
import type { CurrentStateResult } from '../services/currentState.js';
import { shapeNode, gateOutcomeOf, type ThreadNode } from '../services/recallThreadCore.js';
import { deriveContextTitle } from '../services/recallThread.js';
import { projectCurrentState, type CurrentStateInputNode } from '../services/currentStateCore.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import { THREAD_CONFIG, THREAD_CONTENT_ALTITUDES } from '../config/threadConfig.js';
import {
  GATE_STAMP_WORST_CASE_CHARS,
  GATE_REF_RENDER_CHARS,
} from '../config/gateExitCodeConfig.js';
import type { Trust } from '../services/trustModel.js';
import type { ThreadResult } from '../services/recallThread.js';

// ── FIXTURES ────────────────────────────────────────────────────────────────

const TRUST: Trust = {
  band: 'trusted', // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
  score: 0.95,
  outcome: { score: 1, samples: 2 },
  freshness: 0.9,
  superseded: false,
  softSuperseded: false,
  abstain: false, // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
  supersession: null,
  reason: 'trusted',
  promotionRequirement: null,
  supersessionGuard: { enabled: false, checked: 0, suppressed: [], undecided: [] },
};

/**
 * A verdict record as it is ACTUALLY STORED. The gate sentence sits in the BODY, one blank
 * line down — which is where every real one sits, and which is why the headline clip eats it.
 * Faking a record whose first line states the gate would fake away the defect.
 */
const VERDICT_CONTENT =
  '★ REVIEWER VERDICT — task 2522f00d (lane F). ROUND: 2. REJECT.\n\n' +
  'GATE: scripts/ci-clean-gate.sh on 9305f00d1b2c3d4e5f60718293a4b5c6d7e8f900.';
const VERDICT_TITLE = deriveContextTitle(VERDICT_CONTENT)!;

/** The two refs used below, full-length, as a real record stores them. */
const GREEN_REF = '3fd8f00dff80df3a44ae1ec8f7bcad8fb8ffc2f4';
const RED_REF = '9305f00d1b2c3d4e5f60718293a4b5c6d7e8f900';

function threadResult(nodes: ThreadNode[]): ThreadResult {
  return {
    anchor: 'a'.repeat(8),
    altitude: 'headline',
    nodes,
    edges: [],
    truncated: false,
    truncatedCount: 0,
    depthUsed: 2,
    maxNodesUsed: 50,
    abstain: [],
    omissions: { examined: nodes.length, droppedDangling: 0, droppedByMinTrust: 0, droppedEdges: 0, clippedNodes: 0 },
  } as unknown as ThreadResult;
}

/** Shape a node the way the product does, then render the STORY channel the way it does. */
function storyLineFor(metadata: unknown, altitude = 'headline' as const): string {
  const n = shapeNode(
    {
      id: '22222222-0000-4000-8000-000000000000',
      type: 'context',
      title: VERDICT_TITLE,
      content: null,
      metadata,
    },
    TRUST,
    altitude,
    THREAD_CONFIG
  );
  return renderThreadText(threadResult([n]));
}

let seq = 0;
/** …and the CURRENT-STATE channel the way it does. */
function currentStateLineFor(metadata: unknown): string {
  seq += 1;
  const input = {
    id: `1111111${seq}-0000-4000-8000-000000000000`,
    type: 'context',
    title: VERDICT_TITLE,
    content: null,
    createdAt: new Date(Date.UTC(2026, 7, 21)),
    updatedAt: null,
    status: null,
    outcomeStatus: null,
    implementationStatus: null,
    contextType: 'completion',
    metadata,
    trust: TRUST,
  } as CurrentStateInputNode;
  const state = projectCurrentState(
    [input],
    '11111111-0000-4000-8000-000000000000',
    CURRENT_STATE_CONFIG,
    THREAD_CONFIG
  );
  return renderCurrentStateText({
    ...state,
    truncated: false,
    truncatedCount: 0,
    depthUsed: 2,
    maxNodesUsed: 50,
    maxNodesRequested: 50,
    omissions: { examined: 1, droppedDangling: 0, droppedByMinTrust: 0, droppedEdges: 0, clippedNodes: 0 },
  } as CurrentStateResult);
}

// ── 1. THE EXIT CODE REACHES THE RENDERED LINE, IN BOTH CHANNELS ────────────

describe('the stored gate exit code survives the render', () => {
  test('STORY channel — a measured GREEN renders its code, its label and its ref', () => {
    const text = storyLineFor({ gate: { exitCode: 0, ref: GREEN_REF } });
    expect(text).toContain('gate-rc:0=GREEN@3fd8f00d');
  });

  test('STORY channel — a measured RED renders its code, its label and ITS OWN ref', () => {
    // The second half of the defect: when a run went RED, the ref THAT run executed on was
    // never given separately from the GREEN one.
    const text = storyLineFor({ gate: { exitCode: 1, ref: RED_REF } });
    expect(text).toContain('gate-rc:1=RED@9305f00d');
    expect(text).not.toContain('3fd8f00d');
  });

  test('CURRENT-STATE channel — the code renders in the lifecycle stamp', () => {
    expect(currentStateLineFor({ gate: { exitCode: 1, ref: RED_REF } })).toContain(
      'gate-rc:1=RED@9305f00d'
    );
  });

  test('the stamp survives at EVERY content altitude, headline included', () => {
    // The altitude that clips hardest is the one a boot package uses, and it is exactly where
    // the code was being lost. Enumerated from the product's own altitude list.
    for (const altitude of THREAD_CONTENT_ALTITUDES) {
      const text = storyLineFor({ gate: { exitCode: 2, ref: RED_REF } }, altitude as 'headline');
      expect(text, `altitude ${altitude}`).toContain('gate-rc:2=CANNOT-MEASURE@9305f00d');
    }
  });
});

// ── 2. THE THREE STATES ARE THREE, NOT TWO ──────────────────────────────────

describe('PASS / FAIL / COULD-NOT-MEASURE are distinguishable', () => {
  test('rc=1 and rc=2 no longer render the same line — the measured defect', () => {
    // THE CENTRAL ASSERTION. Before the fix these two strings were byte-identical; that
    // equality is what told a reader "the thing failed" when the truth was "we could not
    // tell", and those demand opposite responses.
    const red = storyLineFor({ verdict: 'REJECT', gate: { exitCode: 1, ref: RED_REF } });
    const cannotMeasure = storyLineFor({ verdict: 'REJECT', gate: { exitCode: 2, ref: RED_REF } });
    expect(red).not.toEqual(cannotMeasure);
    expect(red).toContain('gate-rc:1=RED');
    expect(cannotMeasure).toContain('gate-rc:2=CANNOT-MEASURE');
    // And neither may be mistaken for the other's word.
    expect(red).not.toContain('CANNOT-MEASURE');
    expect(cannotMeasure).not.toContain('gate-rc:1=');
  });

  test('all five namespace members render five DISTINCT stamps', () => {
    // Enumerated as literals — the namespace is an earlier decision's contract, restated in
    // scripts/ci-clean-gate.sh's header. A new member that silently shared a label with an
    // existing one would fail here.
    const stamps = [0, 1, 2, 3, 40].map(
      (rc) => gateOutcomeOf({ gate: { exitCode: rc } }) as string
    );
    expect(stamps).toEqual([
      '0=GREEN',
      '1=RED',
      '2=CANNOT-MEASURE',
      '3=SKIP',
      '40=STATIC-GREEN',
    ]);
    expect(new Set(stamps).size).toBe(5);
  });

  test('a STATIC green is not the same word as a full-gate green', () => {
    // rc=40 exists precisely so no caller can mistake a 48-of-65 subset for the ship
    // condition by reading rc alone. A render that called both "GREEN" would undo that.
    const full = storyLineFor({ gate: { exitCode: 0, ref: GREEN_REF } });
    const staticGreen = storyLineFor({ gate: { exitCode: 40, ref: GREEN_REF } });
    expect(full).not.toEqual(staticGreen);
    expect(staticGreen).toContain('gate-rc:40=STATIC-GREEN');
  });
});

// ── 3. THE FOUR ABSENCES ARE NOT ONE ABSENCE ────────────────────────────────

describe('absence states', () => {
  test('no gate block at all renders NOTHING — never an invented stamp', () => {
    // Absence is absence. A gate stamp on a record that never claimed a gate is the same
    // fabrication as inferring approval from a merge.
    expect(gateOutcomeOf({ verdict: 'APPROVE' })).toBeNull();
    expect(gateOutcomeOf(null)).toBeNull();
    expect(gateOutcomeOf(undefined)).toBeNull();
    expect(gateOutcomeOf('not an object')).toBeNull();
    expect(gateOutcomeOf([{ gate: { exitCode: 0 } }])).toBeNull();
    expect(storyLineFor({ verdict: 'APPROVE' })).not.toContain('gate-rc:');
  });

  test('a DECLARED run:false renders NOT-RUN, distinct from every measured code', () => {
    // 30 of the 67 live records carry this shape (measured on prod 2026-09-03).
    expect(gateOutcomeOf({ gate: { run: false, exitCode: null } })).toBe('none=NOT-RUN');
    expect(storyLineFor({ gate: { run: false } })).toContain('gate-rc:none=NOT-RUN');
  });

  test('a GREEN WITH NO rc is visibly distinguishable from rc=0 and rc=40', () => {
    // The task's own acceptance sentence, executed. A gate block that mentions a name and a
    // GREEN word but carries no code is NOT-RECORDED: something was said, the code is not
    // recoverable, and this module does not parse the sentence to guess it.
    const noCode = storyLineFor({ gate: { name: 'scripts/ci-clean-gate.sh', result: 'GREEN' } });
    const rc0 = storyLineFor({ gate: { name: 'scripts/ci-clean-gate.sh', exitCode: 0 } });
    const rc40 = storyLineFor({ gate: { name: 'scripts/ci-clean-gate.sh', exitCode: 40 } });
    expect(noCode).toContain('gate-rc:none=NOT-RECORDED');
    expect(noCode).not.toEqual(rc0);
    expect(noCode).not.toEqual(rc40);
    expect(rc0).not.toEqual(rc40);
  });

  test('NOT-RUN and NOT-RECORDED are different facts and do not share a word', () => {
    // "the writer said it did not run" is not "the writer said nothing about whether it ran".
    expect(gateOutcomeOf({ gate: { run: false } })).not.toBe(gateOutcomeOf({ gate: { name: 'x' } }));
  });

  test('a free-prose STRING gate block is NOT-RECORDED, never parsed for a verdict', () => {
    // 14 of the 67 live records store a sentence here. It is deliberately not read as NOT-RUN:
    // deciding whether a gate ran by reading someone's prose is the inference the structured
    // field exists to replace.
    const prose = 'ci-clean-gate.sh NOT RUN (embargoed); Coordinator gates the merge candidate';
    expect(gateOutcomeOf({ gate: prose })).toBe('none=NOT-RECORDED');
  });

  test('PROSE stored in the numeric exit-code field is NOT-RECORDED, not coerced', () => {
    // Two live records store "NOT RUN - outstanding, Coordinator's" in `exitCode`. Coercion would
    // yield NaN and a fabricated stamp; a numeric STRING would accept a shape nothing writes.
    expect(gateOutcomeOf({ gate: { exitCode: "NOT RUN - outstanding, Coordinator's" } })).toBe(
      'none=NOT-RECORDED'
    );
    expect(gateOutcomeOf({ gate: { exitCode: '0' } })).toBe('none=NOT-RECORDED');
  });
});

// ── 4. FAIL-CLOSED ON AN UNKNOWN CODE ──────────────────────────

describe('an unrecognised exit code is loud, and its number is still recoverable', () => {
  test('it renders the CODE plus UNRECOGNISED — never folded into a verdict', () => {
    // The deliverable is that the exit code survives to the reader. A label-only render would
    // re-collapse the moment a code appears this table has no name for.
    expect(gateOutcomeOf({ gate: { exitCode: 7 } })).toBe('7=UNRECOGNISED');
    const text = storyLineFor({ gate: { exitCode: 7 } });
    expect(text).toContain('gate-rc:7=UNRECOGNISED');
    expect(text).not.toContain('GREEN');
    expect(text).not.toContain('=RED');
  });

  test('rc=127 (command-not-found) is not silently a pass', () => {
    expect(gateOutcomeOf({ gate: { exitCode: 127 } })).toBe('127=UNRECOGNISED');
  });
});

// ── 5. THE KEY ALIASES, AND THE ONE THAT IS DELIBERATELY NOT AN ALIAS ───────

describe('the reader reads the corpus as it is actually written', () => {
  test('all three live exit-code spellings are read', () => {
    // Measured on prod 2026-09-03: exitCode (14), exit (3), exit_code (2).
    expect(gateOutcomeOf({ gate: { exitCode: 40 } })).toBe('40=STATIC-GREEN');
    expect(gateOutcomeOf({ gate: { exit: 40 } })).toBe('40=STATIC-GREEN');
    expect(gateOutcomeOf({ gate: { exit_code: 40 } })).toBe('40=STATIC-GREEN');
  });

  test('all three live ref spellings are read', () => {
    expect(gateOutcomeOf({ gate: { exit: 40, ref: GREEN_REF } })).toBe('40=STATIC-GREEN@3fd8f00d');
    expect(gateOutcomeOf({ gate: { exit: 40, refReported: GREEN_REF } })).toBe(
      '40=STATIC-GREEN@3fd8f00d'
    );
    expect(gateOutcomeOf({ gate: { exit: 40, refMeasured: GREEN_REF } })).toBe(
      '40=STATIC-GREEN@3fd8f00d'
    );
  });

  test('refToGate is NOT read as the ref the run executed on', () => {
    // It means "the ref that SHOULD be gated" — measured live as
    // "merge of batch10/belief-failopen@9305f00d into mandrel main", an intention. Rendering
    // it as a ref a run executed on is exactly the substitution this task exists to stop.
    const out = gateOutcomeOf({
      gate: { run: false, refToGate: 'merge of batch10/belief-failopen@9305f00d into main' },
    })!;
    expect(out).toBe('none=NOT-RUN');
    expect(out).not.toContain('@');
  });

  test('a REAL prod record round-trips — metadata copied verbatim from an earlier note', () => {
    // Copied from the live corpus, not built from the config. This is the richest structured
    // gate block anyone has written and it uses the `exit`/`refReported` spellings.
    const stored = {
      gate: {
        exit: 40,
        command:
          'env -u MANDREL_HTTP_URL -u MANDREL_AUTH_TOKEN -u MANDREL_ACTOR -u MANDREL_LOOP_ID bash scripts/ci-clean-gate.sh --static HEAD',
        meaning: 'static subset GREEN; rc 0 is reserved for the full gate',
        stagesRan: 69,
        refChecked: true,
        refReported: '3fd8f00dff80df3a44ae1ec8f7bcad8fb8ffc2f4',
        stagesSkipped: 21,
        stage1VitestRan: false,
        authoritativeGateOwner: 'coordinator',
        authoritativeGateStillOwed: true,
      },
    };
    expect(storyLineFor(stored)).toContain('gate-rc:40=STATIC-GREEN@3fd8f00d');
  });
});

// ── 6. THE BUDGET GUARD, AND THE CROSS-SOURCE GUARD ─────────────────────────

describe('bounds and second sources', () => {
  test('THE STAMP IS BOUNDED BY CONSTRUCTION — the worst case is arithmetic, not a clip', () => {
    // A max-chars clip was written here first and DELETED because it could never fire: the
    // only free-form input reaching this stamp is the ref, and it is already clipped. This
    // asserts the replacement — the arithmetic — so a change that reintroduced an unbounded
    // input goes RED here instead of silently widening every node line of a capped document.
    const longestLabel = Math.max(...['GREEN', 'RED', 'CANNOT-MEASURE', 'SKIP', 'STATIC-GREEN',
      'UNRECOGNISED', 'NOT-RECORDED', 'NOT-RUN'].map((l) => l.length));
    const longestCode = String(-Number.MAX_VALUE).length; // 24
    expect(longestCode + 1 + longestLabel + 1 + GATE_REF_RENDER_CHARS).toBe(
      GATE_STAMP_WORST_CASE_CHARS
    );
    // And the worst case is actually producible, rather than a number nobody checked.
    const worst = gateOutcomeOf({
      gate: { exitCode: -Number.MAX_VALUE, ref: 'A'.repeat(4096) },
    })!;
    expect(worst.length).toBeLessThanOrEqual(GATE_STAMP_WORST_CASE_CHARS);
    // A 4096-char ref contributes exactly GATE_REF_RENDER_CHARS and no more.
    expect(worst.endsWith('@' + 'A'.repeat(GATE_REF_RENDER_CHARS))).toBe(true);
  });

  test('the ref is clipped to its configured length, not printed whole', () => {
    const out = gateOutcomeOf({ gate: { exitCode: 0, ref: GREEN_REF } })!;
    expect(out.endsWith(GREEN_REF.slice(0, GATE_REF_RENDER_CHARS))).toBe(true);
    expect(out).not.toContain(GREEN_REF);
  });
});

// ── 7. GUARD THE GUARD — the defect condition still exists ──────────────────

describe('the clip is what made this invisible', () => {
  test('the rendered TITLE alone carries no exit code, so the stamp is doing the work', () => {
    // If the title ever stopped being clipped, §1 and §2 could pass for the wrong reason (the
    // gate sentence surviving inside the prose). This asserts the defect condition holds: the
    // record's own gate sentence is NOT on the rendered line — only the stamp is.
    const text = storyLineFor({ gate: { exitCode: 1, ref: RED_REF } });
    expect(VERDICT_CONTENT).toContain('scripts/ci-clean-gate.sh');
    expect(text).not.toContain('scripts/ci-clean-gate.sh');
    expect(text).toContain('gate-rc:1=RED');
  });
});

// ── 8. THE OTHER HALF OF THE BOOT PACKAGE — project_briefing's own renderers ─
//
// WHY THIS SECTION EXISTS, and why it is HERE rather than in a new task. The class this file
// is the registered detector for — `renderer-drops-structured-fact`
// (scripts/config/guard-classes.conf) — carries the registry's own rule: if a class has a
// detector, the detector is what should have caught the sibling, so you fix the DETECTOR'S
// POPULATION, you do not file the instance. §1–§7 covered recall_thread's two line renderers
// and stopped there. The boot package has FOUR MORE, in project_briefing, and they rendered
// neither the gate code nor the review call for ANY record kind.
//
// AND THE DROP WAS ONE LAYER EARLIER THAN IN RECALL, which is the part worth remembering:
// there, the fact was on the node and the renderer ignored it. Here, no Briefing* record type
// carried `metadata` AT ALL — the fact was never gathered, so there was nothing for a renderer
// to ignore. Same reader outcome (on the record, absent from the document), different
// mechanism. A detector scoped to "does the renderer read the field" would have been GREEN on
// this defect forever, because there was no field. So these cases assert the RENDERED
// DOCUMENT, which is blind to which layer dropped it.
//
// POPULATION, MEASURED ON PROD 2026-09-03 BEFORE BUILDING (commands in the run report):
//   97 contexts + 5 tasks + 0 decisions carry metadata.gate or metadata.verdict.
//   Of the four populations THIS document renders, the count carrying the fact TODAY is ZERO:
//   open tasks 0 (the 5 carriers are all `completed`), decisions 0/167, conventions 0 (one
//   convention exists), dead ends 0/4 fleet-wide.
// That zero is ACCIDENTAL, NOT STRUCTURAL — an `in_progress` task carrying a gate block
// renders here tomorrow — which is why the answer is the stamp and not an exclusion. Where an
// exclusion IS the honest answer, it is declared and tested: see §8.4.

import { renderBriefing, briefingConfig } from '../services/projectBriefing.js';
import type {
  BriefingData,
  BriefingTask,
  BriefingDecision,
  BriefingConvention,
  BriefingDeadEnd,
} from '../services/projectBriefing.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';

const B_HANDOFF_ID = '77777777-0000-4000-8000-000000000000';
const B_WHEN = new Date('2026-08-21T00:00:00Z');
const B_CENSUS = (n: number) => ({ fetched: n, fetchBoundReached: false, excluded: 0, excludedReason: null });

/** A gate block a Builder actually writes, in its richest live shape. */
const GATE_RED = { gate: { exitCode: 1, ref: RED_REF } };
const GATE_CANNOT_MEASURE = { gate: { exitCode: 2, ref: RED_REF } };

function bTask(metadata: unknown): BriefingTask {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    title: 'BTASK-TITLE',
    description: 'BTASK body',
    status: 'in_progress',
    priority: 'high',
    createdAt: B_WHEN,
    trustSignal: 'trust:test',
    trustScore: 0.5,
    tags: [],
    metadata,
  };
}

function bDecision(metadata: unknown): BriefingDecision {
  return {
    id: '40000000-0000-4000-8000-000000000002',
    title: 'BDECISION-TITLE',
    rationale: 'BDECISION why',
    decisionType: 'architecture',
    createdAt: B_WHEN,
    trustSignal: 'trust:test',
    trustScore: 0.5,
    tags: [],
    metadata,
  };
}

function bConvention(metadata: unknown): BriefingConvention {
  return {
    id: '40000000-0000-4000-8000-000000000003',
    content: 'BCONVENTION-TITLE all tunables live in named config',
    tags: ['convention'],
    createdAt: B_WHEN,
    trustSignal: 'trust:test',
    trustScore: 0.5,
    metadata,
  };
}

function bDeadEnd(): BriefingDeadEnd {
  return {
    id: '40000000-0000-4000-8000-000000000004',
    kind: 'context',
    basis: 'recorded',
    headline: 'BDEADEND-TITLE approach that cannot work',
    reason: 'proved impossible',
    createdAt: B_WHEN,
  };
}

function briefingWith(parts: {
  tasks?: BriefingTask[];
  decisions?: BriefingDecision[];
  conventions?: BriefingConvention[];
  deadEnds?: BriefingDeadEnd[];
}): string {
  const tasks = parts.tasks ?? [];
  const decisions = parts.decisions ?? [];
  const conventions = parts.conventions ?? [];
  const deadEnds = parts.deadEnds ?? [];
  const data: BriefingData = {
    projectId: '99999999-0000-4000-8000-000000000000',
    projectName: 'gate-rc-fab',
    waiting: null,
    handoffHead: resolvedHead({ id: B_HANDOFF_ID }),
    handoff: {
      id: B_HANDOFF_ID,
      content: 'HANDOFF-START the resume point HANDOFF-END',
      createdAt: B_WHEN,
      trustSignal: 'trust:test',
      stamps: NO_HANDOFF_STAMPS,
      carried: NO_CARRIED_FIELDS,
      spineResolved: null,
    },
    tasks,
    decisions,
    conventions,
    deadEnds,
    branch: null,
    census: {
      tasks: B_CENSUS(tasks.length),
      decisions: B_CENSUS(decisions.length),
      conventions: B_CENSUS(conventions.length),
      deadEnds: B_CENSUS(deadEnds.length),
      branchMembers: B_CENSUS(0),
    },
  } as BriefingData;
  // `.markdown` is the document a boot reader actually receives.
  return renderBriefing(data, briefingConfig(), B_WHEN).markdown;
}

describe('project_briefing renders the same structured facts as the walk', () => {
  // ── 8.1 the three shapeLine populations ──────────────────────────────────
  test('a TASK carrying a gate result renders its exit code', () => {
    expect(briefingWith({ tasks: [bTask(GATE_RED)] })).toContain('gate-rc:1=RED@9305f00d');
  });

  test('a DECISION carrying a gate result renders its exit code', () => {
    expect(briefingWith({ decisions: [bDecision(GATE_RED)] })).toContain('gate-rc:1=RED@9305f00d');
  });

  test('a CONVENTION carrying a gate result renders its exit code', () => {
    expect(briefingWith({ conventions: [bConvention(GATE_RED)] })).toContain(
      'gate-rc:1=RED@9305f00d'
    );
  });

  // ── 8.1b BOTH ALTITUDES, stated rather than left to whichever the fixture got ──
  test('BOTH briefing altitudes carry the stamp — shape AND full prose', () => {
    // WHY THIS IS ITS OWN CASE. The briefing renders each record at one of two altitudes
    // (config/briefingAltitudeConfig.ts): a one-line SHAPE by default, or a reserved
    // FULL-PROSE slot for the top-ranked records. Those are SIX line renderers, not three,
    // and the full ones do not go through shapeLine. Wiring only shapeLine would have left
    // the exit code missing from exactly the records a reader acts on first.
    //
    // This is not hypothetical: it is what happened. §8.1 was written against shapeLine,
    // the fixture's single task was granted a full-prose slot, and the case went RED on an
    // implementation that had "covered the briefing". The detector found the gap; reading
    // the code had not.
    const asFull = briefingWith({ tasks: [bTask(GATE_RED)] });
    const asShape = briefingWith({
      // Exhaust the slots with records that carry no fact, so the record under test is
      // pushed to the shape altitude. Slot count is config; four is past any live default.
      tasks: [bTask(null), bTask(null), bTask(null), bTask(null), bTask(GATE_RED)].map((t, i) => ({
        ...t,
        id: `4000000${i}-0000-4000-8000-00000000000${i}`,
        trustScore: i === 4 ? 0.01 : 0.99,
      })),
    });
    // The full-prose head is recognisable by its `[trust:…]` tail; the shape line by its date.
    expect(asFull).toMatch(/- BTASK-TITLE .*\[id:\w+ gate-rc:1=RED@9305f00d\] \[trust:/);
    expect(asShape).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] \[task:\w+ gate-rc:1=RED@9305f00d\]/m);
  });

  // ── 8.2 the defect proper: three states, not two, in THIS document too ────
  test('rc=1 and rc=2 do not render the same briefing — the measured defect, here', () => {
    const red = briefingWith({ tasks: [bTask(GATE_RED)] });
    const cannotMeasure = briefingWith({ tasks: [bTask(GATE_CANNOT_MEASURE)] });
    expect(red).not.toEqual(cannotMeasure);
    expect(red).toContain('gate-rc:1=RED');
    expect(cannotMeasure).toContain('gate-rc:2=CANNOT-MEASURE');
  });

  test('THE SIBLING FACT TOO — the review call reaches the briefing', () => {
    // The class is `renderer-drops-structured-fact`, not `renderer-drops-the-gate`. the review-call fix
    // fixed the review call on the recall lines and left it dropped here; a detector for the
    // class that only ever checked the gate would be one instance short by construction.
    expect(briefingWith({ tasks: [bTask({ verdict: 'APPROVE-PENDING-GATE' })] })).toContain(
      'verdict:APPROVE-PENDING-GATE'
    );
  });

  // ── 8.3 absence still costs nothing ──────────────────────────────────────
  test('a record with no metadata renders BYTE-FOR-BYTE what it rendered before', () => {
    // This document is size-capped and measured SATURATED (23,922 of 24,000 chars, 364
    // records dropped). A stamp that cost every line would evict records in order to say
    // nothing about them — so absence must be free, not merely short.
    const none = briefingWith({ tasks: [bTask(null)] });
    const empty = briefingWith({ tasks: [bTask({})] });
    expect(none).toEqual(empty);
    expect(none).not.toContain('gate-rc:');
    expect(none).not.toContain('verdict:');
    // …and the pre-change grammar is intact: the id bracket still CLOSES RIGHT AFTER THE ID,
    // with no stray separator left where a stamp would have gone. Asserted against the
    // full-prose head because that is the altitude a single top-ranked task is granted —
    // the shape altitude's identical property is asserted in §8.1b.
    expect(none).toMatch(/^- BTASK-TITLE \[status:in_progress\] \[priority:high\] \[id:\w+\] \[trust:/m);
  });

  // ── 8.4 THE ONE DECLARED, TESTED EXCLUSION ───────────────────────────────
  test('DEAD ENDS are excluded from the stamps ON PURPOSE, and the exclusion is asserted', () => {
    // renderDeadEnd is the fourth briefing line renderer and it does NOT go through
    // shapeLine. It is excluded, deliberately, and this test is the exclusion — not a gap.
    //
    // WHY. A dead-end line is not a record view; it is a REDUCTION to exactly three fields
    // (basis, headline, reason) whose whole job is to answer "was this already tried". Its
    // gather selects id/content/created_at and nothing else, and BriefingDeadEnd carries no
    // metadata by design. The actionable fact about a dead end is that it was superseded or
    // refuted — which the line already states — not what a gate said on the day it died.
    // MEASURED: 4 dead-end contexts exist fleet-wide and 0 carry metadata.gate or
    // metadata.verdict, so a stamp here would render for nobody.
    //
    // THIS IS THE TRIP-WIRE, and it is why the exclusion is declared rather than silent: if
    // someone later widens BriefingDeadEnd to carry metadata and wires the stamp in, this
    // case goes RED and they must consciously delete it rather than discover later that two
    // halves of one document disagree about which records get stamped.
    const rendered = briefingWith({ deadEnds: [bDeadEnd()] });
    expect(rendered).toContain('BDEADEND-TITLE');
    const deadEndLine = rendered.split('\n').find((l) => l.includes('BDEADEND-TITLE'))!;
    expect(deadEndLine).not.toContain('gate-rc:');
    expect(deadEndLine).not.toContain('verdict:');
  });
});
