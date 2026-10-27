/**
 * ProjectSelect — THE shared selector's contract (an earlier epic §B/§D).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS (Reviewer nit 1, promoted to a blocker in reject round 1)
 * ════════════════════════════════════════════════════════════════════════════════════
 * The foundation commit DELETED `ProjectSwitcherControl.test.tsx` (115 lines) and shipped
 * its replacement — this component — with ZERO tests. Three page streams are building on
 * top of it right now, so its contract is not an implementation detail: it is an
 * interface four workstreams have to agree on, and an untested interface is one that gets
 * discovered to differ at merge.
 *
 * ── WHAT IS ACTUALLY LOAD-BEARING HERE, AND WHY EACH ONE IS ──────────────────────────
 *  • OPTION ORDER — the caller sorts (usePageProject hands them through in the
 *    centrally-sorted order) and "All projects", when offered, is PINNED FIRST.
 *    `analytics/FilterRow.test.tsx:62-71` asserts exactly this shape today; the timeviews
 *    stream must preserve it, so it is pinned here on the primitive rather than only on
 *    one page that happens to use it.
 *  • SEARCHABLE ABOVE THE THRESHOLD — the same FilterRow test asserts a `role="combobox"`
 *    with the shared "Search projects…" placeholder. It is automatic (no page opts in),
 *    which means no page can be blamed for forgetting it — and equally means nothing
 *    would notice if it silently stopped happening.
 *  • THE THREE NON-STATES — §B says "never a blank or a crash". Loading, empty and
 *    populated must be told apart, and the first two must be DISABLED: an enabled
 *    dropdown with nothing in it is the most confusing thing a selector can do.
 *    Empty/zero/absent are the C3 members that slip through a truthiness check, so they
 *    are the ones enumerated hardest below.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ProjectSelect,
  ALL_PROJECTS_VALUE,
  ALL_PROJECTS_LABEL,
  UNASSIGNED_PROJECT_VALUE,
  UNASSIGNED_PROJECT_LABEL,
  SEARCHABLE_THRESHOLD,
  type ProjectSelectProps,
} from './ProjectSelect';

/** Deliberately NOT alphabetical: the component must not re-sort what it is given. */
const PROJECTS = [
  { id: 'id-newest', name: 'Newest' },
  { id: 'id-middle', name: 'Middle' },
  { id: 'id-older', name: 'Older' },
];

let container: HTMLDivElement;
let root: Root;

function mount(props: Partial<ProjectSelectProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <ProjectSelect
        projects={PROJECTS}
        value={undefined}
        onChange={vi.fn()}
        {...props}
      />,
    );
  });
}

const trigger = (): HTMLElement =>
  container.querySelector('[aria-label="Project"]') as HTMLElement;

function open() {
  const t = trigger();
  expect(t, 'the select trigger should exist').toBeTruthy();
  act(() => t.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

const optionLabels = (): string[] =>
  Array.from(container.querySelectorAll('[role="option"]')).map((o) =>
    (o.textContent ?? '').trim(),
  );

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ProjectSelect — option ordering (the contract three streams share)', () => {
  it('renders the caller order verbatim — it does NOT re-sort', () => {
    mount();
    open();
    expect(optionLabels()).toEqual(['Newest', 'Middle', 'Older']);
  });

  it('pins "All projects" FIRST when allowAll, ahead of the caller order', () => {
    mount({ allowAll: true });
    open();
    expect(optionLabels()).toEqual([ALL_PROJECTS_LABEL, 'Newest', 'Middle', 'Older']);
  });

  it('offers NO all-entry by default — a page must opt in', () => {
    mount();
    open();
    expect(optionLabels()).not.toContain(ALL_PROJECTS_LABEL);
  });
});

