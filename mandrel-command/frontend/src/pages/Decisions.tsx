/**
 * Decisions — the Command "why ledger" screen, rebuilt to the LOCKED mock
 * (docs/command-decisions-mock.html) on the P0 foundation: P0.3 primitives + P0.2 tokens,
 * ZERO antd, all data through the unified `api` client via react-query
 * (src/pages/decisions/hooks.ts). Mirrors the Contexts wide-reader rebuild: thin
 * composition here, a `decisions/` module owning the parts, config, data, and a
 * token-driven stylesheet — each section owning its loading/empty/error state.
 *
 * A two-column screen: a filter bar (search + type facets with live counts + outcome
 * select) over a scrollable list (left), and a reader (right) — the decision's rationale,
 * alternatives, success criteria, outcome/learning-loop, and the typed-edge thread box (the
 * TreeWalker moat, built from REAL `links` edges). The reader doubles as the
 * `/decisions/:id` deep-link target (the /r/:id resolve flow lands here), so selecting an
 * item navigates and a direct link pre-selects it.
 *
 * FILTERING NOTE: the MCP `decision_search` engine rejects a `decision_type` param (strict
 * mode, verified), so the type + outcome facets filter CLIENT-SIDE over the loaded window;
 * `query`/`status` are server-side. Facet COUNTS are the real full-corpus stats (never
 * fabricated). See decisions/config.ts (listLimit) for the window size.
 */
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Heading, Text, Drawer } from '../components/ui';
import { FilterBar } from './decisions/FilterBar';
import { DecisionList } from './decisions/DecisionList';
import { DecisionReader } from './decisions/DecisionReader';
import { DecisionEditDrawer } from './decisions/DecisionEditDrawer';
import {
  useDecisionList,
  useDecisionStats,
  useDecision,
  useDecisionLinks,
} from './decisions/hooks';
import { usePageProject } from '../hooks/usePageProject';
import { useRecordProjectSync } from '../hooks/useRecordProjectSync';
import { useIsStackedRecordLayout } from '../hooks/useIsStackedRecordLayout';
import type { OutcomeFilterValue } from './decisions/config';
import type { Decision } from '../types/decision';
import styles from './decisions/Decisions.module.css';

const Decisions: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();

  // THE PAGE OWNS ITS PROJECT. There is no global selector any more; the
  // selection lives in `?project=`, opens at the user's default, and every read below
  // carries `project.scope()` so the request names THIS page's project rather than the
  // ambient default. No `allowAll`: this screen's write surface (the outcome drawer) has
  // to name a real project, and an "All projects" ledger cannot.
  const project = usePageProject();
  const projectId = project.projectId;

  // MOBILE OVERLAY (an earlier decision — the operator, filed from his phone). Same
  // fix as Contexts: below the rail+reader breakpoint the reader renders in a `Drawer`
  // (fixed, portal-rendered, anchored at the top of the viewport) instead of the second grid
  // column, so selecting a decision no longer means scrolling past the whole list to read
  // it. Above the breakpoint nothing here changes.
  const isStacked = useIsStackedRecordLayout();

  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<OutcomeFilterValue>('all');
  const [editing, setEditing] = React.useState<Decision | null>(null);

  // `status` is the only server-side facet the MCP engine accepts; type/outcome filter
  // client-side below.
  const list = useDecisionList({
    query: search,
    status: null,
    projectId,
    scope: project.scope,
    enabled: project.ready,
  });
  const stats = useDecisionStats(projectId, project.scope, project.ready);

  const rows = React.useMemo(() => {
    const all = list.data?.decisions ?? [];
    return all.filter((d) => {
      if (type && d.decision_type !== type) return false;
      if (outcome !== 'all' && (d.outcomeStatus ?? 'unknown') !== outcome) return false;
      return true;
    });
  }, [list.data, type, outcome]);

  // The selected decision: the route id if present, else — ON DESKTOP ONLY — the first
  // filtered row, so the always-visible second column is never empty. Selecting an item
  // navigates to /decisions/:id so the reader + deep-link stay one screen.
  //
  // CLOSING THE OVERLAY (an earlier decision — second critic finding, T3):
  // same choice as Contexts.tsx, same reason — see the comment there. Summary: dropping
  // `?project=` on close is harmless because a differing deep-link value is already
  // ADOPTED into the persisted topbar selection (`projectSelectionStore`) before the user
  // can close anything, so the scope survives in the store independent of the query
  // string; and mobile deliberately does NOT keep a row highlighted after close (unlike
  // desktop, where the reader is always visible) because nothing is being read once the
  // Drawer is shut — a highlighted row with nothing open would lie about what's selected.
  const selectedId = routeId ?? (isStacked ? null : rows[0]?.id) ?? null;
  const select = React.useCallback((id: string) => navigate(`/decisions/${id}`), [navigate]);
  const deselect = React.useCallback(() => navigate('/decisions'), [navigate]);

  const reader = useDecision(selectedId);
  const links = useDecisionLinks(selectedId);

  // Prefer the freshly-fetched full record; fall back to the list row (already loaded) so
  // the reader paints immediately on selection while the detail query settles.
  const readerDecision =
    reader.data ?? (list.data?.decisions ?? []).find((r) => r.id === selectedId);

  // A `/r/<id8>` short link can land on a decision OUTSIDE the selected project. The reader
  // renders it either way (a by-id read is authorized against the RECORD's project, not the
  // request header), but the ledger beside it would be showing a different project — and the
  // global switcher that used to reconcile that is gone. Follow the record: re-point
  // `?project=` at its project so the list, the counts and the reader agree again.
  useRecordProjectSync(project, readerDecision?.project_id, selectedId);

  const readerNode = (
    <DecisionReader
      decision={readerDecision}
      isLoading={Boolean(selectedId) && reader.isLoading && !readerDecision}
      isError={reader.isError && !readerDecision}
      error={reader.error}
      links={links.data}
      linksLoading={links.isLoading}
      linksError={links.isError}
      linksErrorObj={links.error}
      onEdit={setEditing}
    />
  );

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Decisions
          </Heading>
          <Text variant="data" tone="faintest">
            {stats.data?.total_decisions != null
              ? `${stats.data.total_decisions.toLocaleString()} in the ledger`
              : 'the why ledger'}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          The why — rationale, alternatives, success criteria, outcome, and what it caused.
        </Text>
      </header>

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        type={type}
        onTypeChange={setType}
        outcome={outcome}
        onOutcomeChange={setOutcome}
        stats={stats.data}
      />

      <div className={styles.layout}>
        <DecisionList
          decisions={rows}
          selectedId={selectedId}
          onSelect={select}
          isLoading={list.isLoading}
          isError={list.isError}
          error={list.error}
          noProject={!project.ready && !project.loading}
        />
        {!isStacked && readerNode}
      </div>

      {isStacked && (
        <Drawer open={Boolean(routeId)} onClose={deselect} title="Decision">
          {readerNode}
        </Drawer>
      )}

      <DecisionEditDrawer
        decision={editing}
        open={editing != null}
        onClose={() => setEditing(null)}
        pageProjectId={projectId}
      />
    </div>
  );
};

export default Decisions;
