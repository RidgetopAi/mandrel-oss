/**
 * "WE SHIPPED IT" AND "WE GAVE UP ON IT" MUST NOT RENDER AS THE SAME WORD — contract
 *.
 *
 * THE DEFECT THIS LOCKS. `historical` was the disposition a node got when nothing else
 * applied — currentStateCore.classifyNode ended `return out.length > 0 ? out : ['historical']`.
 * So a COMPLETED DELIVERABLE and an ABANDONED THREAD landed in one bucket and read
 * identically to anyone consuming current-state. That surface is what an agent believes about
 * a project on boot, which makes the confusion expensive in one specific direction: a shipped
 * feature that reads as spent discussion invites someone to rebuild it.
 *
 * WHY THE RENDER IS ASSERTED HERE AND NOT ONLY THE PAYLOAD. A cold agent boots on the
 * RENDERED text, not on the JSON. A distinction that exists only in a structured field the
 * renderer never prints is a distinction the reader never receives — so the guard drives the
 * shipped renderer, which would stay green in a derivation-only test if the lines were
 * deleted tomorrow.
 *
 * NO DATABASE IS PROVISIONED OR QUERIED — but this file is NOT importable without database
 * ENV: importing recall.routes pulls in handlers/project, whose module-load config throws
 * `DATABASE_NAME environment variable is required!`. Run it the way the suite runs it (the
 * gate's Stage 1 pins), not standalone.
 */

import { describe, test, expect } from 'vitest';

import { renderCurrentStateText } from '../routes/recall.routes.js';
import type { CurrentStateResult } from '../services/currentState.js';
import {
  projectCurrentState,
  type CurrentStateInputNode,
} from '../services/currentStateCore.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import type { Trust } from '../services/trustModel.js';
import type { EdgeNodeType } from '../config/edgeTypes.js';

const CFG = CURRENT_STATE_CONFIG;

/**
 * A cold-start verdict: real, current, and BELOW the trusted-outcome floor. This is the trust
 * shape that puts a COMPLETED task in the historical bucket at all — a completed task that
 * clears the floor leaves through the trusted-outcome door instead, so a fixture without this
 * would exercise nothing.
 */
function unprovenTrust(): Trust {
  return {
    band: 'unproven', // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
    score: 0.8,
    outcome: { score: null, samples: 0 },
    freshness: 0.9,
    superseded: false,
    softSuperseded: false,
    abstain: false, // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
    supersession: null,
    reason: 'cold-start',
    promotionRequirement: 'x',
    supersessionGuard: { enabled: false, checked: 0, suppressed: [], undecided: [] },
  };
}

let seq = 0;
function node(over: Partial<CurrentStateInputNode> & { type: EdgeNodeType }): CurrentStateInputNode {
  seq += 1;
  return {
    id: over.id ?? `n-${String(seq).padStart(3, '0')}`,
    title: `n${seq}`,
    content: null,
    createdAt: new Date(Date.UTC(2026, 0, 1 + (seq % 27))),
    updatedAt: null,
    status: null,
    outcomeStatus: null,
    implementationStatus: null,
    contextType: null,
    metadata: null,
    trust: unprovenTrust(),
    ...over,
  };
}

/** Statuses READ FROM THE PRODUCT'S OWN CONFIG, never transcribed here. */
const ACTIVE = CFG.activeTaskStatuses[0];
const COMPLETED = CFG.completedTaskStatuses[0];
const ABANDONED = CFG.abandonedTaskStatuses[0];

function renderOf(nodes: CurrentStateInputNode[], anchorId: string): string {
  return renderCurrentStateText({
    ...projectCurrentState(nodes, anchorId, CFG),
    truncated: false,
    truncatedCount: 0,
    depthUsed: 2,
    maxNodesUsed: 50,
    maxNodesRequested: 50,
    omissions: {
      examined: nodes.length,
      droppedDangling: 0,
      droppedByMinTrust: 0,
      droppedEdges: 0,
      clippedNodes: 0,
    },
  } as CurrentStateResult);
}

describe('the historical split reaches the READER, by name', () => {
  const shippedAndDropped = () => [
    node({ id: 'root', type: 'task', status: ACTIVE }),
    node({ id: 'ship', type: 'task', status: COMPLETED }),
    node({ id: 'drop', type: 'task', status: ABANDONED }),
  ];

  test('THE RENDERED COLLAPSE PROBE — the two outcomes are named, and named DIFFERENTLY', () => {
    const text = renderOf(shippedAndDropped(), 'root');
    expect(text).toContain('1 completed');
    expect(text).toContain('1 abandoned');
    // The load-bearing part: the two words are not the same word. A collapse that renamed
    // both halves together would still fail this, because one of them would then be missing.
    expect(text).toMatch(/completed \(work was carried out\)/);
    expect(text).toMatch(/abandoned \(stopped without being carried out\)/);
  });

  test('the COMPLETED ids are echoed — the reader can go look instead of rebuilding', () => {
    const text = renderOf(shippedAndDropped(), 'root');
    expect(text).toMatch(/completed ids[^\n]*\bship\b/);
    // And the abandoned one is NOT presented as something that exists.
    const completedLine = text.split('\n').find((l) => l.includes('completed ids'))!;
    expect(completedLine).not.toContain('drop');
  });

  test('the UMBRELLA line an existing consumer already reads is unchanged', () => {
    // Wire compatibility, asserted rather than asserted-in-prose: `historical` still counts
    // BOTH, so nothing that reads the old number sees it move.
    const text = renderOf(shippedAndDropped(), 'root');
    expect(text).toContain('2 historical/closed');
    expect(text).toMatch(/accounted: .*2 historical = 3 examined/);
  });

  test('AT ZERO the split line is absent, not a row of misleading zeroes', () => {
    // C3's empty population. The umbrella line still prints at zero (it always has — "none"
    // must be a measured answer); the breakdown has nothing to break down and says nothing.
    const text = renderOf([node({ id: 'root', type: 'task', status: ACTIVE })], 'root');
    expect(text).toContain('0 historical/closed');
    expect(text).not.toContain('completed (work was carried out)');
    expect(text).not.toContain('completed ids');
  });

  test('an UNKNOWN outcome renders as its own number, never folded into either side', () => {
    // The honest third value. A decision closed with no build signal and no evaluated
    // outcome is `unknown` — and the reader is told so, rather than told a guess.
    const text = renderOf(
      [
        node({ id: 'root', type: 'task', status: ACTIVE }),
        node({ id: 'dunno', type: 'decision', status: 'deprecated' }),
      ],
      'root'
    );
    expect(text).toMatch(/1 unknown \(record carries no signal either way\)/);
    expect(text).toContain('0 completed');
    expect(text).toContain('0 abandoned');
  });
});
