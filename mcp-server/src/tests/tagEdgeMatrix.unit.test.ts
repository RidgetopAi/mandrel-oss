/**
 * TAG → EDGE MATRIX — the 9 cells, pinned LITERALLY (Q1).
 *
 * ⚠️ READ THIS BEFORE EDITING. This suite deliberately does NOT iterate TAG_EDGE_MATRIX and
 * assert it against itself. That shape — "for each cell, expect tagToEdgeIntent to return
 * that cell" — is a TAUTOLOGY: it passes for ANY matrix, including one someone silently
 * changed, because the expectation is re-derived from the thing under test. It is the
 * A past incident disease (a coverage test that is really an allow-list), and it has bitten this
 * workstream repeatedly — including inside tests written specifically to guard against it.
 *
 * So: all nine cells are written out as LITERALS below. A drive-by edit to the matrix goes
 * RED here and has to be argued for. If you are changing a cell on purpose, change the
 * literal too — that edit IS the review surface.
 *
 * Pure (no DB, no embeddings): the matrix is a config lookup.
 */

import { describe, test, expect } from 'vitest';
import {
  tagToEdgeIntent,
  TAG_EDGE_MATRIX,
  TAG_EDGE_PREFIXES,
} from '../config/tagEdgeConfig.js';
import { EDGE_NODE_TYPES } from '../config/edgeTypes.js';

/** Assert one cell end-to-end through the public function, with a literal expectation. */
function expectCell(
  sourceType: 'context' | 'decision' | 'task',
  prefix: string,
  expectedEdgeType: string,
  expectedToType: string,
) {
  const intent = tagToEdgeIntent(sourceType, `${prefix}:abcd1234`);
  expect(intent, `(${sourceType}, ${prefix}:) must mint an edge`).not.toBeNull();
  expect(intent!.edgeType, `(${sourceType}, ${prefix}:) edge type`).toBe(expectedEdgeType);
  expect(intent!.toType, `(${sourceType}, ${prefix}:) endpoint kind`).toBe(expectedToType);
  expect(intent!.ref).toBe('abcd1234');
}

