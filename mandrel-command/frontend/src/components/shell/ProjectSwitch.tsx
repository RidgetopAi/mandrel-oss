/**
 * ProjectSwitch — THE project switch, in the topbar.
 *
 * It replaces the read-only DefaultProjectLabel that stood here after an earlier epic §B,
 * and the per-page selectors that epic put on every screen. The operator's rule: "All pages are
 * controlled by single project switch from top menu bar." So this is the ONE control
 * that moves the ambient scope; every project-scoped page reads it via `usePageProject`.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────────────
 * `setSelectedProjectId` on ProjectContext → `stores/projectSelectionStore`
 * (localStorage, owned by this username). The selection holds across tabs and reloads;
 * logout / a fresh login reset it to the Settings default. It also DROPS any `?project=` deep-link override from the
 * current URL, so the URL cannot keep saying one project while the switch says another.
 *
 * ── WHAT IT SHOWS ────────────────────────────────────────────────────────────────────
 *   • the selected project's name — the shared `ProjectSelect` primitive, ONE project
 *     at a time. No "All projects" entry (an earlier walkthrough F2): the punch did not ask
 *     for it, and a page that cannot render "all" would show the default while the
 *     topbar said otherwise — the disagreement this punch exists to end;
 *   • a small "default" marker ONLY while the selection equals the Settings default —
 *     the "DEFAULT" caption that used to be static now means something.
 * Loading, unreadable-list and no-projects states are the primitive's own (a disabled
 * control with a distinct placeholder for each — C1's third state is never a blank).
 */
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { ProjectSelect } from '../ui/ProjectSelect';
import { useProjectContext } from '../../contexts/ProjectContext';
import { useSettings } from '../../hooks/useSettings';
import { PROJECT_URL_PARAM } from '../../hooks/usePageProject';
import styles from './Topbar.module.css';

export const ProjectSwitch: React.FC = () => {
  const {
    allProjects,
    loading,
    projectsUnavailable,
    currentProject,
    setSelectedProjectId,
  } = useProjectContext();
  const { defaultProjectId } = useSettings();
  const [searchParams, setSearchParams] = useSearchParams();

  const projects = React.useMemo(
    () => allProjects.map((p) => ({ id: p.id, name: p.name })),
    [allProjects],
  );

  // What the switch displays: the RESOLVED ambient project — the pick when it resolves,
  // the default otherwise — so a stale pick never shows a name the pages are not rendering.
  const value = currentProject?.id;

  const isDefault = !!defaultProjectId && value === defaultProjectId;

  const onChange = React.useCallback(
    (next: string) => {
      setSelectedProjectId(next);
      if (searchParams.has(PROJECT_URL_PARAM)) {
        setSearchParams(
          (prev) => {
            const params = new URLSearchParams(prev);
            params.delete(PROJECT_URL_PARAM);
            return params;
          },
          { replace: true },
        );
      }
    },
    [setSelectedProjectId, searchParams, setSearchParams],
  );

  return (
    <div className={styles.projectSwitch} data-testid="project-switch" data-default={isDefault || undefined}>
      <ProjectSelect
        projects={projects}
        value={value}
        onChange={onChange}
        loading={loading}
        unavailable={projectsUnavailable}
        aria-label="Project"
        className={styles.projectSwitchSelect}
      />
      {isDefault && (
        <span
          className={styles.projectSwitchDefault}
          title="This is your default project (change it in Settings)"
          data-testid="project-switch-default-marker"
        >
          default
        </span>
      )}
    </div>
  );
};

export default ProjectSwitch;
