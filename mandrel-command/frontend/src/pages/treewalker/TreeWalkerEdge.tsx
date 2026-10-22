/**
 * TreeWalkerEdge — the custom xyflow edge for the thread canvas: a typed, labelled, colour-
 * coded connection (informs=teal / decided_by=blue / caused=violet / supersedes=dashed
 * rose). The colour + dash come from the CSS module edge class (token-only, no inline
 * literal); the label chip is the shared edge vocabulary (edgeLabel) so a new edge type
 * never renders as a raw slug. The label doubles as the hover title.
 */
import React from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react';
import { cx } from '../../components/ui';
import type { TreeWalkerEdgeData } from './graph';
import { edgeLabel } from './config';
import styles from './TreeWalker.module.css';

export const TreeWalkerEdge: React.FC<EdgeProps<Edge<TreeWalkerEdgeData>>> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}) => {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const klass = data?.klass ?? 'informs';
  const label = data?.edgeType ? edgeLabel(data.edgeType, 'outgoing') : '';
  return (
    <>
      <BaseEdge id={id} path={path} className={cx(styles.edge, styles[`edge-${klass}`])} />
      {label && (
        <EdgeLabelRenderer>
          <span
            className={cx(styles.elab, styles[`elab-${klass}`])}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={label}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

export default TreeWalkerEdge;
