/**
 * Contexts — the Command "wide reader" memory screen, on the P0 foundation (P0.3 primitives
 * + P0.2 tokens, ZERO antd), all data through the unified `api` client via react-query
 * (src/pages/contexts/hooks.ts). Thin composition here; the `contexts/` module owns the
 * parts, data, config, and the token-driven stylesheet — each section owning its
 * loading/empty/error state.
 *
 * A two-column screen — the SAME shape as the Decisions "why ledger" (one record pattern,
 * one mental model): a filter bar (semantic search + type facets with live counts + sort)
 * over a scrollable list rail (left), and the reader (right) — rendered markdown + the
 * typed-edge thread box (the TreeWalker moat) + the ported action set (edit / delete /
 * share / copy-id / copy-ref / related / metadata), all owned by ContextDetail. The rail
 * track and reader measure come from the SHARED --rail-width / --reader-width tokens, so
 * this screen and Decisions can't drift apart again.
 *
 * The reader is driven by the `/contexts/:id` route param, so it doubles as the deep-link +
 * `/r/:id` resolve landing target: selecting an item navigates to `/contexts/:id`, and a
 * direct link pre-selects it.
 *
 * HISTORY: a 20-card grid + slide-over drawer shipped here 2026-07-16;
 * The operator used it live and REVERSED it — rail+reader reads better for long-form memory
 * records.
 */
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Heading, Text, Drawer } from '../components/ui';
import { FilterBar } from './contexts/FilterBar';
import { ContextList } from './contexts/ContextList';
import { ContextDetail } from './contexts/ContextDetail';
import { BulkToolbar } from './contexts/BulkToolbar';
import { useContextSelection } from './contexts/selection';
import { useContext, useContextList, useContextStats } from './contexts/hooks';
import { usePageProject } from '../hooks/usePageProject';
import { useRecordProjectSync } from '../hooks/useRecordProjectSync';
import { useIsStackedRecordLayout } from '../hooks/useIsStackedRecordLayout';
import { type SortValue } from './contexts/config';
import styles from './contexts/Contexts.module.css';

