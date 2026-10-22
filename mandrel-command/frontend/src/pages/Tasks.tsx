/**
 * Tasks — the Command "live thread" screen, rebuilt to the LOCKED mock
 * (docs/command-tasks-mock.html) on the P0 foundation: P0.3 primitives + P0.2 tokens,
 * ZERO antd, all data through the unified `api` client via react-query
 * (src/pages/tasks/hooks.ts). Mirrors the Contexts screen-rebuild pattern: thin
 * composition here, a `tasks/` module owning the parts, config, data, and a token-driven
 * stylesheet — each section owning its loading/empty/error state.
 *
 * "A task is a live thread — who's building it, what it came from, what it produced." A
 * progress ops bar + "building now" panel (REAL stats + in-progress tasks) over a
 * Board / List / Analytics toggle, with a task-thread detail (the TYPED-edge build story,
 * the TreeWalker moat) for the selected task. The screen doubles as the `/tasks/:id`
 * deep-link target (the /r/:id resolve flow lands here) — the route id pre-selects a task.
 */
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Heading, Text, Button } from '../components/ui';
import { usePageProject } from '../hooks/usePageProject';
import { useRecordProjectSync } from '../hooks/useRecordProjectSync';
import { Toolbar } from './tasks/Toolbar';
import { OpsBar } from './tasks/OpsBar';
import { ViewToggle } from './tasks/ViewToggle';
import { StatusFilter } from './tasks/StatusFilter';
import { RangeSelector } from './tasks/RangeSelector';
import { Board } from './tasks/Board';
import { TaskListView } from './tasks/TaskListView';
import { TaskDrawer, type TaskDrawerMode } from './tasks/TaskDrawer';
import { Analytics } from './tasks/Analytics';
import { IdJumpResult } from './tasks/IdJumpResult';
import { isServerResolvableId } from './tasks/idSearch';
import { matchesSearch } from './tasks/search';
import {
  useTaskList,
  useTaskStats,
  useTask,
  useTaskLinks,
  useTaskLeadTime,
  useTaskThroughput,
  useTaskCompletedByActor,
  useResolveTaskSearch,
} from './tasks/hooks';
import {
  ARCHIVED_FILTER_VALUE,
  DEFAULT_RANGE,
  type ViewValue,
  type RangeValue,
  type ListStatusFilterValue,
} from './tasks/config';
import type { Task } from '../types/task';
import styles from './tasks/Tasks.module.css';

/**
 * Does this task match the search box? The predicate itself lives in `tasks/search.ts`
 * — word-prefix over separately-matched fields, which is the same rule the
 * Sessions page uses. It is re-exported here because that is the import path the page's
 * own test and every existing caller already reach for.
 */
export { matchesSearch };

