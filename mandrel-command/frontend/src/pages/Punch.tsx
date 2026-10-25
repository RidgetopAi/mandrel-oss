/**
 * Punch List — the phone-first board for filing and clearing punches.
 * ZERO antd, all data through the unified `api` client via react-query, on the P0.3
 * primitives + P0.2 tokens; thin composition here, a `punch/` module owning the parts.
 *
 * "A punch is one board item": the operator files it from his phone in under a minute
 * (`/punch/new`), then watches it move draft → ready → claimed → verifying → evidence →
 * merged → deployed on the desktop board, and looks at the evidence (`/punch/:id`).
 *
 * Layout is DECIDED BY WIDTH (PUNCH_CONFIG.desktopMinWidthPx): desktop shows every column
 * and opens the detail in a Drawer over the board; a phone shows one column behind a stage
 * picker and renders the form / detail as full pages. Same routes, same data, one screen.
 */
import React from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Heading, Text, Button, Alert, Drawer } from '../components/ui';
import { usePageProject } from '../hooks/usePageProject';
import { useRecordProjectSync } from '../hooks/useRecordProjectSync';
import { useMediaQuery } from '../components/shell/hooks';
import { PunchBoard } from './punch/PunchBoard';
import { PunchForm } from './punch/PunchForm';
import { PunchDetail } from './punch/PunchDetail';
import { useTaskList, useTask, useResolveTaskSearch } from './punch/hooks';
import { columnFor } from './punch/stage';
import { DESKTOP_MEDIA_QUERY, PUNCH_CONFIG, PUNCH_COPY } from './punch/config';
import { Toolbar } from './tasks/Toolbar';
import { IdJumpResult } from './tasks/IdJumpResult';
import { isServerResolvableId } from './tasks/idSearch';
import { matchesSearch } from './tasks/search';
import styles from './punch/Punch.module.css';

/**
 * What rides in ROUTER STATE between the routes. `/punch`, `/punch/new` and `/punch/:id`
 * are separate <Route> elements, so this component REMOUNTS on every navigate between
 * them and component state does not survive the hop (measured: a `missingFor` useState
 * set right before `navigate()` was gone on the next render). Router state does.
 */
interface PunchRouteState {
  /** The form just filed this punch (landing on the board). */
  filed?: { id: string; outcome: 'ready' | 'draft' };
  /** A drag was rejected PUNCH_INCOMPLETE with these fields (landing on the detail). */
  missing?: string[];
}

