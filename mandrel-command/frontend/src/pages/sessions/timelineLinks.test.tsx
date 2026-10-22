/**
 * Timeline record links — the id on an activity row must open THAT record.
 *
 * ── THE TRAP THIS EXISTS TO CATCH ────────────────────────────────────────────────────
 * `ev.kind` cannot discriminate the record type. contextKind() maps a CONTEXT whose
 * context_type is 'decision' onto kind 'decision', identical to a real decision row. A
 * link built off `kind` therefore sends a context id to /decisions/:id — a wrong record,
 * or a not-found, with nothing on screen to say so. The fixture below plants exactly that
 * context, and the assertions demand the /contexts/ route for it. A `kind`-driven
 * implementation renders the same badge and fails here.
 *
 * The second trap is the id: `idShort` is an 8-char display truncation. Asserting the
 * href ENDS WITH the full uuid is what makes a truncated route param fail.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const mockDetail = vi.fn();
vi.mock('./hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./hooks');
  return {
    ...actual,
    useSessionDetail: (...args: unknown[]) => mockDetail(...args),
    useEndSession: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  };
});

import StreamCard from './StreamCard';
import { buildTimeline } from './parts';
import { TimelinePanel } from '../sessionDetail/panels';
import type { SessionListRow } from './hooks';
import type { SessionDetail } from '../../types/session';

const CTX_ID = 'c0ffee11-1111-4111-8111-111111111111';
/** A CONTEXT whose context_type is 'decision' — the discriminator trap, in one row. */
const CTX_TYPED_DECISION_ID = 'dece0000-2222-4222-8222-222222222222';
const DEC_ID = 'aaaadec0-3333-4333-8333-333333333333';
const TASK_ID = 'bbbbtask-4444-4444-8444-444444444444';

const AT = '2026-08-01T12:00:00.000Z';

const DETAIL = {
  id: '99999999-9999-4999-8999-999999999999',
  contexts: [
    { id: CTX_ID, context_type: 'milestone', content: 'a milestone context', created_at: AT },
    {
      id: CTX_TYPED_DECISION_ID,
      context_type: 'decision',
      content: 'a context that CALLS ITSELF a decision',
      created_at: AT,
    },
  ],
  decisions: [{ id: DEC_ID, title: 'a real decision row', created_at: AT }],
  tasks: [{ id: TASK_ID, title: 'a task', status: 'in_progress', created_at: AT }],
  linked_commits: [
    {
      id: 'commit-row-1',
      commit_sha: 'df5fd78abcdef',
      short_sha: 'df5fd78',
      message: 'a commit',
      author_date: AT,
    },
  ],
} as unknown as SessionDetail;

