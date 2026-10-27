/**
 * THE REVIEW CALL MUST SURVIVE THE RENDER — contract.
 *
 * THE DEFECT THIS LOCKS, measured before the fix rather than imagined: on prod 2026-08-26,
 * `recall_thread anchor:an earlier change altitude:headline` rendered SEVEN Reviewer verdict
 * contexts and the word APPROVE or REJECT appeared on the line of ONE of them — the one
 * whose author happened to put the call early enough in the first sentence to survive the
 * title clip. Every other verdict was rendered as `[context] ★ REVIEWER VERDICT — an earlier task
 * (P5a: pass the recall knobs at boot). ROUND:… — trust:trusted score:0.95`. A
 * reader could see that a review HAPPENED and not whether it PASSED, so the only recovery
 * left was inferring approval from the fact that the work merged. MERGED IS NOT APPROVED:
 * on 2026-08-21 three reviewers approved a tree the authoritative gate then turned RED.
 *
 * WHY IT IS A RENDER BUG AND NOT A STORAGE BUG — the diagnosis this suite encodes: the
 * records were SELECTED (they are on the walk, by id) and the call was STRUCTURED on them
 * (`metadata.verdict`, measured present on 14 of the 21 verdict-tagged contexts in the live
 * corpus). Only the two line renderers never read it. So the guards below assert on the
 * SHIPPED renderers' output — not on the derivation alone, which would stay green if the
 * stamp were deleted from the lines tomorrow.
 *
 * THE TWO STORED SHAPES ARE BOTH REAL AND BOTH TESTED. `"verdict":"APPROVE-PENDING-GATE"`
 * is an earlier context; `"verdict":{"call":"APPROVE-WITH-NITS-PENDING-GATE",...}` is an earlier context.
 * A fixture that covered one would have shipped blind to half the corpus.
 *
 * NO DATABASE IS PROVISIONED OR QUERIED — but this file is NOT importable without database
 * ENV: importing recall.routes pulls in handlers/project, whose module-load config throws
 * `DATABASE_NAME environment variable is required!`. Run it the way the suite runs it (the
 * gate's Stage 1 pins), not standalone.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderThreadText, renderCurrentStateText } from '../routes/recall.routes.js';
import type { CurrentStateResult } from '../services/currentState.js';
import { shapeNode, reviewOutcomeOf, type ThreadNode } from '../services/recallThreadCore.js';
import { deriveContextTitle } from '../services/recallThread.js';
import {
  projectCurrentState,
  type CurrentStateInputNode,
} from '../services/currentStateCore.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import { RECORD_HEADLINE_CONFIG } from '../config/recordHeadlineConfig.js';
import { THREAD_CONFIG, THREAD_CONTENT_ALTITUDES } from '../config/threadConfig.js';
import {
  REVIEW_OUTCOME_LABEL,
  REVIEW_OUTCOME_MAX_CHARS,
  REVIEW_OUTCOME_CLIP_SUFFIX,
} from '../config/reviewOutcomeConfig.js';
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
 * The verdict record as it is ACTUALLY STORED — the title is the record's first line, which
 * is what the walk renders and what the clip eats. Taken from an earlier context's own first
 * line so the fixture is a real one, not a strawman built to be easy.
 */
const VERDICT_CONTENT =
  '★ REVIEWER VERDICT — an earlier task (P5a: pass the recall knobs at boot). ROUND: 1. APPROVE-WITH-NITS.\n\nGATE: ci.yml exit 0.';
/**
 * The title the PRODUCT derives for that record — through the product's own clip, never a
 * hand-typed "…". The clip is where the call disappears, so faking it would fake the defect.
 */
const VERDICT_TITLE = deriveContextTitle(VERDICT_CONTENT)!;

/**
 * Both live metadata shapes, as LITERALS copied from the stored records — never built from
 * the config constants. Keyed off the config (as this was in round 1) the suite proves only
 * that the code agrees with itself: MEASURED, renaming reviewOutcomeConfig's key rendered
 * NOTHING for 100% of the live corpus with tsc exit 0 and this file 22/22 GREEN. The label
 * is spelled literally below for the same reason — a live shell consumer parses that text.
 */
const STRING_SHAPE = { verdict: 'APPROVE-PENDING-GATE' };
const OBJECT_SHAPE = { verdict: { call: 'REJECT', round: 2, blockers: 1 } };

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

