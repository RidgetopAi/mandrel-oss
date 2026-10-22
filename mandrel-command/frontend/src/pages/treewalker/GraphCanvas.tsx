/**
 * GraphCanvas — the LEFT panel: the xyflow node-graph of the thread, built on the shared
 * themed GraphView (P0.6 baseline — it names TreeWalker as its intended consumer). Nodes are
 * colour-coded by record kind with a trust ring + spine/current emphasis; edges are typed +
 * labelled. The three-row legend overlays the canvas. When no thread is loaded the canvas
 * shows an honest "thread data not yet available" overlay — never a fabricated graph.
 */
import React, { useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { GraphView } from '../../components/charts';
import { Empty } from '../../components/ui';
import type { ThreadGraph } from '../../api/domains/treewalker';
import {
  buildFlowNodes,
  buildFlowEdges,
  TW_NODE_TYPE,
  TW_EDGE_TYPE,
  type TreeWalkerNodeData,
  type TreeWalkerEdgeData,
} from './graph';
import { TreeWalkerNode } from './TreeWalkerNode';
import { TreeWalkerEdge } from './TreeWalkerEdge';
import { Legend } from './Legend';
import { TREEWALKER_CONFIG } from './config';
import styles from './TreeWalker.module.css';

const nodeTypes = { [TW_NODE_TYPE]: TreeWalkerNode };
const edgeTypes = { [TW_EDGE_TYPE]: TreeWalkerEdge };

export interface GraphCanvasProps {
  graph: ThreadGraph | undefined;
  unavailable: boolean;
  isLoading: boolean;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({ graph, unavailable, isLoading }) => {
  const nodes = useMemo<Node<TreeWalkerNodeData>[]>(
    () => (graph ? buildFlowNodes(graph) : []),
    [graph],
  );
  const edges = useMemo<Edge<TreeWalkerEdgeData>[]>(
    () => (graph ? buildFlowEdges(graph) : []),
    [graph],
  );

  const hasGraph = nodes.length > 0;

  return (
    <div className={styles.canvasWrap} data-testid="tw-canvas">
      <GraphView
        nodes={nodes}
        edges={edges}
        height={TREEWALKER_CONFIG.canvasHeight}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        fitView={hasGraph}
      />
      {hasGraph && <Legend />}
      {!hasGraph && (
        <div className={styles.canvasOverlay}>
          <Empty
            title={
              isLoading
                ? 'Loading the thread…'
                : unavailable
                  ? 'Thread data not yet available'
                  : 'No records on this thread yet'
            }
            description={
              isLoading
                ? undefined
                : unavailable
                  ? 'The TreeWalker backend (thread-graph + recall_thread story) isn’t wired yet. The full canvas lights up the moment it ships.'
                  : 'This thread has no linked records to walk.'
            }
          />
        </div>
      )}
    </div>
  );
};

export default GraphCanvas;