const Contexts: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();

  // THE PAGE OWNS ITS PROJECT (epic 41293984). It no longer rides a global selector —
  // there isn't one. The selection lives in `?project=`, opens at the user's default, and
  // every request below carries `project.scope()` so the header names THIS page's project
  // rather than the ambient default.
  //
  // NO `allowAll` here, on purpose: a text search is scoped by project in the canonical
  // engine and 400s unscoped. Offering "All projects" would re-create the
  // dead end this page used to have to guard against.
  const project = usePageProject();
  const projectId = project.projectId;

  // MOBILE OVERLAY (an earlier decision — the operator, filed from his phone). Below
  // the rail+reader breakpoint the two columns collapse to one, so a reader rendered inline
  // lands far below a (often long) list — every selection meant scrolling past the whole
  // list to read the very record just tapped. Below that width, the reader renders in a
  // `Drawer` (fixed, portal-rendered, anchored at the top of the viewport) instead of the
  // second grid column; above it, nothing here changes — same two columns as always.
  const isStacked = useIsStackedRecordLayout();

  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<SortValue>('newest');

  // The ONE remaining way to have no project: the instance has no projects at all (or they
  // are still loading). `scope()` throws rather than falling back, so every read is gated
  // on `ready` and the rail shows an honest "no project" state instead of a red error.
  // The old `needsProject` gate — "you typed a search while on All Projects" — is GONE
  // with the All-projects option that produced it.
  const list = useContextList({
    query: search,
    type,
    sort,
    projectId,
    scope: project.scope,
    enabled: project.ready,
  });
  const stats = useContextStats(projectId, project.scope, project.ready);

  const rows = React.useMemo(() => list.data?.contexts ?? [], [list.data]);

  // The selected context: the route id if present, else — ON DESKTOP ONLY — the first row,
  // so the always-visible second column is never empty. Selecting an item navigates to
  // /contexts/:id so the reader + deep-link stay one screen.
  //
  // CLOSING THE OVERLAY (an earlier decision — second critic finding, T3):
  // `deselect` drops the route to bare `/contexts`, which also drops any `?project=` the
  // URL was carrying. That is harmless by construction, not by luck: `?project=` is only
  // ever a deep-link OVERRIDE (`usePageProject`/`useRecordProjectSync` above), and the
  // moment it differs from the page's project it gets ADOPTED into the persisted topbar
  // selection (`projectSelectionStore`, localStorage) — so the scope survives in the store
  // independent of the query string, and closing cannot un-scope the page.
  //
  // The row highlight is the other half, and here mobile DELIBERATELY does NOT match
  // desktop: on desktop the reader is ALWAYS visible, so falling back to the first row
  // keeps "what's highlighted" and "what's rendered" in agreement. On mobile, once the
  // Drawer is closed NOTHING is being read — falling back to the first row would highlight
  // it while showing nothing, which lies about what's selected. So on mobile with no route
  // id there is no highlight at all; `isStacked` gates the same fallback desktop always
  // takes.
  const selectedId = routeId ?? (isStacked ? null : rows[0]?.id) ?? null;
  const select = React.useCallback((id: string) => navigate(`/contexts/${id}`), [navigate]);
  const deselect = React.useCallback(() => navigate('/contexts'), [navigate]);

  // Paint the reader instantly from the already-loaded row while the detail settles.
  const fallback = React.useMemo(
    () => rows.find((r) => r.id === selectedId),
    [rows, selectedId],
  );

  // A `/r/<id8>` short link can land on a context OUTSIDE the selected project. The reader
  // renders it either way (a by-id read is authorized against the RECORD's project, not the
  // header), but the rail beside it would show a different project's rows — and the global
  // switcher that used to be the escape hatch is gone. So the page follows the record:
  // once the detail resolves, `?project=` is re-pointed at the record's own project.
  // `useContext` here shares react-query's cache entry with the one inside ContextDetail
  // (same key), so this costs no extra request — it is a read of the same record.
  const detail = useContext(selectedId);
  useRecordProjectSync(project, detail.data?.project_id ?? fallback?.project_id, selectedId);

  // MULTI-SELECT. Keyed to the page's project: a switch reads as empty.
  // Survives search/type/sort changes — those change the visible rows, not the selection.
  const selection = useContextSelection(rows, projectId);
  const listSelection = React.useMemo(
    () => ({
      isSelected: selection.isSelected,
      onToggle: selection.toggle,
      onToggleAll: selection.setAll,
    }),
    [selection.isSelected, selection.toggle, selection.setAll],
  );
  // A bulk delete that took the reader's record with it: deselect, as the single delete does.
  const onBulkDeleted = React.useCallback(
    (ids: string[]) => {
      if (selectedId && ids.includes(selectedId)) deselect();
    },
    [selectedId, deselect],
  );

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Contexts
          </Heading>
          <Text variant="data" tone="faintest">
            {stats.data?.total_contexts != null
              ? `${stats.data.total_contexts.toLocaleString()} in memory`
              : 'AI memory'}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          Your AI&apos;s memory — semantic search, rendered markdown, and the typed thread.
        </Text>
      </header>

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        type={type}
        onTypeChange={setType}
        sort={sort}
        onSortChange={setSort}
        stats={stats.data}
      />

      {selection.count > 0 && (
        <BulkToolbar
          selected={selection.selected}
          projects={project.projects}
          currentProjectId={projectId}
          scope={project.scope}
          onClear={selection.clear}
          onDeleted={onBulkDeleted}
        />
      )}

      <div className={styles.layout}>
        <ContextList
          contexts={rows}
          selectedId={selectedId}
          onSelect={select}
          isLoading={list.isLoading}
          isError={list.isError}
          error={list.error}
          noProject={!project.ready && !project.loading}
          selection={listSelection}
        />
        {!isStacked && <ContextDetail id={selectedId} fallback={fallback} onDeleted={deselect} />}
      </div>

      {isStacked && (
        <Drawer open={Boolean(routeId)} onClose={deselect} title="Context">
          <ContextDetail id={selectedId} fallback={fallback} onDeleted={deselect} />
        </Drawer>
      )}
    </div>
  );
};

export default Contexts;
