/**
 * "Sessions by actor" rows link to that actor's most recent session.
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────────────────
 * The rollup used to COLLAPSE its sessions into an `ActorActivity` and throw every session
 * id away, so the panel was a dead end: it told you an actor had been busy and gave you no
 * way to go look. Two things have to hold and each has its own failure mode:
 *
 *   1. The id carried through is the id of the session `lastSeen` came from. Carrying "the
 *      first row" or "the last row in the array" would look right in a fixture that happens
 *      to be sorted and be wrong on real data — so the fixture below is DELIBERATELY
 *      unsorted, and the newest session is neither first nor last.
 *   2. The row is a REAL control: a `<button>`, so it is tab-reachable and Enter/Space
 *      activates it. A `<div onClick>` passes a click test and is invisible to a keyboard.
 *      Asserting the tag name is the only assertion that separates the two.
 *
 * And the degenerate case, which is the one that crashes in production rather than in a
 * fixture: an actor whose sessions carry no usable timestamp has no resolvable id, and must
 * render as an inert row rather than a control that navigates to `/sessions/undefined`.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const byActor = vi.fn();
vi.mock('./hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./hooks');
  return { ...actual, useSessionsByActor: (...args: unknown[]) => byActor(...args) };
});

import { SessionsByActor } from './SessionsByActor';
import { aggregateByActor, type SessionActorRow } from './parts';

const HOUR = 3600 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/**
 * Three sessions for one actor, in an order that punishes "take the first" and "take the
 * last" equally: the NEWEST (`sess-newest`) sits in the MIDDLE.
 */
const COORDINATOR_SESSIONS: SessionActorRow[] = [
  { id: 'sess-oldest', actor: 'coordinator', project_name: 'riverbend', context_count: 3, task_count: 1, total_tokens: 100, ended_at: iso(9 * HOUR), last_activity_at: iso(9 * HOUR) },
  { id: 'sess-newest', actor: 'coordinator', project_name: 'riverbend', context_count: 5, task_count: 2, total_tokens: 200, ended_at: null, last_activity_at: iso(1 * HOUR) },
  { id: 'sess-middle', actor: 'coordinator', project_name: 'daisy', context_count: 4, task_count: 0, total_tokens: 300, ended_at: iso(5 * HOUR), last_activity_at: iso(5 * HOUR) },
];

let container: HTMLDivElement;
let root: Root;

function render(actors: ReturnType<typeof aggregateByActor>) {
  byActor.mockReturnValue({ data: actors, isPending: false, isError: false, error: null });
  act(() => {
    root.render(<SessionsByActor projectId="p1" scope={(() => ({})) as never} />);
  });
}

/**
 * The interactive rows, found by the accessible name the control exposes — deliberately
 * NOT by CSS-module class (vitest runs with `css: false`, so class names are not a
 * reliable handle) and not by test id (the accessible name is what a user and a screen
 * reader actually have).
 */
function linkRows(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Open the most recent session"]',
    ),
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('aggregateByActor carries the most-recent session id', () => {
  it('picks the session that lastSeen came from — not the first or last row', () => {
    const [coordinator] = aggregateByActor(COORDINATOR_SESSIONS);
    expect(coordinator.lastSessionId).toBe('sess-newest');
    // The pair must AGREE: the id belongs to the session whose time is displayed.
    expect(coordinator.lastSeen).toBe(COORDINATOR_SESSIONS[1].last_activity_at);
  });

  it('falls back through ended_at / started_at / created_at like lastSeen does', () => {
    const rows: SessionActorRow[] = [
      { id: 'only-started', actor: 'amp', context_count: 1, started_at: iso(2 * HOUR) },
      { id: 'only-created', actor: 'amp', context_count: 1, created_at: iso(6 * HOUR) },
    ];
    const [amp] = aggregateByActor(rows);
    expect(amp.lastSessionId).toBe('only-started');
  });

  it('leaves the id UNDEFINED when no session in the group has any timestamp', () => {
    const rows: SessionActorRow[] = [{ id: 'no-times', actor: 'ghost', context_count: 1 }];
    const [ghost] = aggregateByActor(rows);
    expect(ghost.lastSeen).toBeUndefined();
    expect(ghost.lastSessionId).toBeUndefined();
  });

  it('treats an EMPTY id as no id (a control that navigates nowhere is worse than none)', () => {
    const rows: SessionActorRow[] = [
      { id: '', actor: 'blank', context_count: 1, last_activity_at: iso(HOUR) },
    ];
    const [blank] = aggregateByActor(rows);
    expect(blank.lastSessionId).toBeUndefined();
  });

  it('the empty input produces no rows at all', () => {
    expect(aggregateByActor([])).toEqual([]);
  });
});

describe('the row is a real, keyboard-reachable control', () => {
  it('renders as a <button> and navigates to /sessions/<most recent id> on click', () => {
    render(aggregateByActor(COORDINATOR_SESSIONS));
    const rows = linkRows();
    expect(rows).toHaveLength(1);
    const el = rows[0];
    // A <button> is tab-reachable and Enter/Space-activated by the platform; a div with an
    // onClick is neither, and would pass a click-only assertion.
    expect(el.tagName).toBe('BUTTON');
    expect(el.type).toBe('button');
    expect(el.getAttribute('aria-label')).toContain('coordinator');
    // The row still shows everything it showed as a div.
    expect(el.textContent).toContain('contexts');
    expect(el.textContent).toContain('coordinator');

    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/sessions/sess-newest');
  });

  it('an actor with no resolvable session id renders INERT — no control, no crash', () => {
    render(aggregateByActor([{ id: 'x', actor: 'ghost', context_count: 7 }]));
    expect(linkRows()).toHaveLength(0);
    // Still fully rendered — inert, not hidden.
    expect(container.textContent).toContain('ghost');
    expect(container.textContent).toContain('contexts');
    expect(navigate).not.toHaveBeenCalled();
  });
});
