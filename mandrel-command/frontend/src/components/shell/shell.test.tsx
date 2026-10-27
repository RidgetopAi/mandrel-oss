/**
 * App-shell (P0.4) tests. Raw react-dom + act (the repo pattern — see
 * charts.render.test.tsx). Asserts on stable data-attributes / roles / aria
 * (NOT hashed CSS-module class names), so they hold regardless of CSS handling.
 *
 * Coverage (per task): nav renders the 3 groups + utility, active-route highlight
 * (aria-current), collapse toggle (rail state + hook persistence), theme toggle
 * sets data-theme, and the new-screen placeholder renders.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import { Sidebar } from './Sidebar';
import { ComingSoon } from './ComingSoon';
import { ThemeToggle } from './ThemeToggle';
import { useSidebarCollapse } from './hooks';
import { shellConfig } from './shellConfig';
import { NAV_GROUPS, NAV_UTILITY, ALL_NAV_ITEMS } from './navConfig';
import { ThemeProvider } from '../../contexts/ThemeContext';

// The Decision Inbox nav badge (an earlier task DONE WHEN 5) reads a live open-decision
// count via react-query. Stubbed here — this file mounts Sidebar with no
// QueryClientProvider/api mocking, and the badge's own render rule (zero/loading/error →
// nothing) is exercised directly below rather than through a real network read.
const badgeState = vi.hoisted(() => ({ count: undefined as number | undefined }));
vi.mock('../../pages/decisionInbox/hooks', () => ({
  useOpenDecisionCount: () => ({ data: badgeState.count }),
}));

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

beforeEach(() => {
  badgeState.count = undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

// ── theme default (regression) ────────────────────────────────────────────────
describe('ThemeProvider — dark is the locked default', () => {
  it('PINS data-theme="dark" on mount when no preference is stored', () => {
    localStorage.removeItem('app_theme');
    mount(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    );
    // Regression (caught in a live browser smoke, not jsdom): the default branch
    // previously returned "dark" as STATE but never set the attribute, so
    // tokens.css `@media (prefers-color-scheme: light) :root:not([data-theme])`
    // rendered LIGHT on a light-preferring browser — silently breaking the locked
    // dark default. The attribute MUST be pinned so dark holds regardless of OS.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('honors a stored LIGHT preference over the dark default', () => {
    localStorage.setItem('app_theme', 'light');
    mount(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

// ── nav config integrity (the locked IA) ──────────────────────────────────────
describe('navConfig — the LOCKED IA', () => {
  it('has exactly three content groups in order: Operate / Memory & work / Insight', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['Operate', 'Memory & work', 'Insight']);
  });

  // Feedback joined the utility zone in an earlier task — the ONE deliberate addition to
  // the locked 11. It is pinned here (rather than the assertion just being relaxed) so a
  // future accidental nav edit still fails: the list is exact and ordered.
  it('the utility zone is Projects, Settings, then Feedback', () => {
    expect(NAV_UTILITY.map((i) => i.label)).toEqual(['Projects', 'Settings', 'Feedback']);
  });

  it('Feedback points at the live /feedback route', () => {
    const feedback = ALL_NAV_ITEMS.find((i) => i.id === 'feedback');
    expect(feedback?.to).toBe('/feedback');
    // It is a real, live screen — not a ComingSoon placeholder.
    expect(feedback?.isNew).toBeUndefined();
  });

  it('TreeWalker carries a [work] qualifier', () => {
    const treewalker = ALL_NAV_ITEMS.find((i) => i.id === 'treewalker');
    expect(treewalker?.qualifier).toBe('work');
  });

  it('Calendar is the remaining new (placeholder) item; TreeWalker is now a live screen', () => {
    const calendar = ALL_NAV_ITEMS.find((i) => i.id === 'calendar');
    const treewalker = ALL_NAV_ITEMS.find((i) => i.id === 'treewalker');
    expect(calendar?.isNew).toBe(true);
    // TreeWalker shipped in Phase 3 (moat graph visualizer) — no longer isNew.
    // Its thread data renders honest-empty until backend lands.
    expect(treewalker?.isNew).toBeUndefined();
  });

  it('has 13 nav entries total (10 content + 3 utility)', () => {
    // 10 content (3 + 5 + 2) + 3 utility (Projects, Settings, Feedback) = 13.
    // The locked IA reference is 11 less the removed Surveyor; Feedback, Punch List
    // and Decision Inbox are the
    // three documented additions — see the navConfig header.
    expect(NAV_GROUPS.flatMap((g) => g.items)).toHaveLength(10);
    expect(ALL_NAV_ITEMS).toHaveLength(13);
  });
});

// ── sidebar rendering ─────────────────────────────────────────────────────────
describe('Sidebar', () => {
  it('renders the three group labels and every nav item', () => {
    mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar />
      </MemoryRouter>,
    );
    for (const group of NAV_GROUPS) {
      expect(container.querySelector(`[data-nav-group="${group.id}"]`)).not.toBeNull();
    }
    for (const item of ALL_NAV_ITEMS) {
      const link = container.querySelector(`[data-nav-item="${item.id}"]`);
      expect(link, `nav item ${item.id} should render`).not.toBeNull();
      expect(link?.getAttribute('href')).toBe(item.to);
    }
  });

  it('marks the active route with aria-current="page" (teal highlight)', () => {
    mount(
      <MemoryRouter initialEntries={['/tasks']}>
        <Sidebar />
      </MemoryRouter>,
    );
    const tasks = container.querySelector('[data-nav-item="tasks"]');
    const dashboard = container.querySelector('[data-nav-item="dashboard"]');
    expect(tasks?.getAttribute('aria-current')).toBe('page');
    expect(dashboard?.getAttribute('aria-current')).toBeNull();
  });

  it('collapses to an icon rail: data-collapsed flips and group labels hide from a11y', () => {
    mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar collapsed />
      </MemoryRouter>,
    );
    const side = container.querySelector('[data-testid="sidebar"]');
    expect(side?.getAttribute('data-collapsed')).toBe('true');
    // Group headers become hairline separators → hidden from the a11y tree.
    const firstGroup = container.querySelector('[data-nav-group="operate"]');
    expect(firstGroup?.getAttribute('aria-hidden')).toBe('true');
    // Icons (and therefore the links) stay present in the rail.
    expect(container.querySelector('[data-nav-item="tasks"]')).not.toBeNull();
  });

  it('expanded state keeps group labels in the a11y tree', () => {
    mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar collapsed={false} />
      </MemoryRouter>,
    );
    const side = container.querySelector('[data-testid="sidebar"]');
    expect(side?.getAttribute('data-collapsed')).toBe('false');
    expect(
      container.querySelector('[data-nav-group="operate"]')?.getAttribute('aria-hidden'),
    ).toBe('false');
  });
});

// ── Decision Inbox nav badge (an earlier task DONE WHEN 5) ───────────────────────
describe('Sidebar — Decision Inbox nav badge', () => {
  it('renders nothing at zero open decisions', () => {
    badgeState.count = 0;
    mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="decision-inbox-badge"]')).toBeNull();
  });

  it('renders nothing while the count has not resolved (loading/error, not a false zero)', () => {
    badgeState.count = undefined;
    mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="decision-inbox-badge"]')).toBeNull();
  });

  it('shows the open count on the Decision Inbox nav item when nonzero', () => {
    badgeState.count = 4;
    mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar />
      </MemoryRouter>,
    );
    const item = container.querySelector('[data-nav-item="decision-inbox"]');
    const badge = item?.querySelector('[data-testid="decision-inbox-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('4');
  });
});

// ── collapse hook (persistence) ───────────────────────────────────────────────
describe('useSidebarCollapse', () => {
  beforeEach(() => localStorage.clear());

  function Harness() {
    const { collapsed, toggle } = useSidebarCollapse();
    return (
      <button type="button" data-testid="h-toggle" data-collapsed={collapsed} onClick={toggle}>
        toggle
      </button>
    );
  }

  it('toggles and persists the collapsed state to localStorage', () => {
    mount(<Harness />);
    const btn = container.querySelector('[data-testid="h-toggle"]') as HTMLButtonElement;
    expect(btn.getAttribute('data-collapsed')).toBe('false');

    act(() => btn.click());
    expect(btn.getAttribute('data-collapsed')).toBe('true');
    expect(localStorage.getItem(shellConfig.collapseStorageKey)).toBe('1');

    act(() => btn.click());
    expect(btn.getAttribute('data-collapsed')).toBe('false');
    expect(localStorage.getItem(shellConfig.collapseStorageKey)).toBe('0');
  });

  it('reads an initial collapsed state from localStorage', () => {
    localStorage.setItem(shellConfig.collapseStorageKey, '1');
    mount(<Harness />);
    const btn = container.querySelector('[data-testid="h-toggle"]') as HTMLButtonElement;
    expect(btn.getAttribute('data-collapsed')).toBe('true');
  });
});

// ── theme toggle ──────────────────────────────────────────────────────────────
describe('ThemeToggle', () => {
  it('toggles the theme and sets data-theme on the document root', () => {
    mount(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const btn = container.querySelector('[data-testid="theme-toggle"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    // Dark is the default → aria-pressed true.
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    act(() => btn.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    act(() => btn.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});

// ── coming-soon placeholder ───────────────────────────────────────────────────
describe('ComingSoon placeholder', () => {
  it('renders a clearly-labeled placeholder (not a silent dead link)', () => {
    mount(<ComingSoon title="Calendar" />);
    const panel = container.querySelector('[data-testid="coming-soon"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Calendar');
    expect(panel?.textContent?.toLowerCase()).toContain('coming in the redesign');
  });
});