const Tasks: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();

  // THE PAGE OWNS ITS PROJECT (epic 41293984). The global header
  // selector this page used to follow is GONE — every scoped page carries its own, backed
  // by `?project=` and opening at the user's default. Every read below additionally
  // carries `project.scope()`, which pins X-Project-ID to this page's project per request
  // instead of inheriting the ambient default.
  //
  // No `allowAll`: the create surface on this page has to file into a real project, and
  // the ops bar / analytics headline numbers are about one project by construction.
  const project = usePageProject();
  const projectId = project.projectId;

  const [view, setView] = React.useState<ViewValue>('board');
  const [range, setRange] = React.useState<RangeValue>(DEFAULT_RANGE);
  const [search, setSearch] = React.useState('');
  // SERVER-SIDE search-by-id: when the query is id-shaped, resolve it
  // across the WHOLE database (same resolver as `/r/<id8>`) so a task outside the current
  // project scope or past the page cap is still reachable — the client-side `matchesSearch`
  // filter below only ever sees the already-fetched page. Fires only for an id-shaped query.
  const idSearchActive = isServerResolvableId(search);
  const idResolve = useResolveTaskSearch(search);
  // The List-view status filter. 'all' = no filter (the shared list); any
  // real status runs a dedicated SERVER-SIDE filtered read (below). List view only.
  const [statusFilter, setStatusFilter] = React.useState<ListStatusFilterValue>('all');
  // "+ New Task" opens the drawer in CREATE mode; selecting a task (the /tasks/:id route)
  // opens it in READ-ONLY VIEW mode, and `editing` is the in-place switch to the form.
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState(false);

  const analyticsActive = view === 'analytics';
  // The SHARED, whole-project list — feeds the Board, the OpsBar "Building now", and
  // Analytics. It must stay unfiltered regardless of the status chip, so the status filter
  // NEVER repoints this query.
  const list = useTaskList(projectId, project.scope, { enabled: project.ready });
  const stats = useTaskStats(projectId, project.scope, project.ready);
  // A SEPARATE server-side status-filtered read, ONLY for the List view when a specific
  // status is selected. A status set like Done can exceed the 2000-row list cap, so filtering
  // must happen server-side (not client-side over the capped shared list). Gated so it fires
  // only on the List view with a real status selected.
  // The ARCHIVED chip is not a status — it selects the soft-deleted slice,
  // which the default list now hides entirely. It reuses the same dedicated read, passing
  // the archive scope INSTEAD of a status.
  const archivedActive = statusFilter === ARCHIVED_FILTER_VALUE;
  const statusActive = statusFilter !== 'all';
  const filtered = useTaskList(projectId, project.scope, {
    status: statusActive && !archivedActive ? (statusFilter as Task['status']) : undefined,
    archived: archivedActive,
    enabled: project.ready && view === 'list' && statusActive,
  });
  // The time-based analytics reads — only fetched when the Analytics view is active, and
  // all RANGE-AWARE (the 7d/30d/90d/All selector drives their server-side window).
  const leadTime = useTaskLeadTime(projectId, project.scope, range, project.ready && analyticsActive);
  const throughput = useTaskThroughput(projectId, project.scope, range, project.ready && analyticsActive);
  const completedByActor = useTaskCompletedByActor(
    projectId,
    project.scope,
    range,
    project.ready && analyticsActive,
  );

  const allRows = React.useMemo(() => list.data ?? [], [list.data]);
  const rows = React.useMemo(
    () => allRows.filter((t) => matchesSearch(t, search)),
    [allRows, search],
  );

  // The List-view rows: 'all' → the shared rows (whole project + search); a specific status →
  // the SERVER-SIDE filtered set, with the same client-side search applied ON TOP. Only the
  // List view consumes this — the Board keeps rendering the shared `rows`.
  const listRows = React.useMemo(() => {
    if (!statusActive) return rows;
    return (filtered.data ?? []).filter((t) => matchesSearch(t, search));
  }, [statusActive, filtered.data, rows, search]);
  // The List view surfaces the ACTIVE query's loading/error — the filtered read when a status
  // is selected, else the shared list's.
  const listSource = statusActive ? filtered : list;

  // The selected task: the route id if present, else the first in-progress task, else the
  // first row. Selecting a card navigates to /tasks/:id so the detail + deep-link are one
  // screen.
  const firstInProgress = React.useMemo(
    () => rows.find((t) => t.status === 'in_progress'),
    [rows],
  );
  const selectedId = routeId ?? firstInProgress?.id ?? rows[0]?.id ?? null;
  const select = React.useCallback((id: string) => navigate(`/tasks/${id}`), [navigate]);

  const detail = useTask(selectedId);
  const links = useTaskLinks(selectedId);

  // Prefer the freshly-fetched full record; fall back to the loaded list row so the detail
  // paints immediately on selection while the by-id query settles.
  const detailTask = detail.data ?? rows.find((t) => t.id === selectedId);

  // A `/r/<id8>` short link (or a pasted /tasks/:id) can open a task OUTSIDE the selected
  // project. The drawer renders it either way — a by-id read is authorized against the
  // RECORD's project, not the request header — but the board behind it would be a
  // different project's, and the global switcher that used to reconcile that is gone.
  // Follow the record: re-point `?project=` at the task's own project.
  useRecordProjectSync(project, detailTask?.project_id, selectedId);

  // Drawer: create mode ("+ New Task") takes precedence; otherwise the /tasks/:id route
  // (an explicit selection OR a deep-link landing) opens the drawer in READ-ONLY VIEW mode
  // for that task, and the drawer's Edit button switches it to the form.
  // Closing clears the route; closing create just drops create mode.
  const detailOpen = Boolean(routeId);
  const drawerOpen = creating || detailOpen;
  const drawerMode: TaskDrawerMode = creating ? 'create' : editing ? 'edit' : 'view';

  // Landing on a DIFFERENT task must reset to view — the edit switch belongs to the task
  // that was on screen when the user pressed it, never to the next one. This is what makes
  // every entry point (card, row, ops-bar, deep link) land read-only without any of them
  // having to say so: they all move the route, and the route drives this.
  React.useEffect(() => {
    setEditing(false);
  }, [routeId]);

  const closeDrawer = React.useCallback(() => {
    if (creating) setCreating(false);
    else navigate('/tasks');
    setEditing(false);
  }, [creating, navigate]);
  const handleCreated = React.useCallback(
    (id: string) => {
      setCreating(false);
      navigate(`/tasks/${id}`);
    },
    [navigate],
  );
  const handleDeleted = React.useCallback(() => {
    setCreating(false);
    navigate('/tasks');
  }, [navigate]);

  const buildingTasks = React.useMemo(
    () => allRows.filter((t) => t.status === 'in_progress'),
    [allRows],
  );

  const total = stats.data?.total ?? 0;
  const byStatus = stats.data?.by_status ?? {};
  const openCount = (byStatus.todo ?? 0) + (byStatus.in_progress ?? 0) + (byStatus.blocked ?? 0);
  // The headline names the project the page is scoped to — the selector's own selection.
  const projectLabel = project.projectName ?? 'project';

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Tasks
          </Heading>
          <Text variant="data" tone="faintest">
            {`${openCount.toLocaleString()} open · ${total.toLocaleString()} total · ${projectLabel}`}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          A task is a live thread — who&apos;s building it, what it came from, what it produced.
        </Text>
      </header>

      <Toolbar
        search={search}
        onSearchChange={setSearch}
      />

      <IdJumpResult
        active={idSearchActive}
        loading={idResolve.isLoading}
        result={idResolve.data}
      />

      <OpsBar
        stats={stats.data}
        statsLoading={stats.isLoading}
        buildingTasks={buildingTasks}
        onSelect={select}
      />

      <div className={styles.viewrow}>
        <ViewToggle view={view} onChange={setView} />
        {view === 'list' && (
          <StatusFilter value={statusFilter} onChange={setStatusFilter} stats={stats.data} />
        )}
        {view === 'analytics' && <RangeSelector range={range} onChange={setRange} />}
        <Button
          className={styles.newTaskBtn}
          variant="primary"
          onClick={() => setCreating(true)}
        >
          + New Task
        </Button>
      </div>

      {view === 'analytics' ? (
        <Analytics
          rows={allRows}
          rowsLoading={list.isLoading}
          stats={stats.data}
          statsLoading={stats.isLoading}
          statsError={stats.isError}
          statsErrorObj={stats.error}
          leadTime={leadTime.data}
          leadTimeLoading={leadTime.isLoading}
          throughputSeries={throughput.data}
          throughputLoading={throughput.isLoading}
          actors={completedByActor.data}
          actorsLoading={completedByActor.isLoading}
          range={range}
          onSelect={select}
        />
      ) : view === 'list' ? (
        <TaskListView
          tasks={listRows}
          selectedId={selectedId}
          onSelect={select}
          isLoading={listSource.isLoading}
          isError={listSource.isError}
          error={listSource.error}
        />
      ) : (
        <Board
          projectId={projectId}
          scope={project.scope}
          enabled={project.ready}
          search={search}
          totalTasks={stats.data?.total}
          totalTasksLoading={stats.isLoading}
          totalTasksError={stats.isError}
          totalTasksErrorObj={stats.error}
          selectedId={selectedId}
          onSelect={select}
          selectedLinkCount={links.data?.length}
        />
      )}

      <TaskDrawer
        open={drawerOpen}
        mode={drawerMode}
        task={creating ? undefined : detailTask}
        taskLoading={Boolean(selectedId) && detail.isLoading && !detailTask}
        onEdit={() => setEditing(true)}
        links={links.data}
        linksLoading={links.isLoading}
        linksError={links.isError}
        linksErrorObj={links.error}
        onClose={closeDrawer}
        onCreated={handleCreated}
        onDeleted={handleDeleted}
        pageProjectId={projectId}
      />
    </div>
  );
};

export default Tasks;
