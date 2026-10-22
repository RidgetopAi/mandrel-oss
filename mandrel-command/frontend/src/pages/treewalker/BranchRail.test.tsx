/**
 * BranchRail — component test pinning P2: the rail
 * shows DRAWERS, named, with the truth about what is not shown.
 *
 * Behaviors pinned directly against the component (no page/hook/API involved, so a failure
 * here points straight at BranchRail.tsx):
 *   1. A branch with `isTopLevel: false` (a SECTION of some other drawer) is never
 *      rendered — only top-level drawers get a rail slot.
 *   2. A NAMED branch renders its `branch:<name>` tag in full; an UNNAMED branch renders
 *      its spine title TRUNCATED to `TREEWALKER_CONFIG.branchTitleMaxChars` (plus an
 *      ellipsis) rather than the raw, potentially-long title verbatim.
 *   3. The honest count line (drawers shown of the true total) renders on EVERY
 *      non-loading path that has a total to state — INCLUDING the all-sections path and
 *      (CLAUSE 5) the ZERO-ROWS path, both of which used to return early
 *      and say nothing about the count at all. Withheld only at total === 0.
 * Fixtures are constructed so each assertion fails on its own: comment out the
 * `isTopLevel` filter and the section branch appears; comment out the truncation and the
 * full raw title (well past the budget) appears untruncated; comment out the count line on
 * the all-sections early return and it disappears from that path alone.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { BranchRail } from './BranchRail';
import { TREEWALKER_CONFIG } from './config';
import type { BranchSummary } from '../../api/domains/treewalker';

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const DRAWER: BranchSummary = {
  spineId: 'd0000000-0000-4000-8000-000000000001',
  spineType: 'task',
  name: 'command-ui-selector',
  named: true,
  members: 5,
  lastActiveAt: '2026-09-18T00:00:00Z',
  open: false,
  isTopLevel: true,
  sectionCount: 1,
};

const SECTION: BranchSummary = {
  spineId: 's0000000-0000-4000-8000-000000000002',
  spineType: 'task',
  name: 'nested-section-not-a-drawer',
  named: true,
  members: 2,
  lastActiveAt: '2026-09-17T00:00:00Z',
  open: false,
  isTopLevel: false,
  sectionCount: 0,
};

describe('BranchRail — top-level filter (P2, isTopLevel)', () => {
  it('renders a top-level drawer but never a branch with isTopLevel false', () => {
    mount(
      <BranchRail
        branches={[DRAWER, SECTION]}
        total={2}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const rail = container.querySelector('[data-testid="tw-branches"]');
    expect(rail?.textContent).toMatch(/command-ui-selector/);
    expect(rail?.textContent).not.toMatch(/nested-section-not-a-drawer/);
    expect(rail?.querySelectorAll('button')).toHaveLength(1);
  });
});

describe('BranchRail — naming (P2, named vs truncated spine title)', () => {
  it('a named branch renders its full tag name, never truncated', () => {
    const longTag = 'a'.repeat(TREEWALKER_CONFIG.branchTitleMaxChars + 25);
    const named: BranchSummary = { ...DRAWER, name: longTag, named: true };
    mount(
      <BranchRail
        branches={[named]}
        total={1}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const nameEl = container.querySelector('[data-testid="tw-branches"] button');
    expect(nameEl?.textContent).toContain(longTag);
  });

  it('an unnamed branch renders its spine title truncated to the configured budget, with an ellipsis', () => {
    const rawTitle =
      'Investigate the flaky auth integration test that intermittently fails under load in CI';
    expect(rawTitle.length).toBeGreaterThan(TREEWALKER_CONFIG.branchTitleMaxChars);
    const unnamed: BranchSummary = { ...DRAWER, name: rawTitle, named: false };
    mount(
      <BranchRail
        branches={[unnamed]}
        total={1}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const btn = container.querySelector('[data-testid="tw-branches"] button');
    // The FULL raw title never lands in the DOM — only the truncated form does.
    expect(btn?.textContent).not.toContain(rawTitle);
    expect(btn?.textContent).toContain(
      rawTitle.slice(0, TREEWALKER_CONFIG.branchTitleMaxChars).trimEnd(),
    );
    expect(btn?.textContent).toContain('…');
  });
});

describe('BranchRail — honest count + the two distinct empty states (P2)', () => {
  it('states drawers-shown against the true total, and the cap when the page is truncated', () => {
    mount(
      <BranchRail
        branches={[DRAWER]}
        total={12}
        cap={2}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const rail = container.querySelector('[data-testid="tw-branches"]');
    expect(rail?.textContent).toMatch(/1 drawer shown of 12 drawers/);
    expect(rail?.textContent).toMatch(/capped at 2/);
  });

  it('never claims a cap when the whole total fits on the page (total <= cap)', () => {
    mount(
      <BranchRail
        branches={[DRAWER]}
        total={1}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const rail = container.querySelector('[data-testid="tw-branches"]');
    expect(rail?.textContent).toMatch(/1 drawer shown of 1 drawer/);
    expect(rail?.textContent).not.toMatch(/capped/);
  });

  it('no branches at all: the pre-existing honest empty state survives', () => {
    mount(
      <BranchRail
        branches={[]}
        total={0}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="tw-branches"]')?.textContent).toMatch(
      /no branches yet/i,
    );
  });

  it('branches exist on the page but all are sections: a distinct honest note, not the "no branches yet" one', () => {
    mount(
      <BranchRail
        branches={[SECTION]}
        total={4}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const rail = container.querySelector('[data-testid="tw-branches"]');
    expect(rail?.textContent).not.toMatch(/no branches yet/i);
    expect(rail?.querySelector('[data-testid="tw-branches-filtered-note"]')).toBeTruthy();
    expect(rail?.textContent).toMatch(/none are top-level drawers/i);
  });

  it('CLAUSE 5: zero rows with a non-zero total still states the count — never a bare "no branches yet"', () => {
    // The shape the round-1 critic named: the server says there ARE drawers in scope and
    // this page carries none of them. Saying only "no branches yet" here is the rail
    // asserting a population fact its own payload contradicts.
    mount(
      <BranchRail
        branches={[]}
        total={9}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const rail = container.querySelector('[data-testid="tw-branches"]');
    const countEl = rail?.querySelector('[data-testid="tw-branches-count"]');
    expect(countEl).toBeTruthy();
    expect(countEl?.textContent).toMatch(/0 drawers shown of 9 drawers/);
  });

  it('CLAUSE 5: zero rows and a zero total stays silent — the count line adds nothing there', () => {
    // The other side of the predicate, so "render it whenever total > 0" cannot be
    // satisfied by rendering it unconditionally.
    mount(
      <BranchRail
        branches={[]}
        total={0}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const rail = container.querySelector('[data-testid="tw-branches"]');
    expect(rail?.querySelector('[data-testid="tw-branches-count"]')).toBeNull();
    expect(rail?.textContent).toMatch(/no branches yet/i);
  });

  it('the all-sections path still states the count — it never goes silent about what it is not showing', () => {
    mount(
      <BranchRail
        branches={[SECTION]}
        total={4}
        cap={30}
        isLoading={false}
        activeSpineId={null}
        onSelect={vi.fn()}
      />,
    );
    const rail = container.querySelector('[data-testid="tw-branches"]');
    const countEl = rail?.querySelector('[data-testid="tw-branches-count"]');
    expect(countEl).toBeTruthy();
    expect(countEl?.textContent).toMatch(/0 drawers shown of 4 drawers/);
  });
});