const Punch: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: routeId } = useParams<{ id: string }>();
  const creating = location.pathname.endsWith('/punch/new');
  const desktop = useMediaQuery(DESKTOP_MEDIA_QUERY);

  // THE PAGE OWNS ITS PROJECT (page-scope epic) — no `allowAll`: a punch files into ONE project.
  const project = usePageProject();
  const projectId = project.projectId;
  const projectNames = React.useMemo(
    () => Object.fromEntries(project.projects.map((p) => [p.id, p.name])),
    [project.projects],
  );

  const list = useTaskList(projectId, project.scope, { enabled: project.ready });
  const rows = React.useMemo(() => list.data ?? [], [list.data]);

  // Search PARITY with the Tasks board: the Punch board is the ONLY
  // page that renders attachment evidence, so a punch past the 60-card column cap was
  // otherwise unreachable. Both halves are the SAME implementation the Tasks board uses
  // (`tasks/search.ts` + `tasks/idSearch.ts` + `useResolveTaskSearch`), not a second copy:
  //   - `matchesSearch` narrows the fetched, project-scoped rows client-side;
  //   - `useResolveTaskSearch` resolves an id-shaped query against the WHOLE database (the
  //     same resolver `/r/<id8>` uses), so an id outside this project or past the cap still
  //     resolves. `IdJumpResult` renders its DEFAULT jump target (`record.url`) with no
  //     override — the backend resolver alone decides `/punch/<id>` vs
  //     `/tasks/<id>` (`idResolver.ts urlForRecord`'s `isPunchSql` bit), so this board and
  //     every other surface (`/r/` links, tool responses) always agree.
  const [search, setSearch] = React.useState('');
  const idSearchActive = isServerResolvableId(search);
  const idResolve = useResolveTaskSearch(search);
  const filteredRows = React.useMemo(
    () => rows.filter((t) => matchesSearch(t, search)),
    [rows, search],
  );

  // What is actually ON the board — a cancelled task is in the list but has no column.
  // `totalOnBoard` is the whole-project count (unaffected by the search box, like the
  // Tasks page's headline stats); `visibleOnBoard` is what the board is ACTUALLY showing
  // right now. The header reads only `visibleOnBoard` while a search is active, and both
  // numbers together ("N of M") once it is — never a bare total that outgrows the board.
  const totalOnBoard = React.useMemo(() => rows.filter((t) => columnFor(t) !== null).length, [rows]);
  const visibleOnBoard = React.useMemo(
    () => filteredRows.filter((t) => columnFor(t) !== null).length,
    [filteredRows],
  );
  const searching = search.trim().length > 0;

  const selectedId = routeId ?? null;
  const detail = useTask(selectedId);
  // Falls back to the UNFILTERED rows (a superset of filteredRows) — the selected detail
  // must never blink away because it happens not to match the search box.
  const detailTask = detail.data ?? rows.find((t) => t.id === selectedId);
  useRecordProjectSync(project, detailTask?.project_id, selectedId);

  // The just-filed card: highlighted for a moment, with an inline notice (this app's
  // rebuilt screens use inline Alerts, not floating toasts).
  const routeState = (location.state as PunchRouteState | null) ?? undefined;
  const filed = routeState?.filed;
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<PunchRouteState['filed'] | undefined>(undefined);
  React.useEffect(() => {
    if (!filed) return;
    setHighlightedId(filed.id);
    setNotice(filed);
    // Clear the router state so a refresh does not re-announce it.
    navigate(location.pathname + location.search, { replace: true, state: null });
    const t = window.setTimeout(() => setHighlightedId(null), PUNCH_CONFIG.createdHighlightMs);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filed?.id]);

  // A drag rejected as PUNCH_INCOMPLETE opens the card with those fields flagged — the
  // list rides router state (see PunchRouteState) because this component remounts.
  const onIncomplete = React.useCallback(
    (id: string, missing: string[]) => {
      const state: PunchRouteState = { missing };
      navigate(`/punch/${id}${location.search}`, { state });
    },
    [navigate, location.search],
  );
  const missing = selectedId ? routeState?.missing : undefined;

  const select = React.useCallback(
    (id: string) => navigate(`/punch/${id}${location.search}`),
    [navigate, location.search],
  );
  const toBoard = React.useCallback(
    (state?: PunchRouteState) => navigate(`/punch${location.search}`, { state }),
    [navigate, location.search],
  );
  const closeDetail = React.useCallback(() => toBoard(), [toBoard]);

  const header = (
    <header className={styles.head}>
      <div className={styles.headRow}>
        <Heading level={2} variant="display">
          {PUNCH_COPY.title}
        </Heading>
        <Text variant="data" tone="faintest">
          {searching
            ? `${visibleOnBoard.toLocaleString()} of ${totalOnBoard.toLocaleString()} on the board · ${project.projectName ?? 'project'}`
            : `${totalOnBoard.toLocaleString()} on the board · ${project.projectName ?? 'project'}`}
        </Text>
      </div>
      <Text variant="body" tone="faint">
        {PUNCH_COPY.tagline}
      </Text>
    </header>
  );

  if (creating) {
    return (
      <div className={styles.page}>
        {header}
        <PunchForm
          pageProjectId={projectId}
          onFiled={(id, outcome) => toBoard({ filed: { id, outcome } })}
          onCancel={() => toBoard()}
        />
      </div>
    );
  }

  const detailPanel = (
    <PunchDetail
      task={detailTask}
      taskLoading={Boolean(selectedId) && detail.isLoading && !detailTask}
      projectName={detailTask ? projectNames[detailTask.project_id] : undefined}
      missing={missing}
      onClose={closeDetail}
    />
  );

  // Phone: the detail IS the page.
  if (!desktop && selectedId) {
    return <div className={styles.page}>{detailPanel}</div>;
  }

  return (
    <div className={styles.page}>
      {header}

      <Toolbar
        search={search}
        onSearchChange={setSearch}
        placeholder="Search punches…"
        ariaLabel="Search punches"
      />

      <IdJumpResult active={idSearchActive} loading={idResolve.isLoading} result={idResolve.data} />

      <div className={styles.toolbar}>
        <Button
          className={styles.fileBtn}
          variant="primary"
          onClick={() => navigate(`/punch/new${location.search}`)}
          disabled={!project.ready}
        >
          {PUNCH_COPY.fileButton}
        </Button>
      </div>

      {notice && (
        <Alert
          variant={notice.outcome === 'ready' ? 'success' : 'warning'}
          title={PUNCH_COPY.filedTitle}
          className={styles.filed}
          onClose={() => setNotice(undefined)}
        >
          {notice.outcome === 'ready' ? 'It is on the board as Ready.' : PUNCH_COPY.filedDraft}
        </Alert>
      )}

      <PunchBoard
        projectId={projectId}
        scope={project.scope}
        enabled={project.ready}
        search={search}
        selectedId={selectedId}
        highlightedId={highlightedId}
        projectNames={projectNames}
        desktop={desktop}
        onSelect={select}
        onIncomplete={onIncomplete}
        totalOnBoard={totalOnBoard}
        totalOnBoardLoading={list.isLoading}
        totalOnBoardError={list.isError}
        totalOnBoardErrorObj={list.error}
      />

      <Drawer
        open={Boolean(selectedId)}
        onClose={closeDetail}
        side="right"
        title="Punch"
        className={styles.drawerPanel}
      >
        {detailPanel}
      </Drawer>
    </div>
  );
};

export default Punch;
