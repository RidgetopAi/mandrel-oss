/**
 * ProjectSelect — THE project selector. One primitive, used by every project-scoped
 * page (page-scope epic §D).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  HOW TO USE THIS (read this block; it is the whole API)
 * ════════════════════════════════════════════════════════════════════════════════════
 * Pair it with `usePageProject()`, which owns the state and hands you exactly the props
 * this component takes. A page needs three lines:
 *
 *     const project = usePageProject();                    // or ({ allowAll: true })
 *     …
 *     <ProjectSelect {...project.selectProps} />           // in the page's toolbar
 *     …
 *     api.contexts.search({ project_id: project.projectId }, project.scope())
 *
 * `project.projectId` is what you send to the backend. Send it as a query param on
 * every request the page makes — do NOT rely on the ambient `X-Project-ID` header. The
 * backend's projectScopeResolver gives the query precedence over the header, so an
 * explicit selection always wins and the header stays a safe fallback for anything you
 * forgot. A page that sends nothing is scoped by the ambient header, which is the
 * confusing behaviour this whole change set exists to remove.
 *
 * With `allowAll`, `projectId` can be the string `'all'` (`ALL_PROJECTS_VALUE`). That is
 * a value you pass THROUGH to the backend, which treats it as "every project" — it is
 * NOT a local sentinel that means "send nothing", and it must never be written to
 * localStorage or sent as X-Project-ID. Only offer it on pages whose endpoint actually
 * accepts it; a UUID-validated route will 400 on it.
 *
 * ── DESIGN NOTES ─────────────────────────────────────────────────────────────────────
 * Built on the P0.3 `Select` primitive: token-driven, no antd, keyboard + a11y for free.
 * It becomes searchable automatically once the list is long enough to need it
 * (`SEARCHABLE_THRESHOLD`), so no page has to remember to ask.
 *
 * It renders its own disabled empty state rather than an empty dropdown: an enabled
 * control with nothing in it is the single most confusing thing a selector can do, and
 * "no projects yet", "projects still loading" and "the list could not be read"
 * (`unavailable`) are DIFFERENT things a user should be told apart (C1 — the third state
 * deserves its own branch, not a shared blank).
 */
import React from 'react';
import { Select } from './Select';
import type { SelectOption } from './Select';

/**
 * The value meaning "every project", when a page opts into it. Sent to the backend as
 * the project param verbatim; the controllers that support it read a missing/`'all'`
 * project as unscoped. Never persisted, never used as X-Project-ID.
 */
export const ALL_PROJECTS_VALUE = 'all';
export const ALL_PROJECTS_LABEL = 'All projects';

/**
 * The value meaning "do not pin a project; let the server decide", when a form opts into
 * it. Not a project id and never sent as one — a caller reads it as "omit the project".
 */
export const UNASSIGNED_PROJECT_VALUE = 'none';
export const UNASSIGNED_PROJECT_LABEL = 'Auto-detect / unassigned';

/** Above this many options the dropdown turns into a filterable combobox. */
export const SEARCHABLE_THRESHOLD = 8;

export interface ProjectSelectItem {
  id: string;
  name: string;
}

export interface ProjectSelectProps {
  /** Selectable projects, already ordered by the caller (usePageProject sorts them). */
  projects: ProjectSelectItem[];
  /** The selected project id, or `ALL_PROJECTS_VALUE`. `undefined` = nothing selected. */
  value: string | undefined;
  onChange: (projectId: string) => void;
  /** Offer the "All projects" entry. Only for pages whose endpoints accept it. */
  allowAll?: boolean;
  /** Offer the "Auto-detect / unassigned" entry. Only for forms that accept no project. */
  allowUnassigned?: boolean;
  /** True while `projects` is still being fetched — rendered as a distinct state. */
  loading?: boolean;
  /**
   * The project list could not be READ. Distinct from an empty list, and it suppresses
   * the sentinel entries as well as the projects: with `allowAll`, an outage otherwise
   * leaves a live control whose only selectable value is "All projects", and choosing it
   * writes `?project=all` into the URL, where it outlives the outage.
   */
  unavailable?: boolean;
  disabled?: boolean;
  /** Accessible name. Default is fine unless a page has two of these. */
  'aria-label'?: string;
  className?: string;
  id?: string;
}

export const ProjectSelect: React.FC<ProjectSelectProps> = ({
  projects,
  value,
  onChange,
  allowAll = false,
  allowUnassigned = false,
  loading = false,
  unavailable = false,
  disabled = false,
  'aria-label': ariaLabel = 'Project',
  className,
  id,
}) => {
  const options = React.useMemo<SelectOption[]>(() => {
    if (unavailable) {
      return [];
    }
    const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }));
    const head: SelectOption[] = [];
    if (allowAll) {
      head.push({ value: ALL_PROJECTS_VALUE, label: ALL_PROJECTS_LABEL });
    }
    if (allowUnassigned) {
      head.push({ value: UNASSIGNED_PROJECT_VALUE, label: UNASSIGNED_PROJECT_LABEL });
    }
    return [...head, ...projectOptions];
  }, [projects, allowAll, allowUnassigned, unavailable]);

  // Loading, could-not-read, and empty are told apart on purpose — see the header.
  const placeholder = loading
    ? 'Loading projects…'
    : unavailable
      ? 'Projects unavailable'
      : options.length === 0
        ? 'No projects available'
        : 'Select a project';

  return (
    <Select
      id={id}
      className={className}
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      // An empty or still-loading list is not a usable control.
      disabled={disabled || loading || options.length === 0}
      searchable={options.length > SEARCHABLE_THRESHOLD}
      searchPlaceholder="Search projects…"
      aria-label={ariaLabel}
    />
  );
};

export default ProjectSelect;
