/**
 * STORY-ORDER PARITY — executable drift guard for the mirrored canonical recall_thread
 * ordering (PHASE 2 item e, story half).
 *
 * Loads the REAL mcp-server recallThreadCore.ts + edgeTypes.ts off disk (same technique
 * and same reasons as treewalkerTrustParity.test.ts — the mirror is only honest while a
 * guard executes both sides) and pins:
 *   1. causalDirectionOf over the CANONICAL EDGE_TYPES population — the whole edge
 *      vocabulary as the product defines it, not the edge types this author remembered.
 *   2. computeCausalRanks + orderThread parity on fixture graphs: a causal chain, a
 *      reverse-direction edge, a CYCLE (the cycle backstop), created_at ties, missing
 *      dates, and the empty graph.
 * Refuses to pass if the canonical file cannot be found.
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  causalDirectionOf,
  computeCausalRanks,
  orderThread,
  type OrderEdge,
} from '../config/treewalkerStoryOrder';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CANONICAL_CORE = path.join(REPO_ROOT, 'mcp-server/src/services/recallThreadCore.ts');
const CANONICAL_EDGES = path.join(REPO_ROOT, 'mcp-server/src/config/edgeTypes.ts');

describe('treewalker story order — parity with the canonical recallThreadCore', () => {
  it('the canonical files exist (the guard has ground truth)', () => {
    expect(fs.existsSync(CANONICAL_CORE)).toBe(true);
    expect(fs.existsSync(CANONICAL_EDGES)).toBe(true);
  });

  // LITERAL specifiers, deliberately (dbTestGateCoverage forbids computed require — an
  // unresolvable specifier could hide a DB import). The path constants above remain the
  // existence check's ground truth; these literals point at the same files.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const core = require('../../../../mcp-server/src/services/recallThreadCore');
  const edgeTypes = require('../../../../mcp-server/src/config/edgeTypes');
  /* eslint-enable @typescript-eslint/no-var-requires */

  it('1. causal direction matches for EVERY canonical edge type (the whole population)', () => {
    const population: readonly string[] = edgeTypes.EDGE_TYPES;
    expect(population.length).toBeGreaterThan(5); // the canonical list is non-trivially loaded
    for (const t of population) {
      expect({ type: t, dir: causalDirectionOf(t) }).toEqual({
        type: t,
        dir: core.causalDirectionOf(t),
      });
    }
    // And an unknown type orders nothing on both sides.
    expect(causalDirectionOf('not-an-edge')).toBeUndefined();
    expect(core.causalDirectionOf('not-an-edge')).toBeUndefined();
  });

  // ── 2. ordering parity on fixture graphs ──────────────────────────────────────────
  const d = (iso: string | null) => (iso ? new Date(iso) : null);
  type N = { id: string; createdAt: Date | null };
  const FIXTURES: Array<{ name: string; anchor: string; nodes: N[]; edges: OrderEdge[] }> = [
    {
      name: 'forward chain with feeders (the TreeWalker shape)',
      anchor: 'anchor',
      nodes: [
        { id: 'anchor', createdAt: d('2026-07-14T00:00:00Z') },
        { id: 'spine', createdAt: d('2026-07-01T00:00:00Z') },
        { id: 'dec', createdAt: d('2026-06-20T00:00:00Z') },
        { id: 'ctxA', createdAt: d('2026-07-05T00:00:00Z') },
        { id: 'ctxB', createdAt: d('2026-07-08T00:00:00Z') },
        { id: 'next', createdAt: d('2026-07-10T00:00:00Z') },
      ],
      edges: [
        { from: 'anchor', to: 'spine', type: 'informs' },
        { from: 'spine', to: 'dec', type: 'decided_by' },
        { from: 'ctxA', to: 'spine', type: 'informs' },
        { from: 'ctxB', to: 'spine', type: 'informs' },
        { from: 'spine', to: 'next', type: 'informs' },
      ],
    },
    {
      name: 'reverse edges (supersedes / learned_from / depends_on)',
      anchor: 'n1',
      nodes: [
        { id: 'n1', createdAt: d('2026-07-01T00:00:00Z') },
        { id: 'n2', createdAt: d('2026-07-02T00:00:00Z') },
        { id: 'n3', createdAt: d('2026-07-03T00:00:00Z') },
        { id: 'n4', createdAt: d('2026-07-04T00:00:00Z') },
      ],
      edges: [
        { from: 'n2', to: 'n3', type: 'supersedes' },
        { from: 'n4', to: 'n3', type: 'learned_from' },
        { from: 'n4', to: 'n2', type: 'depends_on' },
      ],
    },
    {
      name: 'a causal CYCLE (the backstop must not hang and must agree)',
      anchor: 'a',
      nodes: [
        { id: 'a', createdAt: d('2026-07-01T00:00:00Z') },
        { id: 'b', createdAt: d('2026-07-02T00:00:00Z') },
        { id: 'c', createdAt: d('2026-07-03T00:00:00Z') },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'caused' },
        { from: 'b', to: 'c', type: 'caused' },
        { from: 'c', to: 'a', type: 'caused' },
      ],
    },
    {
      name: 'created_at ties + a MISSING date (sorts last) + weak edges ordering nothing',
      anchor: 'w',
      nodes: [
        { id: 'w', createdAt: d('2026-07-01T00:00:00Z') },
        { id: 'x', createdAt: d('2026-07-02T00:00:00Z') },
        { id: 'y', createdAt: d('2026-07-02T00:00:00Z') },
        { id: 'z', createdAt: null },
      ],
      edges: [
        { from: 'x', to: 'y', type: 'related_to' },
        { from: 'z', to: 'y', type: 'possibly_supersedes' },
      ],
    },
    { name: 'empty graph', anchor: 'ghost', nodes: [], edges: [] },
  ];

  test.each(FIXTURES.map((f) => [f.name, f] as const))('parity: %s', (_name, f) => {
    const mirrorOrder = orderThread(f.nodes, f.edges, f.anchor).map((n) => n.id);
    const canonicalOrder = core
      .orderThread(f.nodes, f.edges.map((e) => ({ from: e.from, to: e.to, type: e.type })), f.anchor)
      .map((n: { id: string }) => n.id);
    expect(mirrorOrder).toEqual(canonicalOrder);

    const ids = f.nodes.map((n) => n.id);
    const mirrorRanks = computeCausalRanks(ids, f.edges);
    const canonicalRanks = core.computeCausalRanks(ids, f.edges);
    expect(Object.fromEntries(mirrorRanks)).toEqual(Object.fromEntries(canonicalRanks));
  });
});