describe('tag→edge matrix — the 9 cells', () => {
  // ── ROW 1: a CONTEXT writing tags (LIVE behaviour, must not change) ─────────
  describe('source: context', () => {
    test('task: → informs', () => expectCell('context', 'task', 'informs', 'task'));
    test('decision: → decided_by', () =>
      expectCell('context', 'decision', 'decided_by', 'decision'));
    test('context: → learned_from', () =>
      expectCell('context', 'context', 'learned_from', 'context'));
  });

  // ── ROW 2: a DECISION writing tags (LIVE behaviour, must not change) ────────
  describe('source: decision', () => {
    test('task: → informs', () => expectCell('decision', 'task', 'informs', 'task'));
    test('decision: → decided_by', () =>
      expectCell('decision', 'decision', 'decided_by', 'decision'));
    test('context: → learned_from', () =>
      expectCell('decision', 'context', 'learned_from', 'context'));
  });

  // ── ROW 3: a TASK writing tags (NEW — tasks stop being graph leaves) ────────
  describe('source: task', () => {
    test('task: → related_to (the CONTESTED cell — weak on purpose)', () => {
      // NOT `informs`, for three reasons (see config/tagEdgeConfig.ts):
      //   (a) the informs spec does not list task as a valid source;
      //   (b) informs is an OUTCOME edge, so task→task informs would make a task inherit
      //       the referenced task's outcome as its own evidence — parent/child noise in
      //       the moat;
      //   (c) `task:X` on a task is genuinely ambiguous (subtask/follow-up/blocks/dupe).
      // Ambiguous → weak, non-trust-bearing, and losslessly upgradeable later.
      expectCell('task', 'task', 'related_to', 'task');
    });
    test('decision: → decided_by (a task ladders up to the decision that authorized it)', () =>
      expectCell('task', 'decision', 'decided_by', 'decision'));
    test('context: → learned_from', () =>
      expectCell('task', 'context', 'learned_from', 'context'));
  });

  // ── THE ONE CELL THAT DIFFERS FROM THE OLD SOURCE-BLIND MAP ────────────────
  test('exactly ONE cell differs from the old source-blind behaviour', () => {
    // The old map was tagToEdgeIntent(tag): task:→informs, decision:→decided_by,
    // context:→learned_from, regardless of source. Assert the two unchanged rows still
    // match it exactly, and that ONLY (task, task:) diverges. This is what makes the
    // change reviewable as "one deliberate semantic change", not a rewrite.
    const oldBlind: Record<string, string> = {
      task: 'informs',
      decision: 'decided_by',
      context: 'learned_from',
    };
    const divergences: string[] = [];
    for (const source of ['context', 'decision', 'task'] as const) {
      for (const prefix of ['task', 'decision', 'context'] as const) {
        const intent = tagToEdgeIntent(source, `${prefix}:abcd1234`);
        if (intent!.edgeType !== oldBlind[prefix]) {
          divergences.push(`(${source}, ${prefix}:)=${intent!.edgeType}`);
        }
      }
    }
    expect(divergences).toEqual(['(task, task:)=related_to']);
  });

  // ── DENY BY DEFAULT ────────────────────────────────────────────────────────
  describe('deny-by-default: no default case, no fallthrough to the context row', () => {
    test('an unknown TAG PREFIX mints nothing', () => {
      for (const source of ['context', 'decision', 'task'] as const) {
        expect(tagToEdgeIntent(source, 'ref:resume')).toBeNull();
        expect(tagToEdgeIntent(source, 'scope:mcp')).toBeNull();
        expect(tagToEdgeIntent(source, 'owner:coordinator')).toBeNull();
        expect(tagToEdgeIntent(source, 'tranche:1')).toBeNull();
        expect(tagToEdgeIntent(source, 'mandrel-tools')).toBeNull();
        expect(tagToEdgeIntent(source, 'project:whatever')).toBeNull();
      }
    });

    test('an unknown SOURCE TYPE mints nothing — it does NOT inherit the context row', () => {
      // THE failure mode the matrix exists to prevent. A future record type (or a typo, or
      // a caller passing something unvalidated) must get NOTHING, not silently be treated
      // as a context. Cast through unknown because the type system forbids this — the
      // runtime guard has to hold anyway, since the type is erased at the wire boundary.
      const bogus = 'session' as unknown as 'context';
      expect(tagToEdgeIntent(bogus, 'task:abcd1234')).toBeNull();
      expect(tagToEdgeIntent(bogus, 'decision:abcd1234')).toBeNull();
      expect(tagToEdgeIntent(bogus, 'context:abcd1234')).toBeNull();
      expect(tagToEdgeIntent('' as unknown as 'context', 'task:abcd1234')).toBeNull();
    });

    test('a bare prefix with NO referent mints nothing', () => {
      expect(tagToEdgeIntent('context', 'task:')).toBeNull();
      expect(tagToEdgeIntent('task', 'decision:')).toBeNull();
      expect(tagToEdgeIntent('task', 'context:  ')).toBeNull();
    });
  });

  // ── NORMALIZATION (unchanged contract) ─────────────────────────────────────
  test('case- and whitespace-insensitive, ref lower-cased', () => {
    const intent = tagToEdgeIntent('task', '  DECISION:ABCD1234  ');
    expect(intent!.edgeType).toBe('decided_by');
    expect(intent!.ref).toBe('abcd1234');
  });

  // ── PROVENANCE STAMP ───────────────────────────────────────────────────────
  test('every minted intent carries explicit:true (the upgradeability marker)', () => {
    // This is what lets a future migration tell an EXPLICIT-weak related_to (a human
    // stated a relation whose type we would not guess) from an INFERRED-weak related_to
    // (a machine similarity guess). Without it the task→task cell is not upgradeable,
    // which is the entire justification for choosing the weak type.
    expect(tagToEdgeIntent('task', 'task:abcd1234')!.explicit).toBe(true);
    expect(tagToEdgeIntent('context', 'task:abcd1234')!.explicit).toBe(true);
  });

  // ── STRUCTURAL COMPLETENESS (fail-closed, not an allow-list) ───────────────
  test('FAIL-CLOSED: every (node type, prefix) pair has an explicit cell', () => {
    // This one IS derived — on purpose, and it is not a tautology: it does not check WHAT
    // each cell maps to (the literals above own that), only that NO pair is missing. A new
    // EDGE_NODE_TYPE added without a matrix row is a silent deny for that record type; this
    // makes it a loud RED naming the gap.
    const missing: string[] = [];
    for (const source of EDGE_NODE_TYPES) {
      for (const prefix of TAG_EDGE_PREFIXES) {
        if (!TAG_EDGE_MATRIX[source]?.[prefix]) missing.push(`(${source}, ${prefix}:)`);
      }
    }
    expect(missing, 'every (source, prefix) pair needs an explicit cell').toEqual([]);
  });
});