let seq = 0;
function inputNode(over: Partial<CurrentStateInputNode>): CurrentStateInputNode {
  seq += 1;
  return {
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
    metadata: null,
    trust: TRUST,
    ...over,
  } as CurrentStateInputNode;
}

/** Shape a node the way the product does, then render the way the product does. */
function storyLineFor(
  metadata: unknown,
  altitude = 'headline' as const,
  title: string = VERDICT_TITLE
): string {
  const n = shapeNode(
    { id: '22222222-0000-4000-8000-000000000000', type: 'context', title, content: null, metadata },
    TRUST,
    altitude,
    THREAD_CONFIG
  );
  return renderThreadText(threadResult([n]));
}

// ── 1. THE DEFECT, LOCKED: the call reaches the rendered line ───────────────

describe('the stored review call survives the render', () => {
  test('STORY channel — a string metadata.verdict renders as a label', () => {
    const text = storyLineFor(STRING_SHAPE);
    expect(text).toContain('verdict:APPROVE-PENDING-GATE');
  });

  test('STORY channel — an OBJECT metadata.verdict renders its call', () => {
    const text = storyLineFor(OBJECT_SHAPE);
    expect(text).toContain('verdict:REJECT');
  });

  test('STORY channel — the label survives at EVERY content altitude, headline included', () => {
    // The altitude that clips hardest is the one a boot package uses; that is precisely
    // where the verdict was being lost. Enumerated from the product's own altitude list.
    for (const altitude of THREAD_CONTENT_ALTITUDES) {
      const text = storyLineFor(STRING_SHAPE, altitude as 'headline');
      expect(text, `altitude ${altitude}`).toContain('verdict:APPROVE-PENDING-GATE');
    }
  });

  test('CURRENT-STATE channel — the call renders in the lifecycle stamp', () => {
    const state = projectCurrentState(
      [inputNode({ metadata: STRING_SHAPE })],
      '11111111-0000-4000-8000-000000000000',
      CURRENT_STATE_CONFIG,
      THREAD_CONFIG
    );
    const rendered = renderCurrentStateText({
      ...state,
      truncated: false,
      truncatedCount: 0,
      depthUsed: 2,
      maxNodesUsed: 50,
      maxNodesRequested: 50,
      omissions: { examined: 1, droppedDangling: 0, droppedByMinTrust: 0, droppedEdges: 0, clippedNodes: 0 },
    } as CurrentStateResult);
    expect(rendered).toContain('verdict:APPROVE-PENDING-GATE');
  });

  test('THE CLIP IS WHAT MADE THIS INVISIBLE — the title alone does NOT carry the call', () => {
    // Guard the guard: if the title ever stopped being clipped, the tests above could pass
    // for the wrong reason (the call surviving inside the prose). This asserts the defect
    // condition still exists — the rendered TITLE portion loses the call — so the label is
    // doing the work.
    //
    // ⚠️ THE FIXTURE IS DERIVED FROM THE CLIP BUDGET, NOT HARD-CODED, and that is the whole
    // point. This test used to lean on `VERDICT_CONTENT`, whose call
    // sat at character 84 — outside the 80-char clip of the day, and therefore inside the
    // 180-char budget the clip now uses. It went RED the moment the budget moved, asserting
    // a defect that was no longer reachable for that particular record. A guard whose
    // premise is "the budget is 80" is a guard pinned to a number it does not own.
    // So the padding below is sized FROM `RECORD_HEADLINE_CONFIG.maxChars`: whatever the
    // budget is, this record's call is past it, which is the condition the guard is about.
    const pad = 'a record whose first line runs long before it states the call '.repeat(
      Math.ceil(RECORD_HEADLINE_CONFIG.maxChars / 60) + 1
    );
    const longVerdict = deriveContextTitle(`★ REVIEWER VERDICT — ${pad} APPROVE-WITH-NITS.`)!;
    expect(longVerdict.length).toBeLessThanOrEqual(RECORD_HEADLINE_CONFIG.maxChars);

    const line = storyLineFor(STRING_SHAPE, 'headline', longVerdict)
      .split('\n')
      .find((l) => l.startsWith('1. '))!;
    const titlePortion = line.slice(line.indexOf(']') + 1, line.lastIndexOf(' — trust:'));
    expect(titlePortion).not.toContain('APPROVE');
    expect(titlePortion.length).toBeLessThan(pad.length);
  });
});

