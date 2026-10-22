/**
 * TreeWalkerNode — the custom xyflow node for the thread canvas. Renders the mock's node
 * chip: a kind-coloured body dot, the record title, a kind tag, and a TRUST RING at the
 * corner (proven=green / soaking=teal / unproven=amber / stale=grey). The spine node and the
 * "you are here" current node get their own emphasis classes; a stale node is dimmed +
 * struck-through. All colour comes from the CSS module (token-only) via the kind/trust
 * classes — never an inline literal. Hidden Handles let edges attach.
 */
import React from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { cx } from '../../components/ui';
import type { TreeWalkerNodeData } from './graph';
import { kindLabel } from './config';
import { id8 } from './parts';
import styles from './TreeWalker.module.css';

export const TreeWalkerNode: React.FC<NodeProps<Node<TreeWalkerNodeData>>> = ({ data }) => {
  const { node } = data;
  // Struck-through: the do-not-act-on-this bands (stale + the two abstain caps).
  const isStale =
    node.trust === 'stale' || node.trust === 'superseded' || node.trust === 'contradicted';
  return (
    <div
      className={cx(
        styles.gn,
        styles[`kind-${node.kind}`],
        node.isSpine && styles.spineNode,
        node.isCurrent && styles.currentNode,
        isStale && styles.gnStale,
      )}
      title={`${node.title} · ${node.kind} · ${node.trust}`}
    >
      <Handle type="target" position={Position.Top} className={styles.handle} isConnectable={false} />
      <span className={cx(styles.gnDot, styles[`dot-${node.kind}`])} aria-hidden="true" />
      <span className={styles.gnLabel}>{node.title}</span>
      <span className={styles.gnKind}>{kindLabel(node.kind)}</span>
      <span className={styles.gnId}>{id8(node.id)}</span>
      <span
        className={cx(styles.trust, styles[`trust-${node.trust}`])}
        aria-hidden="true"
        title={`trust: ${node.trust}`}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className={styles.handle}
        isConnectable={false}
      />
    </div>
  );
};

export default TreeWalkerNode;
