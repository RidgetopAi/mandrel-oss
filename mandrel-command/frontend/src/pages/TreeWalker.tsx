/**
 * TreeWalker — the work/thread MAP (Command redesign, Phase 3 "Insight").
 * The moat surfaced as a full screen: walk one branch's typed-edge GRAPH (records
 * + the edges linking them + a trust read on each) alongside its recall_thread-ordered STORY.
 * The work-side counterpart to Surveyor (which maps code structure).
 *
 * Thin composition shell only — the header row/view tabs/story parts + all tunables live in
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
import { useSearchParams } from 'react-router-dom';
import { HeaderRow } from './treewalker/HeaderRow';
import { StoryView } from './treewalker/StoryView';
import { WhyView } from './treewalker/WhyView';
import { TimelineView } from './treewalker/TimelineView';
import { MapView } from './treewalker/MapView';
import { useTreeWalkerThread, useTreeWalkerBranches, useTreeWalkerTrunk, useTreeWalkerWhy } from './treewalker/hooks';
import { URL_PARAMS, VIEW_REGISTRY, resolveViewId } from './treewalker/config';
import { usePageProject } from '../hooks/usePageProject';
import { cx } from '../components/ui';
import styles from './treewalker/TreeWalker.module.css';

const TreeWalker: React.FC = () => {
  // The anchor and the selected view live in the URL query so a view of a branch is linkable.
  // No anchor → the backend resolves the LIVE resume anchor. "Jump to trunk" and the
  // branch selector (choosing a branch re-anchors on its spine) both set it. Other params
  // (`project`) are preserved.
  const [searchParams, setSearchParams] = useSearchParams();
  const anchorId = searchParams.get(URL_PARAMS.anchor);
  const view = resolveViewId(searchParams.get(URL_PARAMS.view));
  const recordId = searchParams.get(URL_PARAMS.record);
  const setParam = (key: string, value: string | null) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: false },
    );
  const setAnchorId = (id: string | null) => setParam(URL_PARAMS.anchor, id);
  const [onlyProven, setOnlyProven] = useState(false);

  // THE PAGE OWNS ITS SCOPE. No `allowAll`: the resume-anchor read
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
  const trunkRead = useTreeWalkerTrunk(view === 'map', project.projectId, project.scope);
  const whyRead = useTreeWalkerWhy(view === 'why' ? recordId : null, project.projectId, project.scope);

  // Head-note label: the name of the project THIS PAGE selected — the same value the read
  // is scoped to. (an earlier task — no company fallback.)
  const effectiveProjectName = project.projectName;

  // "Only trusted" narrows the walked graph to canonical-band `trusted` records.
  const graph = React.useMemo(() => {
    if (!data || !onlyProven) return data;
    return { ...data, nodes: data.nodes.filter((n) => n.trust === 'trusted') };
  }, [data, onlyProven]);

  const controlsDisabled = unavailable || !data;

  return (
    <div className={styles.page}>
      <HeaderRow
        projectName={effectiveProjectName}
        branches={branchRail.branches}
        total={branchRail.total}
        isLoading={branchRail.isLoading}
        anchorId={anchorId}
        currentLabel={graph?.anchor?.branchLabel}
        onSelectBranch={setAnchorId}
        onlyProven={onlyProven}
        onToggleOnlyProven={() => setOnlyProven((v) => !v)}
        // A REAL navigation — re-anchor the walk on the trunk head (the project's newest
        // handoff, served on every ThreadGraph). A graph with no handoffs has no target.
        onJumpToTrunk={() => {
          if (data?.trunkAnchorId) setAnchorId(data.trunkAnchorId);
        }}
        disabled={controlsDisabled}
        jumpDisabled={!data?.trunkAnchorId}
      />

      <div className={styles.tabs} role="tablist" aria-label="TreeWalker views">
        {VIEW_REGISTRY.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={`tw-tab-${v.id}`}
            aria-selected={v.id === view}
            aria-controls="tw-view"
            className={cx(styles.tab, v.id === view && styles.tabOn)}
            onClick={() => setParam(URL_PARAMS.view, v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div id="tw-view" role="tabpanel" aria-labelledby={`tw-tab-${view}`}>
        {view === 'why' ? (
          <WhyView
            recordId={recordId}
            why={whyRead.data}
            unavailable={unavailable}
            isLoading={whyRead.isLoading}
            isError={whyRead.isError}
          />
        ) : view === 'map' ? (
          <MapView
            branches={branchRail.branches}
            trunk={trunkRead.trunk}
            sinceDays={branchRail.sinceDays}
            unbranched={branchRail.unbranched}
            unavailable={unavailable}
            isLoading={branchRail.isLoading || trunkRead.isLoading}
          />
        ) : view === 'timeline' ? (
          <TimelineView graph={graph} unavailable={unavailable} isLoading={isLoading} />
        ) : (
          <StoryView graph={graph} unavailable={unavailable} isLoading={isLoading} />
        )}
      </div>
    </div>
  );
};

export default TreeWalker;