describe('ProjectSelect — selection', () => {
  it('emits the project id, not the label', () => {
    const onChange = vi.fn();
    mount({ onChange });
    open();
    const option = Array.from(container.querySelectorAll('[role="option"]')).find(
      (o) => (o.textContent ?? '').trim() === 'Middle',
    ) as HTMLElement;
    act(() => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith('id-middle');
  });

  it('emits the ALL sentinel verbatim — a page passes it THROUGH to the backend', () => {
    const onChange = vi.fn();
    mount({ allowAll: true, onChange });
    open();
    const option = Array.from(container.querySelectorAll('[role="option"]')).find(
      (o) => (o.textContent ?? '').trim() === ALL_PROJECTS_LABEL,
    ) as HTMLElement;
    act(() => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(ALL_PROJECTS_VALUE);
  });

  it('shows the selected project name on the trigger', () => {
    mount({ value: 'id-middle' });
    expect(trigger().textContent).toContain('Middle');
  });
});

describe('ProjectSelect — searchable affordance (pinned for the timeviews stream)', () => {
  const many = Array.from({ length: SEARCHABLE_THRESHOLD + 1 }, (_, i) => ({
    id: `id-${i}`,
    name: `Project ${i}`,
  }));

  it(`is searchable ABOVE ${SEARCHABLE_THRESHOLD} options, with the shared placeholder`, () => {
    mount({ projects: many });
    open();
    const combobox = container.querySelector('[role="combobox"]') as HTMLInputElement | null;
    expect(combobox, 'a searchable Select renders a combobox input').toBeTruthy();
    expect(combobox!.getAttribute('placeholder')).toBe('Search projects…');
  });

  it(`is NOT searchable AT exactly ${SEARCHABLE_THRESHOLD} options (the boundary, not "roughly")`, () => {
    mount({ projects: many.slice(0, SEARCHABLE_THRESHOLD) });
    open();
    expect(container.querySelector('[role="combobox"]')).toBeNull();
  });

  it('counts the all-entry toward the threshold — allowAll can tip it over', () => {
    // SEARCHABLE_THRESHOLD projects + the pinned all-entry = threshold + 1 options.
    mount({ projects: many.slice(0, SEARCHABLE_THRESHOLD), allowAll: true });
    open();
    expect(container.querySelector('[role="combobox"]')).toBeTruthy();
  });
});

describe('ProjectSelect — the states §B says must never be blank or a crash', () => {
  it('EMPTY list: renders "No projects available" and is DISABLED, not an empty dropdown', () => {
    mount({ projects: [] });
    expect(trigger().textContent).toContain('No projects available');
    expect(trigger().hasAttribute('disabled')).toBe(true);
  });

  it('LOADING: says so distinctly from empty, and is DISABLED', () => {
    // Loading and empty are DIFFERENT things (C1 — "could not measure" is not "none").
    // With an empty list they would otherwise collapse into the same blank control.
    mount({ projects: [], loading: true });
    expect(trigger().textContent).toContain('Loading projects…');
    expect(trigger().textContent).not.toContain('No projects available');
    expect(trigger().hasAttribute('disabled')).toBe(true);
  });

  it('LOADING with a populated list still reports loading, not "Select a project"', () => {
    mount({ loading: true });
    expect(trigger().textContent).toContain('Loading projects…');
  });

  it('NOTHING SELECTED but options present: prompts, and is ENABLED', () => {
    mount();
    expect(trigger().textContent).toContain('Select a project');
    expect(trigger().hasAttribute('disabled')).toBe(false);
  });

  it('an UNRESOLVED value (an id not in the list) does not crash and falls back to the placeholder', () => {
    // The §A2 shape: a stored/URL id for a project that was deleted or access-revoked.
    mount({ value: 'id-that-no-longer-exists' });
    expect(trigger().textContent).toContain('Select a project');
  });

  it('honours an explicit disabled even with a healthy list', () => {
    mount({ disabled: true });
    expect(trigger().hasAttribute('disabled')).toBe(true);
  });

  it('UNAVAILABLE: says so distinctly from empty, and is DISABLED', () => {
    mount({ projects: [], unavailable: true });
    expect(trigger().textContent).toContain('Projects unavailable');
    expect(trigger().textContent).not.toContain('No projects available');
    expect(trigger().hasAttribute('disabled')).toBe(true);
  });

  it('UNAVAILABLE suppresses the SENTINEL entries, not just the projects', () => {
    // The one that matters. With `allowAll` and an unreadable list, leaving the sentinel
    // in place is what leaves a live control whose only choice is "All projects" — and
    // picking it writes `?project=all` into the URL, where it outlives the outage.
    mount({ projects: [], allowAll: true, allowUnassigned: true, unavailable: true });
    expect(trigger().hasAttribute('disabled')).toBe(true);
    open();
    expect(optionLabels()).toEqual([]);
  });

  it('the sentinels ARE offered on a measured-empty list — unavailable is not "empty"', () => {
    // The control leg for the case above: a user with genuinely zero projects can still
    // choose the scopes their page opted into. Without this, the fix reads as "sentinels
    // are gone whenever the list is short".
    mount({ projects: [], allowAll: true });
    expect(trigger().hasAttribute('disabled')).toBe(false);
    open();
    expect(optionLabels()).toEqual([ALL_PROJECTS_LABEL]);
  });
});

describe('ProjectSelect — the unassigned entry (opt-in, like allowAll)', () => {
  it('is absent unless the caller opts in', () => {
    mount({ allowUnassigned: false });
    open();
    expect(optionLabels()).toEqual(PROJECTS.map((p) => p.name));
  });

  it('is offered ahead of the projects and emits its sentinel verbatim', () => {
    const onChange = vi.fn();
    mount({ allowUnassigned: true, onChange });
    open();
    expect(optionLabels()[0]).toBe(UNASSIGNED_PROJECT_LABEL);
    const entry = Array.from(container.querySelectorAll('[role="option"]')).find(
      (o) => (o.textContent ?? '').trim() === UNASSIGNED_PROJECT_LABEL,
    ) as HTMLElement;
    act(() => entry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(UNASSIGNED_PROJECT_VALUE);
  });
});

describe('ProjectSelect — accessibility', () => {
  it('has a default accessible name so a page cannot ship an unlabelled control', () => {
    mount();
    expect(trigger().getAttribute('aria-label')).toBe('Project');
  });

  it('a page with two selectors can override the name', () => {
    mount({ 'aria-label': 'Filter by project' });
    expect(
      container.querySelector('[aria-label="Filter by project"]'),
      'the override should reach the trigger',
    ).toBeTruthy();
  });
});
