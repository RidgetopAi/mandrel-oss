/**
 * DecisionInbox render tests. Mirrors the
 * Decisions page's test style: createRoot + async act into jsdom, behind
 * QueryClientProvider + MemoryRouter, with the UNIFIED `api` client mocked.
 *
 * Proves the punch's DONE WHEN 1-4:
 *  1. two open decisions render as exactly two cards, headlined by their QUESTION, each
 *     option showing label/pros/cons and the recommended marker where set;
 *  2. selecting an option enables Decide; Decide calls the answer endpoint with the option
 *     key + note, and the card is removed on success with a confirmation naming the label;
 *  3. Discuss calls the discuss endpoint; the card gains the discussing badge and stays;
 *  4. a mocked API refusal renders its message verbatim on the card.
 * (DONE WHEN 5 — the nav badge — is exercised in components/shell/shell.test.tsx, co-located
 * with the Sidebar it renders on.)
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    decisions: {
      search: vi.fn(),
      answer: vi.fn(),
      discuss: vi.fn(),
    },
  },
}));

const PAGE_PROJECT = { id: 'aaaaaaaa-0000-4000-8000-aaaaaaaa0001', name: 'riverbend' };
const projectState = vi.hoisted(() => ({
  projects: [] as { id: string; name: string }[],
  defaultProjectId: undefined as string | undefined,
}));
vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({
    setSelectedProjectId: () => undefined,
    currentProject: null,
    allProjects: projectState.projects,
    loading: false,
    selectedProjectId: projectState.defaultProjectId,
    projectsUnavailable: false,
  }),
  useEffectiveProjectId: () => projectState.defaultProjectId,
}));
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: projectState.defaultProjectId }),
}));

import DecisionInbox from './DecisionInbox';
import { api } from '../api';

const mockApi = api as unknown as {
  decisions: {
    search: ReturnType<typeof vi.fn>;
    answer: ReturnType<typeof vi.fn>;
    discuss: ReturnType<typeof vi.fn>;
  };
};

const DEC_OPEN_1 = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  project_id: PAGE_PROJECT.id,
  title: 'Embeddings datastore',
  question: 'Which datastore should we use for embeddings?',
  answerStatus: 'open',
  options: [
    {
      key: 'postgres',
      label: 'Stick with Postgres',
      pros: ['No new infra'],
      cons: ['Scaling ceiling'],
      recommended: true,
    },
    {
      key: 'dedicated',
      label: 'Dedicated vector DB',
      pros: ['Purpose-built'],
      cons: ['New infra to run'],
    },
  ],
  chosen: null,
  deadline: null,
  created_at: '2026-09-01T00:00:00.000Z',
};

const DEC_OPEN_2 = {
  id: 'bbbbbbbb-1111-2222-3333-444444444444',
  project_id: PAGE_PROJECT.id,
  title: 'Deploy target',
  question: 'Where should the new worker run?',
  answerStatus: 'open',
  options: [
    { key: 'ecs', label: 'ECS', pros: ['Already running there'], cons: ['Slower cold start'] },
    { key: 'lambda', label: 'Lambda', pros: ['Cheaper idle'], cons: ['Cold starts'] },
  ],
  chosen: null,
  deadline: null,
  created_at: '2026-09-02T00:00:00.000Z',
};

function setHappy() {
  mockApi.decisions.search.mockImplementation((params: { answerStatus?: string }) => {
    if (params.answerStatus === 'open') {
      return Promise.resolve({ decisions: [DEC_OPEN_1, DEC_OPEN_2], total: 2 });
    }
    return Promise.resolve({ decisions: [], total: 0 });
  });
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DecisionInbox />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function cardFor(id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="decision-inbox-card-${id}"]`);
  if (!el) throw new Error(`card ${id} not found`);
  return el as HTMLElement;
}

function click(el: Element | null) {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The radio input for the option whose visible label CONTAINS `label` (matched via the
 * enclosing <label>, not the `value` attribute — radio DOM-attribute reflection is a
 * spec nuance not worth depending on in a test). */
