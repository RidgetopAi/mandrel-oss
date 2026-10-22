/**
 * Projects — the Command "portfolio" screen, rebuilt to the LOCKED mock
 * (docs/command-projects-mock.html) on the P0 foundation: P0.3 primitives + P0.2 tokens,
 * ZERO antd, all data through the unified `api` client via react-query
 * (src/pages/projects/hooks.ts). Mirrors the Contexts/Tasks/Decisions rebuilds: thin
 * composition here, a `projects/` module owning the parts, config, data, and a
 * token-driven stylesheet — each section owning its loading/empty/error state.
 *
 * A single grid of project cards, each showing that project's vital signs (contexts /
 * tasks / decisions) + status + the honest active-work footer. A toolbar filters
 * (All/Active/Dormant with live counts), searches (client-side over name + description),
 * and sorts. Clicking a card opens its ProjectDetail route (/projects/:id).
 *
 * DATA GAPS (policy 10397f65 — never fabricate): the mock's per-project 30-day sparkline
 * and literal "active branches" telemetry are NOT served. The sparkline is omitted; the
 * footer shows the REAL in-progress-task count as the active-work signal (see
 * projects/config.ts ACTIVE_WORK_GAP_NOTE). Task + decision counts come from
 * `api.projects.insights(id)`; context count + last activity from the list row.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Heading, Text, Button } from '../components/ui';
import { Toolbar } from './projects/Toolbar';
import { ProjectGrid } from './projects/ProjectGrid';
import { CreateProjectDrawer } from './projects/CreateProjectDrawer';
import { PlusIcon } from './projects/icons';
import { useProjectList } from './projects/hooks';
import { isProjectActive, type SegmentValue, type SortValue } from './projects/config';
import type { ProjectEntity } from '../api/generated';
import styles from './projects/Projects.module.css';

const Projects: React.FC = () => {
  const navigate = useNavigate();
  const list = useProjectList();

  const [segment, setSegment] = React.useState<SegmentValue>('all');
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<SortValue>('last_active');
  const [createOpen, setCreateOpen] = React.useState(false);

  // One clock, re-taken each time the list data refreshes, so every active/dormant
  // decision in a render pass is consistent (and re-evaluates on refetch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = React.useMemo(() => Date.now(), [list.data]);
  const all = React.useMemo<ProjectEntity[]>(() => list.data ?? [], [list.data]);

  const activeCount = React.useMemo(
    () => all.filter((p) => isProjectActive(p, now)).length,
    [all, now],
  );

  const counts = React.useMemo(
    () => ({
      all: all.length,
      active: activeCount,
      dormant: all.length - activeCount,
    }),
    [all.length, activeCount],
  );

  const rows = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = all.filter((p) => {
      const active = isProjectActive(p, now);
      if (segment === 'active' && !active) return false;
      if (segment === 'dormant' && active) return false;
      if (q) {
        const hay = `${p.name} ${p.description ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'contexts') return (b.context_count ?? 0) - (a.context_count ?? 0);
      // last_active: most recent first; missing timestamps sink to the bottom.
      const ta = a.last_activity ? Date.parse(a.last_activity) : 0;
      const tb = b.last_activity ? Date.parse(b.last_activity) : 0;
      return tb - ta;
    });
    return sorted;
  }, [all, segment, search, sort, now]);

  const open = React.useCallback((id: string) => navigate(`/projects/${id}`), [navigate]);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Projects
          </Heading>
          <Text variant="data" tone="faintest">
            {`${counts.all} · ${counts.active} active`}
          </Text>
          <span className={styles.headSpring} />
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon size={15} />
            New project
          </Button>
        </div>
        <Text variant="body" tone="faint">
          Each project is a container of work — its contexts, tasks, and decisions. Click a
          card to open it.
        </Text>
      </header>

      <Toolbar
        segment={segment}
        onSegmentChange={setSegment}
        counts={counts}
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
      />

      <ProjectGrid
        projects={rows}
        now={now}
        onOpen={open}
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        emptyHint={
          all.length > 0
            ? 'No projects match the current filters.'
            : 'No projects yet — create your first to start organizing work.'
        }
      />

      <CreateProjectDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={open}
      />
    </div>
  );
};

export default Projects;