const ROW: SessionListRow = {
  id: '99999999-9999-4999-8999-999999999999',
  project_name: 'riverbend',
  title: 'a session',
  context_count: 2,
  task_count: 1,
  decision_count: 1,
  total_tokens: 1000,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockDetail.mockReturnValue({ data: DETAIL, isLoading: false, isError: false, error: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Every anchor the render produced, as (text, href) pairs. */
function anchors(): Array<{ text: string; href: string }> {
  return Array.from(container.querySelectorAll('a')).map((a) => ({
    text: (a.textContent ?? '').trim(),
    href: a.getAttribute('href') ?? '',
  }));
}

function hrefForText(text: string): string | undefined {
  return anchors().find((a) => a.text === text)?.href;
}

/** The Sessions stream card, expanded. */
function renderStreamCard() {
  act(() => {
    root.render(
      <MemoryRouter>
        <StreamCard row={ROW} status="live" onEdit={() => {}} />
      </MemoryRouter>,
    );
  });
  const head = container.querySelector('button[aria-controls]') as HTMLButtonElement;
  act(() => {
    head.click();
  });
}

/** The Session detail Timeline tab. */
function renderTimelinePanel() {
  act(() => {
    root.render(
      <MemoryRouter>
        <TimelinePanel detail={DETAIL as never} />
      </MemoryRouter>,
    );
  });
}

const SURFACES: Array<[string, () => void]> = [
  ['Sessions stream card', renderStreamCard],
  ['SessionDetail Timeline tab', renderTimelinePanel],
];

describe('buildTimeline stamps the TRUE record type, not the badge kind', () => {
  it("a context typed 'decision' has kind decision but record context", () => {
    const events = buildTimeline(DETAIL);
    const ev = events.find((e) => e.recordId === CTX_TYPED_DECISION_ID);
    expect(ev, 'the trap context should produce an event').toBeTruthy();
    expect(ev!.kind, 'the badge still reads decision — that is the trap').toBe('decision');
    expect(ev!.record).toBe('context');
  });

  it('carries the FULL id, not the 8-char display truncation', () => {
    const ev = buildTimeline(DETAIL).find((e) => e.record === 'task');
    expect(ev!.recordId).toBe(TASK_ID);
    expect(ev!.idShort).toBe(TASK_ID.slice(0, 8));
    expect(ev!.recordId).not.toBe(ev!.idShort);
  });

  it('a commit carries no record type — there is no commit route to send it to', () => {
    const ev = buildTimeline(DETAIL).find((e) => e.kind === 'commit');
    expect(ev).toBeTruthy();
    expect(ev!.record).toBeUndefined();
    expect(ev!.recordId).toBeUndefined();
  });
});

describe.each(SURFACES)('%s — timeline ids link to the record', (_name, render) => {
  it('a context links to /contexts/<full id>', () => {
    render();
    expect(hrefForText(CTX_ID.slice(0, 8))).toBe(`/contexts/${CTX_ID}`);
  });

  it("a context typed 'decision' links to /contexts/, NEVER /decisions/", () => {
    render();
    const href = hrefForText(CTX_TYPED_DECISION_ID.slice(0, 8));
    expect(href).toBe(`/contexts/${CTX_TYPED_DECISION_ID}`);
    expect(href).not.toBe(`/decisions/${CTX_TYPED_DECISION_ID}`);
  });

  it('a real decision links to /decisions/<full id>', () => {
    render();
    expect(hrefForText(DEC_ID.slice(0, 8))).toBe(`/decisions/${DEC_ID}`);
  });

  it('a task links to /tasks/<full id>', () => {
    render();
    expect(hrefForText(TASK_ID.slice(0, 8))).toBe(`/tasks/${TASK_ID}`);
  });

  it('a commit sha renders, and renders UNLINKED', () => {
    render();
    expect(container.textContent).toContain('df5fd78');
    expect(anchors().map((a) => a.text)).not.toContain('df5fd78');
  });

  it('each link is a real anchor with an href and an accessible name', () => {
    render();
    const el = Array.from(container.querySelectorAll('a')).find(
      (a) => (a.textContent ?? '').trim() === TASK_ID.slice(0, 8),
    );
    expect(el).toBeTruthy();
    // An <a> is keyboard-focusable only when it carries an href, and the visible text is
    // an opaque 8-char id, so the name has to come from somewhere.
    expect(el!.getAttribute('href')).toBeTruthy();
    expect(el!.getAttribute('aria-label')).toContain('task');
  });
});

describe('the ABSENT and EMPTY populations', () => {
  it('a detail with no activity at all renders no links and does not throw', () => {
    mockDetail.mockReturnValue({
      data: { id: ROW.id, contexts: [], decisions: [], tasks: [], linked_commits: [] },
      isLoading: false,
      isError: false,
      error: null,
    });
    renderStreamCard();
    expect(anchors()).toEqual([]);
  });

  it('a record row with an empty id produces no link', () => {
    const events = buildTimeline({
      contexts: [{ id: '', context_type: 'milestone', content: 'x', created_at: AT }],
    } as unknown as SessionDetail);
    expect(events[0].idShort).toBeUndefined();
    act(() => {
      root.render(
        <MemoryRouter>
          <TimelinePanel
            detail={
              {
                contexts: [{ id: '', context_type: 'milestone', content: 'x', created_at: AT }],
              } as never
            }
          />
        </MemoryRouter>,
      );
    });
    expect(anchors()).toEqual([]);
  });
});
