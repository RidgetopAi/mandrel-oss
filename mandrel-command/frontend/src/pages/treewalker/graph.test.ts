/**
 * TreeWalker builders + roll-up unit tests — pure, no DOM. Proves the domain ThreadGraph →
 * xyflow Node[]/Edge[] mapping (deterministic grid layout, spine-first ordering, typed edge
 * colour class) and the trust-count roll-up that feeds the trust bar / legend. These are the
 * data-shaping seam the screen lights up on once the backend endpoint ships.
 */
import { describe, it, expect } from 'vitest';
import type { ThreadGraph } from '../../api/domains/treewalker';
import { buildFlowNodes, buildFlowEdges, TW_NODE_TYPE, TW_EDGE_TYPE } from './graph';
import { trustCounts, trustTotal, id8 } from './parts';
import { TRUST_META, KIND_META, edgeClass } from './config';

const GRAPH: ThreadGraph = {
  anchor: { branchLabel: 'command-redesign', anchorId: 'da47db21-1111-2222-3333-444444444444', recordCount: 4 },
  spine: [
    { label: '★ CANONICAL — north star', tier: 'root', id: 'ca000000-0000-0000-0000-00000000000c' },
    { label: 'tree:mandrel-product', tier: 'tree' },
    { label: 'handoffs · 3', tier: 'trunk', id: 'e4bb5dc5-0000-0000-0000-00000000aaaa' },
    { label: 'command-redesign', tier: 'branch' },
  ],
  nodes: [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', kind: 'decision', title: 'design-language', trust: 'trusted' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', kind: 'task', title: 'command-redesign', trust: 'ok', isSpine: true },
    { id: 'cccccccc-0000-0000-0000-000000000003', kind: 'context', title: 'Sessions', trust: 'trusted' },
    { id: 'dddddddd-0000-0000-0000-000000000004', kind: 'handoff', title: 'resume handoff', trust: 'unproven', isCurrent: true },
  ],
  edges: [
    { id: 'e1', source: 'bbbbbbbb-0000-0000-0000-000000000002', target: 'aaaaaaaa-0000-0000-0000-000000000001', edgeType: 'decided_by' },
    { id: 'e2', source: 'cccccccc-0000-0000-0000-000000000003', target: 'bbbbbbbb-0000-0000-0000-000000000002', edgeType: 'informs' },
    { id: 'e3', source: 'dddddddd-0000-0000-0000-000000000004', target: 'bbbbbbbb-0000-0000-0000-000000000002', edgeType: 'supersedes' },
  ],
  story: [],
  trunkAnchorId: 'e4bb5dc5-0000-0000-0000-00000000aaaa',
};

describe('buildFlowNodes', () => {
  it('maps every record to a typed xyflow node', () => {
    const nodes = buildFlowNodes(GRAPH);
    expect(nodes).toHaveLength(4);
    expect(nodes.every((n) => n.type === TW_NODE_TYPE)).toBe(true);
    expect(nodes.every((n) => typeof n.position.x === 'number' && typeof n.position.y === 'number')).toBe(true);
  });

  it('pins the spine node first so it heads the layout', () => {
    const nodes = buildFlowNodes(GRAPH);
    expect(nodes[0].data.node.isSpine).toBe(true);
  });

  it('is deterministic — same input, same positions', () => {
    const a = buildFlowNodes(GRAPH);
    const b = buildFlowNodes(GRAPH);
    expect(a.map((n) => n.position)).toEqual(b.map((n) => n.position));
  });
});

describe('buildFlowEdges', () => {
  it('maps every edge to a typed xyflow edge with its colour class', () => {
    const edges = buildFlowEdges(GRAPH);
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.type === TW_EDGE_TYPE)).toBe(true);
    expect(edges.find((e) => e.id === 'e1')?.data?.klass).toBe('decided');
    expect(edges.find((e) => e.id === 'e2')?.data?.klass).toBe('informs');
    expect(edges.find((e) => e.id === 'e3')?.data?.klass).toBe('supersedes');
  });
});

describe('edgeClass', () => {
  it('falls back to informs for an unknown edge type', () => {
    expect(edgeClass('related_to')).toBe('informs');
    expect(edgeClass('caused')).toBe('caused');
  });
});

describe('trustCounts / trustTotal', () => {
  it('rolls records up per trust level in fixed order, dropping zero counts', () => {
    const counts = trustCounts(GRAPH.nodes);
    // trusted ×2, ok ×1, unproven ×1, stale ×0 (dropped)
    expect(counts.map((c) => c.trust)).toEqual(['trusted', 'ok', 'unproven']);
    expect(counts.find((c) => c.trust === 'trusted')?.count).toBe(2);
    expect(trustTotal(counts)).toBe(4);
  });

  it('handles an empty/undefined thread', () => {
    expect(trustCounts(undefined)).toEqual([]);
    expect(trustTotal([])).toBe(0);
  });
});

describe('vocab maps cover every kind + trust level', () => {
  it('has a colour token for each record kind', () => {
    for (const k of ['decision', 'task', 'context', 'handoff'] as const) {
      expect(KIND_META[k].dotVar).toMatch(/^--/);
    }
  });
  it('has a colour token for each trust level', () => {
    for (const t of ['trusted', 'ok', 'unproven', 'stale', 'superseded', 'contradicted'] as const) {
      expect(TRUST_META[t].dotVar).toMatch(/^--/);
    }
  });
});

describe('id8', () => {
  it('strips dashes and takes the first 8 chars', () => {
    expect(id8('da47db21-1111-2222-3333-444444444444')).toBe('da47db21');
    expect(id8(null)).toBe('');
  });
});
