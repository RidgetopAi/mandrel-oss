/**
 * A seeded branch for the Timeline view: a dense Oct 25 cluster of reviews and
 * problems crossing a local midnight, an Outcome, then a 30 h gap before a failed publish. Used
 * by the TimelineView test and the browser walkthrough (route interception).
 */
import type { ThreadGraph, ThreadNode } from '../../api/domains/treewalker';

const id = (n: number) => `${(0x7100 + n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const node = (n: number, over: Partial<ThreadNode> & Pick<ThreadNode, 'kind' | 'title' | 'createdAt'>): ThreadNode => ({
  id: id(n),
  trust: 'unproven',
  inBranch: true,
  ...over,
});

const NODES: ThreadNode[] = [
  node(0, { kind: 'context', contextType: 'planning', title: 'Publish the product tree to OSS', createdAt: '2026-10-25T08:00:00.000Z', isSpine: true }),
  node(1, { kind: 'decision', title: 'LOCK: publish from the prod tree', createdAt: '2026-10-25T09:00:00.000Z' }),
  node(2, { kind: 'context', contextType: 'reflections', title: 'Review: licence headers', createdAt: '2026-10-25T14:00:00.000Z' }),
  node(3, { kind: 'context', contextType: 'error', title: 'Problem: tenant hostname leaked', createdAt: '2026-10-25T16:00:00.000Z' }),
  node(4, { kind: 'context', contextType: 'reflections', title: 'Review: telemetry defaults', createdAt: '2026-10-25T20:00:00.000Z' }),
  node(5, { kind: 'context', contextType: 'error', title: 'Problem: migration order wrong', createdAt: '2026-10-26T01:00:00.000Z' }),
  node(6, { kind: 'context', contextType: 'milestone', title: 'v0.70.0 shipped', createdAt: '2026-10-26T06:00:00.000Z' }),
  node(7, { kind: 'context', contextType: 'note', title: 'Smoke notes', createdAt: '2026-10-26T09:00:00.000Z' }),
  node(8, { kind: 'context', contextType: 'error', title: 'Problem: publish failed', createdAt: '2026-10-27T15:00:00.000Z' }),
  node(9, { kind: 'decision', title: 'Retry the publish with a fresh token', createdAt: '2026-10-27T16:00:00.000Z' }),
];

export const TIMELINE_IDS = { firstReview: id(2), failedPublish: id(8) } as const;

export const TIMELINE_THREAD: ThreadGraph = {
  anchor: { branchLabel: 'timeline-demo', anchorId: id(0), recordCount: NODES.length },
  spine: [
    { tier: 'tree', label: 'tree:mandrel-product' },
    { tier: 'branch', label: 'timeline-demo', id: id(0) },
  ],
  nodes: NODES,
  edges: [],
  story: [],
  trunkAnchorId: null,
  memberTotal: NODES.length,
  truncated: false,
};
