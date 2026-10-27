/**
 * TreeWalker — the work/thread MAP (Command redesign, Phase 3 "Insight").
 * The moat surfaced as a full screen: walk one branch's typed-edge GRAPH (records
 * + the edges linking them + a trust read on each) alongside its recall_thread-ordered STORY.
 * The work-side counterpart to Surveyor (which maps code structure).
 *
 * Thin composition shell only — the graph/story/toolbar/spine parts + all tunables live in
 * `pages/treewalker/`. Data rides the unified `api.treewalker.*` client through
 * `useTreeWalkerThread`. Zero antd; colour is 100% token-driven (guard-tested).
 *
 * SCOPE: this page owns its own project selector. The thread read pins
 * X-Project-ID from that selection per request (`usePageProject().scope()`), and the
 * head-note names the same project — previously it rode the global switcher, so the same
 * screen could walk a different project's thread with nothing on screen changing.
 *
 * BACKEND (LIVE 2026-07-15): the whole-thread graph + recall_thread
 * story + trust read ships behind GET /api/treewalker/thread (resume anchor) and
 * /api/treewalker/:anchorId/thread. With no explicit anchor the screen defaults to the live
 * resume anchor the backend resolves. A genuinely-empty thread still renders the honest empty
 * state (an earlier decision — never fabricated).
 */
import React, { useState } from 'react';
import { SpineRibbon } from './treewalker/SpineRibbon';
import { Toolbar } from './treewalker/Toolbar';
import { GraphCanvas } from './treewalker/GraphCanvas';
import { StoryRail } from './treewalker/StoryRail';
import { BranchRail } from './treewalker/BranchRail';
import { useTreeWalkerThread, useTreeWalkerBranches } from './treewalker/hooks';
import type { TreeWalkerView } from './treewalker/config';
import { usePageProject } from '../hooks/usePageProject';
import { cx } from '../components/ui';
import { TreeIcon } from './treewalker/icons';
import styles from './treewalker/TreeWalker.module.css';

const TreeWalker: React.FC = () => {
  // The anchor the screen walks. Null → the backend resolves the LIVE resume anchor (newest
  // `ref:resume` context for the active project) via the no-arg thread endpoint. An explicit
  // id re-anchors the walk: "Jump to trunk" (the trunk head the backend serves on every
  // graph) and the BranchRail (click a branch to re-anchor on its spine) both set it.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [view, setView] = useState<TreeWalkerView>('graph');
  const [onlyProven, setOnlyProven] = useState(false);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);

  // THE PAGE OWNS ITS SCOPE. This screen had no control of its own and
  // rode whatever the deleted global switcher last pointed at — so "which thread am I
  // walking" was answered somewhere off-screen. No `allowAll`: the resume-anchor read
  // resolves a single project's newest `ref:resume` context, and an unscoped call is not
  // an empty one — for an admin `resolveListScope` widens it to every project's threads,
  // which is a meaningless walk, not a wider one.
  const project = usePageProject();
  const { data, isLoading, unavailable } = useTreeWalkerThread(
    anchorId,
    project.projectId,
    project.scope,
  );
  const branchRail = useTreeWalkerBranches(project.projectId, project.scope);

  // Head-note label: the name of the project THIS PAGE selected — the same value the read
  // is scoped to, from the same source, so the note cannot describe a different project
  // than the graph below it. (an earlier task — this used to be a hardcoded company name
  // baked into every tenant's bundle. No company fallback.)
  const effectiveProjectName = project.projectName;

  // "Only trusted" narrows the walked graph + story to canonical-band `trusted` records.
  const graph = React.useMemo(() => {
    if (!data || !onlyProven) return data;
    return {
      ...data,
      nodes: data.nodes.filter((n) => n.trust === 'trusted'),
      story: data.story.filter((s) => s.trust === 'trusted'),
    };
  }, [data, onlyProven]);

  const controlsDisabled = unavailable || !data;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.headRow}>
          <TreeIcon size={20} className={styles.headIco} />
          <h2 className={styles.title}>TreeWalker</h2>
          <span className={styles.headNote}>
            {effectiveProjectName ? `${effectiveProjectName} · work map` : 'work map'}
          </span>
        </div>
        <div className={styles.sub}>
          How this thread linked itself — every record, the typed edge that connects it, and
          how much to trust it.
        </div>
      </div>

      <SpineRibbon spine={graph?.spine} />

      <BranchRail
        branches={branchRail.branches}
        total={branchRail.total}
        cap={branchRail.cap}
        isLoading={branchRail.isLoading}
        activeSpineId={anchorId}
        onSelect={setAnchorId}
      />

      <Toolbar
        anchor={graph?.anchor}
        view={view}
        onViewChange={setView}
        onlyProven={onlyProven}
        onToggleOnlyProven={() => setOnlyProven((v) => !v)}
        // PHASE 2 item d: a REAL navigation — re-anchor the walk on the trunk head (the
        // project's newest handoff, served on every ThreadGraph). Disabled alongside the
        // other controls, and a graph with no handoffs simply has no target (null-safe).
        onJumpToTrunk={() => {
          if (data?.trunkAnchorId) setAnchorId(data.trunkAnchorId);
        }}
        disabled={controlsDisabled}
        jumpDisabled={!data?.trunkAnchorId}
      />

      <div className={cx(styles.tw, view === 'story' && styles.twStory)}>
        {view === 'graph' && (
          <GraphCanvas graph={graph} unavailable={unavailable} isLoading={isLoading} />
        )}
        <StoryRail
          graph={graph}
          unavailable={unavailable}
          isLoading={isLoading}
          activeStepId={activeStepId}
          onStepClick={setActiveStepId}
          onWalk={() => walkStory(graph?.story?.[0]?.id ?? null, setActiveStepId)}
        />
      </div>
    </div>
  );
};

/** Start the walk at the first story step (advances via the step buttons thereafter). */
function walkStory(firstId: string | null, setActive: (id: string | null) => void): void {
  setActive(firstId);
}

export default TreeWalker;
