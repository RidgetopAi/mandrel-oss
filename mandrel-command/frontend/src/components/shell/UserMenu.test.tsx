/**
 * UserMenu (P0.4) keyboard-a11y tests — the WAI-ARIA roving-focus menu pattern.
 *
 * Same harness the rest of the shell suite uses (raw react-dom + React.act +
 * MemoryRouter; this repo has no @testing-library — see src/setupTests.ts). The
 * AuthContext dependency is stubbed via vi.mock (UserMenu only needs `user` +
 * `logout`), so no real AuthProvider / react-query / auth store is pulled in.
 *
 * These assert BEHAVIOUR that only exists because of the roving-focus logic:
 * ArrowDown/ArrowUp move + WRAP, Home/End jump to first/last, the roving-tabIndex
 * invariant (active item tabIndex=0, all others -1 — i.e. exactly one item in the
 * tab sequence), and Escape closes + restores focus to the trigger. Strip the
 * onMenuKeyDown handler or the roving tabIndex and these fail.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, vi } from 'vitest';

// Stub AuthContext: UserMenu consumes only { user, logout }. The raw context is
// not exported, so a module mock is the trivial, non-brittle stub.
vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({ user: { username: 'Ada' }, logout: () => Promise.resolve() }),
}));

import { UserMenu } from './UserMenu';

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

function press(el: Element | null, key: string) {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function click(el: Element | null) {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const trigger = () =>
  container.querySelector('[data-testid="user-menu-trigger"]') as HTMLButtonElement | null;
const menu = () => container.querySelector('[role="menu"]');
const items = () =>
  Array.from(container.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[];
const tabIndexes = () => items().map((el) => el.tabIndex);
const activeItemIndex = () => items().findIndex((el) => el === document.activeElement);

/** Mount + open the menu by clicking the trigger; returns the menuitem list. */
function openMenu() {
  mount(
    <MemoryRouter>
      <UserMenu />
    </MemoryRouter>,
  );
  click(trigger());
  return items();
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('UserMenu — WAI-ARIA roving-focus keyboard menu', () => {
  it('opens focused on the first item, with exactly that item in the tab sequence', () => {
    const list = openMenu();
    expect(menu()).not.toBeNull();
    expect(list).toHaveLength(3);
    expect(activeItemIndex()).toBe(0);
    // Roving tabIndex invariant: active=0, others=-1.
    expect(tabIndexes()).toEqual([0, -1, -1]);
  });

  it('ArrowDown moves focus down and WRAPS past the last item back to the first', () => {
    openMenu();
    expect(activeItemIndex()).toBe(0);

    press(document.activeElement, 'ArrowDown');
    expect(activeItemIndex()).toBe(1);
    expect(tabIndexes()).toEqual([-1, 0, -1]);

    press(document.activeElement, 'ArrowDown');
    expect(activeItemIndex()).toBe(2);
    expect(tabIndexes()).toEqual([-1, -1, 0]);

    // wrap
    press(document.activeElement, 'ArrowDown');
    expect(activeItemIndex()).toBe(0);
    expect(tabIndexes()).toEqual([0, -1, -1]);
  });

  it('ArrowUp moves focus up and WRAPS from the first item to the last', () => {
    openMenu();
    expect(activeItemIndex()).toBe(0);

    press(document.activeElement, 'ArrowUp');
    expect(activeItemIndex()).toBe(2);
    expect(tabIndexes()).toEqual([-1, -1, 0]);

    press(document.activeElement, 'ArrowUp');
    expect(activeItemIndex()).toBe(1);
    expect(tabIndexes()).toEqual([-1, 0, -1]);
  });

  it('Home jumps to the first item and End jumps to the last', () => {
    openMenu();
    press(document.activeElement, 'ArrowDown'); // → index 1
    expect(activeItemIndex()).toBe(1);

    press(document.activeElement, 'End');
    expect(activeItemIndex()).toBe(2);
    expect(tabIndexes()).toEqual([-1, -1, 0]);

    press(document.activeElement, 'Home');
    expect(activeItemIndex()).toBe(0);
    expect(tabIndexes()).toEqual([0, -1, -1]);
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    openMenu();
    expect(menu()).not.toBeNull();

    press(document.activeElement, 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('ArrowDown on the closed trigger opens to the first item; ArrowUp opens to the last', () => {
    mount(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>,
    );
    // ArrowDown from the trigger → open on first
    press(trigger(), 'ArrowDown');
    expect(menu()).not.toBeNull();
    expect(activeItemIndex()).toBe(0);

    press(document.activeElement, 'Escape');
    expect(menu()).toBeNull();

    // ArrowUp from the trigger → open on last
    press(trigger(), 'ArrowUp');
    expect(menu()).not.toBeNull();
    expect(activeItemIndex()).toBe(2);
  });
});