// ── 2. ABSENCE IS ABSENCE — the population that slips through ───────────────

describe('a record with no stored call renders NO label', () => {
  const empties: Array<[string, unknown]> = [
    ['null metadata', null],
    ['undefined metadata', undefined],
    ['empty object', {}],
    ['an array', [{ verdict: 'APPROVE' }]],
    ['a string metadata blob', 'verdict: APPROVE'],
    ['the key present but empty', { verdict: '' }],
    ['the key present but whitespace', { verdict: '   ' }],
    ['the key present but a number', { verdict: 0 }],
    ['the key present but null', { verdict: null }],
    ['an object without the call sub-key', { verdict: { round: 2 } }],
    ['a nested non-string call', { verdict: { call: { x: 1 } } }],
  ];

  for (const [name, metadata] of empties) {
    test(`${name} → no label, and nothing invented`, () => {
      expect(reviewOutcomeOf(metadata)).toBeNull();
      const text = storyLineFor(metadata);
      expect(text).not.toContain('verdict:');
    });
  }

  test('an ORDINARY record is byte-identical to what it rendered before this feature', () => {
    // The size/no-noise control: this feature must add ZERO bytes to a record that carries
    // no call, which is the overwhelming majority of every walk.
    const withMeta = storyLineFor({ someOtherField: 'x' });
    const withNone = storyLineFor(null);
    expect(withMeta).toBe(withNone);
  });
});

// ── 3. THE BUDGET — this renders on a size-capped boot package ──────────────

describe('the label is bounded, because the package it rides on is', () => {
  test('a paragraph in metadata.verdict is clipped to the configured bound', () => {
    const long = 'A'.repeat(REVIEW_OUTCOME_MAX_CHARS * 10);
    const out = reviewOutcomeOf({ verdict: long })!;
    expect(out.length).toBe(REVIEW_OUTCOME_MAX_CHARS + REVIEW_OUTCOME_CLIP_SUFFIX.length);
    expect(out.endsWith(REVIEW_OUTCOME_CLIP_SUFFIX)).toBe(true);
  });

  test('a multi-line call cannot break the one-line stamp', () => {
    const out = reviewOutcomeOf({ verdict: 'REJECT\n\nsee the findings' });
    expect(out).toBe('REJECT see the findings');
    expect(storyLineFor({ verdict: 'REJECT\nround 2' }).split('\n').filter((l) => l.startsWith('1. ')).length).toBe(1);
  });

  test('the whole added cost of one label is bounded by the config', () => {
    const withCall = storyLineFor({ verdict: 'A'.repeat(1000) });
    const without = storyLineFor(null);
    const added = withCall.length - without.length;
    // label + ':' + the bounded value + the clip marker + the leading space
    expect(added).toBeLessThanOrEqual(
      REVIEW_OUTCOME_LABEL.length + 2 + REVIEW_OUTCOME_MAX_CHARS + REVIEW_OUTCOME_CLIP_SUFFIX.length
    );
  });
});

// ── 4. THE WIRE — the product must actually hand the metadata over ──────────

/**
 * WITHOUT THIS, EVERY TEST ABOVE COULD BE GREEN OVER A DEAD FEATURE. The tests call
 * shapeNode with metadata themselves; the PRODUCT's two call sites are the only things that
 * make a real walk carry it. Deleting either wire is invisible to a pure test and would
 * restore the exact defect this task fixed — so the wire is asserted directly, at the
 * source, naming the file it must be in.
 */
describe('both node builders hand metadata to the shared shaper', () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

  for (const file of ['services/recallThread.ts', 'services/currentStateCore.ts']) {
    test(`${file} passes metadata into shapeNode`, () => {
      // COMMENTS ARE STRIPPED FIRST, and that is not tidiness. Written without this, the
      // guard passed a probe that had DELETED the wire — the explanatory comment above the
      // call still contained the word `metadata`, so the assertion read prose and called it
      // a wire (measured 2026-08-26, probe C). A guard that can be satisfied by a sentence
      // is not measuring code.
      const text = src(file).replace(/\/\/[^\n]*/g, '');
      const call = /shapeNode\(\s*\{[^}]*\}/s.exec(text);
      expect(call, `no shapeNode({...}) call found in ${file}`).not.toBeNull();
      // The PROPERTY, not the word: `metadata` must be a key of the object handed over.
      expect(call![0]).toMatch(/[{,]\s*metadata\s*:/);
    });
  }
});
