/**
 * `depends_on` VOCABULARY WIRING — task-source edge minting Q2 (step 2).
 *
 * Adding an edge type is NOT one edit — it is five, in five files, and four of them fail
 * SILENTLY when forgotten (the type still works, it just ranks/orders/scores wrong):
 *
 *   1. config/edgeTypes.ts          — the spec (the single source everything derives from)
 *   2. database/migrations/066      — the DB CHECK constraint (this one fails LOUD)
 *   3. config/threadConfig.ts       — FRONTIER_EDGE_TYPE_PRIORITY (silent: falls to default 50)
 *   4. services/recallThreadCore.ts — CAUSAL_DIRECTION (silent: carries no story ordering)
 *   5. services/trust.ts            — must stay OUT of OUTCOME_OUT_EDGE_TYPES (silent: mints trust)
 *
 * This suite is armor for all five. #5 lives in trustExcludesRelatedTo.contract.test.ts
 * (alongside its sibling invariant); the rest are here.
 *
 * NOT AN ALLOW-LIST. The assertions below are LITERAL — the tier is written as
 * `70`, the direction as `'reverse'` — never derived from the config being checked. A test
 * that reads the map and asserts the map against itself passes no matter what the map says.
 * Separately, the coverage test fails CLOSED: every type declared in EDGE_TYPES must carry an
 * EXPLICIT frontier rank, so the next edge type added cannot silently inherit the default.
 */

import { describe, test, expect } from 'vitest';
import { EDGE_TYPES, EDGE_TYPE_SPECS, edgeTypeSpec, isEdgeType } from '../config/edgeTypes.js';
import { FRONTIER_EDGE_TYPE_PRIORITY } from '../config/threadConfig.js';
import { causalDirectionOf } from '../services/recallThreadCore.js';

describe('depends_on vocabulary wiring', () => {
  // ── 1. THE SPEC ─────────────────────────────────────────────────────────────
  test('depends_on is a declared edge type with the task→task scheduling semantics', () => {
    expect(isEdgeType('depends_on')).toBe(true);
    const spec = edgeTypeSpec('depends_on');
    expect(spec).toBeDefined();
    // LITERAL: the reverse reading is what surfaces to a user reading the edge backwards.
    expect(spec!.reverse).toBe('blocks');
    expect(spec!.direction).toBe('task → task');
  });

  test('task→task types exist ONLY for unambiguous signals — the TAG stays weak', () => {
    // The rule: a strong task→task edge must be earned by an UNAMBIGUOUS signal.
    // depends_on earned its slot from the typed `dependencies` field. subtask_of is minted
    // ONLY from the explicit `parentTaskId` param on task_create (an earlier task — position
    // never mints it): a first-class declared param is exactly the unambiguous signal the
    // original refusal said the slot was waiting for. The AMBIGUOUS signal (a `task:`
    // TAG on a task) still mints the weak `related_to` and no strong type exists for it.
    expect(EDGE_TYPES).not.toContain('follows_from');
    expect(EDGE_TYPES).not.toContain('blocks');
    // The full domain, pinned literally — any vocabulary change at all lands here first.
    expect([...EDGE_TYPES]).toEqual([
      'decided_by',
      'caused',
      'built_by',
      'supersedes',
      'possibly_supersedes',
      'learned_from',
      'proposed_by',
      'informs',
      'produced_outcome',
      'depends_on',
      'subtask_of',
      'related_to',
    ]);
  });

  // ── 3. FRONTIER PRIORITY ────────────────────────────────────────────────────
  test('depends_on ranks in the STRUCTURAL tier, below the evidential edges', () => {
    // LITERAL tier value — not read back from the map it is checking.
    expect(FRONTIER_EDGE_TYPE_PRIORITY.depends_on).toBe(70);
    // And the RELATIONSHIP that tier encodes: structure outranks weak association, but
    // evidence outranks structure. These comparisons are the actual design intent.
    expect(FRONTIER_EDGE_TYPE_PRIORITY.depends_on).toBeGreaterThan(
      FRONTIER_EDGE_TYPE_PRIORITY.related_to,
    );
    expect(FRONTIER_EDGE_TYPE_PRIORITY.depends_on).toBeLessThan(
      FRONTIER_EDGE_TYPE_PRIORITY.decided_by,
    );
    expect(FRONTIER_EDGE_TYPE_PRIORITY.depends_on).toBeLessThan(
      FRONTIER_EDGE_TYPE_PRIORITY.informs,
    );
  });

  test('FAIL-CLOSED: every declared edge type carries an EXPLICIT frontier rank', () => {
    // threadConfig has a `frontierDefaultEdgePriority` (50) for robustness at RUNTIME — it
    // must not become a license to skip ranking at DESIGN time. Without this check, adding an
    // edge type and forgetting the rank is a SILENT behaviour choice (it lands mid-tier and
    // nobody decided that). Deny-by-default: an unranked type is a loud RED naming itself.
    const unranked = EDGE_TYPE_SPECS.map((s) => s.type).filter(
      (t) => FRONTIER_EDGE_TYPE_PRIORITY[t] === undefined,
    );
    expect(
      unranked,
      `these edge types have no explicit FRONTIER_EDGE_TYPE_PRIORITY entry — rank them ` +
        `deliberately in config/threadConfig.ts rather than inheriting the default`,
    ).toEqual([]);
  });

  // ── 4. CAUSAL DIRECTION ─────────────────────────────────────────────────────
  test('depends_on orders the story REVERSE: the depended-on task comes first', () => {
    // Stored A→B means "A depends on B", so B precedes A in the narrative — you cannot tell
    // the story of A before the thing it depends on. LITERAL 'reverse'.
    expect(causalDirectionOf('depends_on')).toBe('reverse');
  });

  test('the weak/soft edges still carry NO causal ordering (unchanged by this work)', () => {
    // Guards the blast radius of the CAUSAL_DIRECTION edit: related_to and
    // possibly_supersedes are deliberately absent from the map and must stay that way.
    expect(causalDirectionOf('related_to')).toBeUndefined();
    expect(causalDirectionOf('possibly_supersedes')).toBeUndefined();
  });
});