function radioFor(card: HTMLElement, label: string): HTMLInputElement {
  const radios = Array.from(card.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
  const match = radios.find((r) => (r.closest('label')?.textContent ?? '').includes(label));
  if (!match) throw new Error(`radio "${label}" not found`);
  return match;
}

function findButton(root: ParentNode, label: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  projectState.projects = [PAGE_PROJECT];
  projectState.defaultProjectId = PAGE_PROJECT.id;
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('DecisionInbox — rendering (DONE WHEN 1)', () => {
  it('renders exactly two cards headlined by their question', async () => {
    await mount();
    await settle();
    expect(container.querySelectorAll('[data-testid^="decision-inbox-card-"]')).toHaveLength(2);
    const text = container.textContent ?? '';
    expect(text).toContain('Which datastore should we use for embeddings?');
    expect(text).toContain('Where should the new worker run?');
  });

  it('renders each option with its label, pros, cons, and the recommended marker where set', async () => {
    await mount();
    await settle();
    const card = cardFor(DEC_OPEN_1.id);
    const text = card.textContent ?? '';
    expect(text).toContain('Stick with Postgres');
    expect(text).toContain('No new infra');
    expect(text).toContain('Scaling ceiling');
    expect(text).toContain('Dedicated vector DB');
    expect(text).toContain('Purpose-built');
    expect(text).toContain('New infra to run');
    expect(text).toContain('Recommended');
    // Recommended marks the FIRST option only.
    const badges = Array.from(card.querySelectorAll('*')).filter(
      (el) => (el.textContent ?? '').trim() === 'Recommended',
    );
    expect(badges.length).toBeGreaterThan(0);
  });

  it('never renders a decided decision (only open/discussing are fetched)', async () => {
    await mount();
    await settle();
    expect(mockApi.decisions.search).toHaveBeenCalledWith(
      expect.objectContaining({ answerStatus: 'open' }),
      expect.anything(),
    );
    expect(mockApi.decisions.search).toHaveBeenCalledWith(
      expect.objectContaining({ answerStatus: 'discussing' }),
      expect.anything(),
    );
  });
});

describe('DecisionInbox — Decide (DONE WHEN 2)', () => {
  it('Decide is disabled until an option is selected, then calls answer with the option key + note and removes the card with a confirmation naming the chosen label', async () => {
    await mount();
    await settle();
    const card = cardFor(DEC_OPEN_1.id);
    const decideBtn = findButton(card, 'Decide');
    expect(decideBtn.disabled).toBe(true);

    const radio = radioFor(card, 'Stick with Postgres');
    await act(async () => {
      click(radio);
    });
    expect(decideBtn.disabled).toBe(false);

    const note = card.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(note),
      'value',
    )?.set;
    setter?.call(note, 'cheapest to operate');
    note.dispatchEvent(new Event('input', { bubbles: true }));

    mockApi.decisions.answer.mockResolvedValue({ id: DEC_OPEN_1.id, chosen: 'postgres' });

    await act(async () => {
      click(decideBtn);
    });
    await settle();

    expect(mockApi.decisions.answer).toHaveBeenCalledWith(
      DEC_OPEN_1.id,
      'postgres',
      'cheapest to operate',
      expect.anything(),
    );

    // The card is gone…
    expect(container.querySelector(`[data-testid="decision-inbox-card-${DEC_OPEN_1.id}"]`)).toBeNull();
    // …and a confirmation names the chosen label.
    const text = container.textContent ?? '';
    expect(text).toContain('Stick with Postgres');
    expect(text).toMatch(/Decided/i);
    // The other card is untouched.
    expect(container.querySelector(`[data-testid="decision-inbox-card-${DEC_OPEN_2.id}"]`)).not.toBeNull();
  });
});

describe('DecisionInbox — Discuss (DONE WHEN 3)', () => {
  it('Discuss calls the discuss endpoint and the card gains the discussing badge and stays', async () => {
    await mount();
    await settle();
    const card = cardFor(DEC_OPEN_2.id);
    expect((card.textContent ?? '')).not.toContain('discussing');

    mockApi.decisions.discuss.mockResolvedValue({ id: DEC_OPEN_2.id, answerStatus: 'discussing' });
    const discussBtn = findButton(card, 'Discuss');
    await act(async () => {
      click(discussBtn);
    });
    await settle();

    expect(mockApi.decisions.discuss).toHaveBeenCalledWith(
      DEC_OPEN_2.id,
      undefined,
      expect.anything(),
    );
    // Still present…
    const stillThere = cardFor(DEC_OPEN_2.id);
    // …now carrying the discussing badge.
    expect(stillThere.textContent ?? '').toContain('discussing');
  });
});

describe('DecisionInbox — API refusal (DONE WHEN 4)', () => {
  it('renders the refusal message verbatim on the card', async () => {
    await mount();
    await settle();
    const card = cardFor(DEC_OPEN_1.id);
    const radio = radioFor(card, 'Stick with Postgres');
    await act(async () => {
      click(radio);
    });

    mockApi.decisions.answer.mockRejectedValue({
      message: 'This decision is already decided — refusing to change it.',
    });
    const decideBtn = findButton(card, 'Decide');
    await act(async () => {
      click(decideBtn);
    });
    await settle();

    const stillThere = cardFor(DEC_OPEN_1.id);
    expect(stillThere.textContent ?? '').toContain(
      'This decision is already decided — refusing to change it.',
    );
  });
});
