/**
 * StreamCard counter-rendering probe — the frontend half of an earlier task.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────────
 * These tiles read `detail?.contexts_created ?? row.contexts_created ?? row.context_count`.
 * `??` is NULLISH-coalescing: it falls through on null/undefined ONLY. The first two
 * operands came from the denormalized `sessions.*_created` counter columns, which
 * SessionRepo.finish() overwrote with an in-memory delta (normally empty) on every session
 * end — so they were `0`, which is not nullish, so the broken zero WON and the correct value
 * at the end of the chain was never read. A session with 31 contexts rendered "0".
 *
 * ── WHY THE PROBE IS SHAPED THIS WAY ─────────────────────────────────────────────────────
 * The fixture below sets the denormalized fields to `0` and the derived fields to real
 * values. That is the DISCRIMINATING input: any implementation that prefers (or falls back
 * to, in a chain where 0 wins) the denormalized field renders "0" and these assertions go
 * RED. A fixture where both fields agree would pass either way and prove nothing.
 *
 * Exact strings, never "not zero" — the partial-write case of this bug produces a plausible
 * small number, not a zero.
 *
 * ── EVERY ASSERTION IS LABEL-ANCHORED, AND THE VALUES ARE UNCOINCIDENTAL ─────────────────
 * These assertions run against the card's whole `textContent`, so a bare `toContain('7')`
 * is satisfied by ANY 7 anywhere in the render — the fixture's uuid, an ISO timestamp, a
 * token count. It would have stayed green with the tile rendering nothing at all. That is
 * the same "the guard and the product agree, and you can weaken one without the other
 * noticing" shape this whole task is about, so:
 *   - every count assertion matches the value TOGETHER WITH ITS LABEL, on whitespace-
 *     normalized text: '31ctx' (collapsed `Metric` renders value then label) and
 *     'Contexts31' (expanded `StatTile` renders label then value);
 *   - the fixture uses two-digit values that do not appear in the uuid or the timestamps.
 * A single-digit count is never assertable this way by accident.
 *
 * MUTATION PROOF (recorded in the earlier task report): putting `row.contexts_created ??`
 * back at the front of the chain makes 'renders the DERIVED counts…' fail with "0" instead
 * of "31". Watched, not assumed.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The card lazy-loads detail via react-query and navigates on click; stub both so this is a
// pure render probe of the count-selection logic.
const mockDetail = vi.fn();
vi.mock('./hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./hooks');
  return {
    ...actual,
    useSessionDetail: (...args: unknown[]) => mockDetail(...args),
    useEndSession: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  };
});
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import StreamCard from './StreamCard';
import type { SessionListRow } from './hooks';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockDetail.mockReturnValue({ data: undefined, isLoading: false, error: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/**
 * The discriminating fixture: the DENORMALIZED fields are zero (as they are on every
 * prod session finalized before this fix); the DERIVED fields carry the truth.
 */
const POISONED_ROW: SessionListRow = {
  id: '11111111-1111-4111-8111-111111111111',
  project_name: 'riverbend',
  title: 'a session whose counter columns were destroyed by finish()',
  actor: 'coordinator',
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
  last_activity_at: new Date().toISOString(),
  contexts_created: 0,
  context_count: 31,
  tasks_created: 0,
  task_count: 23,
  decisions_created: 0,
  decision_count: 19,
  total_tokens: 184000,
  files_modified_count: 2,
};

/**
 * Whitespace-normalized render text. The tile's value and label are adjacent elements, so
 * `textContent` concatenates them ('31' + 'ctx'); normalizing lets the assertions anchor on
 * that pair without being brittle about formatting inside the markup.
 */
function render(row: SessionListRow) {
  act(() => {
    root.render(<StreamCard row={row} onEdit={() => {}} />);
  });
  return (container.textContent ?? '').replace(/\s+/g, '');
}

describe('StreamCard counters', () => {
  it('collapsed row renders the DERIVED counts, not the zeroed denormalized ones', () => {
    const text = render(POISONED_ROW);
    // '31ctx', not '0ctx' — the whole bug in one assertion. Anchored on the label so a
    // stray 31 elsewhere in the card cannot satisfy it, and so a tile that renders NO
    // value fails instead of passing on someone else's digits.
    // (No `not.toContain('0ctx')` needed: the tile renders exactly one value, so a broken
    // 0 makes the positive assertion fail on its own.)
    expect(text).toContain('31ctx');
    expect(text).toContain('23tasks');
    // Tokens have no child table; this is the raw column and it is genuinely 184000.
    expect(text).toContain('184ktok');
  });

  it('expanded card renders the same numbers as the collapsed row', async () => {
    // Detail arrives with the same derived shape the backend now serves.
    mockDetail.mockReturnValue({
      data: {
        id: POISONED_ROW.id,
        contexts_created: 0,
        context_count: 31,
        tasks_created: 0,
        task_count: 23,
        decisions_created: 0,
        decision_count: 19,
        total_tokens: 184000,
        files_modified_count: 2,
        contexts: [],
        decisions: [],
        tasks: [],
        linked_commits: [],
      },
      isLoading: false,
      error: null,
    });

    const collapsed = render(POISONED_ROW);
    expect(collapsed).toContain('31ctx');

    // Expand: the header button toggles the body.
    const toggle = container.querySelector('button');
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });

    // Expanded tiles put the LABEL first (StatTile), so the anchored pair reads
    // 'Contexts31' rather than '31ctx'.
    const expanded = (container.textContent ?? '').replace(/\s+/g, '');
    // "collapsed row == expanded card" is a stated acceptance criterion of the task.
    expect(expanded).toContain('Contexts31');
    expect(expanded).toContain('Tasks23');
    // Decisions are detail-only and were a GUARANTEED zero before this task
    // (sessions.decisions_created has no runtime writer anywhere in the tree).
    expect(expanded).toContain('Decisions19');
    expect(expanded).toContain('Tokens184k');
  });

  it('an ABSENT count renders the unknown dash, never a silent zero', () => {
    // Fail-loud property: formatCount(undefined) is '—'. If the API ever stops serving a
    // derived field, the UI says "unknown" rather than confidently reporting 0 — which is
    // the exact silent-wrong-answer this task exists to remove.
    const text = render({ ...POISONED_ROW, context_count: undefined, task_count: undefined });
    expect(text).toContain('—ctx');
    expect(text).toContain('—tasks');
    expect(text).not.toContain('31ctx');
  });
});
