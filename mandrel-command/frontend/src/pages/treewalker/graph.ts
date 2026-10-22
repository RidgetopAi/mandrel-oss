/**
 * Graph builders — turn the domain ThreadGraph into the xyflow Node[] / Edge[] the themed
 * GraphView renders. Pure + deterministic (the layout is a fixed grid keyed on record order,
 * NOT a random force layout) so the same thread always draws the same, and the builders are
 * unit-testable without a DOM. Colour never lands here as a literal: nodes/edges carry their
 * kind/trust/edgeType in `data` and the custom Node/Edge components resolve the colour from
 * the CSS module (token-only). This is the "node/edge/layout builders are yours" seam.
 */
import type { Node, Edge } from '@xyflow/react';
import type { ThreadGraph, ThreadNode, ThreadEdge } from '../../api/domains/treewalker';
import { TREEWALKER_CONFIG, edgeClass } from './config';

/** The data an xyflow node carries for the custom TreeWalkerNode renderer. */
export interface TreeWalkerNodeData extends Record<string, unknown> {
  node: ThreadNode;
}

/** The data an xyflow edge carries for the custom TreeWalkerEdge renderer. */
export interface TreeWalkerEdgeData extends Record<string, unknown> {
  edgeType: string;
  /** The CSS-module class that colours the edge (decided/informs/caused/supersedes). */
  klass: string;
}

/** The registered custom node/edge type keys (passed to GraphView via nodeTypes/edgeTypes). */
export const TW_NODE_TYPE = 'twNode';
export const TW_EDGE_TYPE = 'twEdge';

/**
 * Lay the thread's records out on a deterministic grid (columns from config), returning the
 * xyflow nodes. The spine node is pinned to the first slot so it reads as the anchor; the
 * rest follow in thread order. `selectable` on, `draggable` on for free exploration.
 */
export function buildFlowNodes(graph: Pick<ThreadGraph, 'nodes'>): Node<TreeWalkerNodeData>[] {
  const { columns, columnGap, rowGap, padX, padY } = TREEWALKER_CONFIG.layout;
  // Spine first (the anchor reads as the head of the layout), then the rest in thread order.
  const ordered: ThreadNode[] = [
    ...graph.nodes.filter((n) => n.isSpine),
    ...graph.nodes.filter((n) => !n.isSpine),
  ];
  return ordered.map((node, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    return {
      id: node.id,
      type: TW_NODE_TYPE,
      position: { x: padX + col * columnGap, y: padY + row * rowGap },
      data: { node },
      draggable: true,
      selectable: true,
    };
  });
}

/** Build the xyflow edges, tagging each with its edge vocabulary + colour class. */
export function buildFlowEdges(graph: Pick<ThreadGraph, 'edges'>): Edge<TreeWalkerEdgeData>[] {
  return graph.edges.map((edge: ThreadEdge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: TW_EDGE_TYPE,
    data: { edgeType: edge.edgeType, klass: edgeClass(edge.edgeType) },
  }));
}
