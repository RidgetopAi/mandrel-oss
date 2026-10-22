/**
 * CalendarToolbar — the view switcher and the nav.
 *
 * The project control that used to be asserted here is GONE: the
 * calendar is scoped by the ONE switch in the topbar (shell/ProjectSwitch), and
 * `pages/noPageProjectSelect.guard.test.ts` fails if a page toolbar grows one back.
 *
 * Raw react-dom + React.act harness.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CalendarToolbar } from './CalendarToolbar';

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <CalendarToolbar
        view="month"
        onViewChange={vi.fn()}
        rangeLabel="July 2026"
        anchor={new Date(2026, 6, 13)}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onToday={vi.fn()}
        onJumpToDate={vi.fn()}
      />,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('CalendarToolbar — view switcher + nav', () => {
  beforeEach(() => mount());

  it('renders Month/Week/Day with the active view pressed', () => {
    const labels = Array.from(
      container.querySelectorAll('[role="group"][aria-label="Calendar view"] button'),
    ).map((b) => (b.textContent ?? '').trim());
    expect(labels).toEqual(['Month', 'Week', 'Day']);
    const pressed = container.querySelector('button[aria-pressed="true"]') as HTMLButtonElement;
    expect(pressed.textContent).toBe('Month');
  });

  it('labels the nav arrows by the active view unit (month)', () => {
    expect(container.querySelector('button[aria-label="Previous month"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Next month"]')).not.toBeNull();
  });

  it('renders the range label and a jump-to-date input seeded from the anchor', () => {
    expect(container.textContent).toContain('July 2026');
    const jump = container.querySelector('input[aria-label="Jump to date"]') as HTMLInputElement;
    expect(jump).not.toBeNull();
    expect(jump.getAttribute('type')).toBe('date');
    expect(jump.value).toBe('2026-07-13');
  });
});
