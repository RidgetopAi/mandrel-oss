/**
 * THE DECISION PROTECTION BAND — contract tests (defect B).
 *
 * THE DEFECT, MEASURED, on project `riverbend`: the boot package serves **0 of 162
 * decisions** under the 24,000-char cap. A cold session boots with no access to any decision
 * the project has ever made, including the ones that LOCK its current plan. The omission line
 * is honest and the ordering is behaving as built — a decision simply has no protection band,
 * so it sits at the floor with ~300 other records and loses.
 *
 * WHAT SHIPPED IS A KNOB, NOT A RULING, and these tests are written to that. f176d8a5 says
 * MEASURE which loses less rather than guess, and the cap is already dropping 339 whole
 * records, so any budget a decision band wins comes out of something else. So:
 *   - the SHIPPED DEFAULT is the floor and the document is unchanged (asserted below);
 *   - the knob is WIRED — raising it really does protect decisions (asserted below), because
 *     a measurement knob that does nothing would make the experiment return "no effect" and
 *     look like an answer;
 *   - the master switch collapses it, like every other selection-affecting band.
 */

import { describe, test, expect } from 'vitest';
import {
  renderBriefing,
  briefingConfig,
  applySelectionFlag,
  type BriefingData,
  type BriefingConfig,
  type BriefingTask,
  type BriefingDecision,
} from '../services/projectBriefing.js';
import { READ_BRIEFING_PROTECTION_RANK_DECISION } from '../config/briefingConfig.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';
import { censusFor } from './helpers/briefingCensus.js';

const HANDOFF_ID = '66666666-0000-0000-0000-000000000000';

function cfg(over: Partial<BriefingConfig> = {}): BriefingConfig {
  return { ...briefingConfig(), ...over };
}

/**
 * A fat, UNPROTECTED task: `medium` priority is outside BRIEFING_PROTECTED_TASK_PRIORITIES,
 * so it sits at the floor exactly as a decision does today. That is the point of the corpus —
 * with both at the floor the comparator decides on trust/age, and the decisions lose because
 * they are older here. Raising the decision band is the only thing that can change that.
 */
function fabTask(n: number): BriefingTask {
  return {
    id: `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title: `DR-TASK-${n}`,
    description: `t${n} ${'z'.repeat(900)}`,
    status: 'todo',
    priority: 'medium',
    createdAt: new Date('2026-08-20T00:00:00Z'),
    trustSignal: 'trust:test score:0.90',
    trustScore: 0.9,
    tags: [],
    metadata: null,
  };
}

function fabDecision(n: number): BriefingDecision {
  return {
    id: `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title: `DR-DECISION-${n}`,
    rationale: `d${n} ${'w'.repeat(900)}`,
    decisionType: 'architecture',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    trustSignal: 'trust:test score:0.10',
    trustScore: 0.1,
    tags: [],
    metadata: null,
  };
}

function fabData(taskCount: number, decisionCount: number): BriefingData {
  const tasks = Array.from({ length: taskCount }, (_, i) => fabTask(i + 1));
  const decisions = Array.from({ length: decisionCount }, (_, i) => fabDecision(i + 1));
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'dr-fab',
    handoffHead: resolvedHead({ id: HANDOFF_ID }),
    handoff: {
      id: HANDOFF_ID,
      content: 'DR-HANDOFF',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      trustSignal: 'trust:unproven score:1.00',
      stamps: NO_HANDOFF_STAMPS,
      carried: NO_CARRIED_FIELDS,
      spineResolved: null,
    },
    tasks,
    decisions,
    conventions: [],
    deadEnds: [],
    branch: null,
    waiting: null,
    census: censusFor({ tasks, decisions, conventions: [], deadEnds: [] }),
  };
}

/** How many of the fabricated decisions actually reached the rendered document. */
function decisionsServed(markdown: string): number {
  return (markdown.match(/DR-DECISION-\d+/g) ?? []).length;
}

describe('decision protection band (an earlier task defect B)', () => {
  test('THE SHIPPED DEFAULT IS THE FLOOR — this change reorders nothing today', () => {
    expect(READ_BRIEFING_PROTECTION_RANK_DECISION()).toBe(0);
    expect(briefingConfig().protectionRankDecision).toBe(0);
  });

  test('at the default, the saturated document is byte-identical to the pre-f176d8a5 one', () => {
    // "Pre-f176d8a5" is the floor rank spelled explicitly. If the default ever drifts off the
    // floor without a measurement, these two documents stop matching and this says so. Run
    // with the master switch ON, or applySelectionFlag would flatten both sides to the floor
    // and the comparison would hold for a reason that has nothing to do with the default.
    const data = fabData(40, 40);
    const base = { maxChars: 5000, branchScopeEnabled: true }; // reserved-port-ok: a briefing CHARACTER budget (maxChars), never a socket
    const shipped = renderBriefing(data, cfg(base)).markdown;
    const explicitFloor = renderBriefing(data, cfg({ ...base, protectionRankDecision: 0 })).markdown;
    expect(shipped).toBe(explicitFloor);
  });

  test('THE KNOB IS WIRED: raising it serves decisions the floor loses', () => {
    // The corpus is saturated on purpose — at the floor the older, less-trusted decisions are
    // evicted first and the document serves NONE of them, which is the f176d8a5 symptom
    // (0 of 162) reproduced in miniature.
    const data = fabData(40, 40);
    const base = { maxChars: 5000, branchScopeEnabled: true }; // reserved-port-ok: a briefing CHARACTER budget (maxChars), never a socket
    const atFloor = renderBriefing(data, cfg({ ...base, protectionRankDecision: 0 }));
    expect(decisionsServed(atFloor.markdown)).toBe(0);
    expect(atFloor.included.tasks).toBeGreaterThan(0);

    // Raised above the unprotected tasks, the SAME corpus at the SAME cap serves decisions.
    // Stated as a SWAP, which is what it is (scoring rule a2243a8d): the budget did not grow,
    // so every decision admitted here displaced a task. That is the trade f176d8a5 says to
    // MEASURE — this test proves the knob moves the trade, never that the trade is worth it.
    const raised = renderBriefing(data, cfg({ ...base, protectionRankDecision: 2 }));
    expect(decisionsServed(raised.markdown)).toBeGreaterThan(0);
    expect(raised.included.tasks).toBeLessThan(atFloor.included.tasks);
    expect(raised.markdown.length).toBeLessThanOrEqual(5000); // reserved-port-ok: a briefing CHARACTER budget (maxChars), never a socket
  });

  test('it is UNDER THE MASTER SWITCH — branch scope off collapses it to the floor', () => {
    // Same rule the convention band follows: a selection-affecting band must not be reachable
    // from a flag-off deployment by setting its env var.
    const raised = cfg({ branchScopeEnabled: false, protectionRankDecision: 3 });
    expect(applySelectionFlag(raised).protectionRankDecision).toBe(0);
    // And with the switch ON it is carried through untouched, or the collapse would be a
    // permanent floor rather than a switch.
    expect(
      applySelectionFlag(cfg({ branchScopeEnabled: true, protectionRankDecision: 3 }))
        .protectionRankDecision,
    ).toBe(3);
  });
});
