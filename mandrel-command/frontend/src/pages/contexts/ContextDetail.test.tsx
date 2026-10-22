/**
 * ContextDetail tests — the in-place (right-column) detail's action wiring. createRoot +
 * async act into jsdom behind QueryClientProvider + MemoryRouter, unified `api` mocked.
 * Proves the ported single-context actions are REAL (not stubs) and SURVIVED the
 * grid+drawer → rail+reader reversal:
 *   - the REQUIRED delete mutation-check: click Delete → confirm → api.contexts.remove is
 *     called with the exact id AND the list query is invalidated (revert the wiring → RED);
 *   - edit mode saves through api.contexts.update;
 *   - the Related section lazy-loads api.contexts.related only when expanded;
 *   - the Metadata section renders the record's metadata.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api', () => ({
  api: {
    contexts: {
      get: vi.fn(),
      links: vi.fn(),
      related: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
    },
  },
}));

import { ContextDetail } from './ContextDetail';
import { api } from '../../api';

const mockApi = api as unknown as {
  contexts: {
    get: ReturnType<typeof vi.fn>;
    links: ReturnType<typeof vi.fn>;
    related: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
  };
};

const NOW = new Date().toISOString();
const CTX = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  context_type: 'milestone',
  type: 'milestone',
  content: 'Sessions screen mock LOCKED — the one true source\n\nbody text',
  tags: ['sessions-mock', 'ref:resume'],
  metadata: { source: 'handoff', phase: 2 },
  created_at: NOW,
  updated_at: NOW,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function setHappy() {
  mockApi.contexts.get.mockResolvedValue(CTX);
  mockApi.contexts.links.mockResolvedValue([]);
  mockApi.contexts.related.mockResolvedValue([]);
  mockApi.contexts.update.mockResolvedValue(CTX);
  mockApi.contexts.remove.mockResolvedValue(undefined);
  mockApi.contexts.restore.mockResolvedValue(undefined);
}

async function mount(onDeleted = vi.fn(), record: Record<string, unknown> = CTX) {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ContextDetail
            id={record.id as string}
            fallback={record as never}
            onDeleted={onDeleted}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return onDeleted;
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

function click(el: Element | null | undefined) {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// The detail renders inline in `container`, but the confirm Modal still portals to
// document.body — so scan the whole document for buttons/content.
/** A real (text) button whose trimmed textContent equals `label`. */
function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined;
}

function buttonByLabel(aria: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === aria,
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ContextDetail — delete (mutation-checked)', () => {
  it('Delete → confirm calls api.contexts.remove with the exact id + invalidates the list', async () => {
    const onDeleted = await mount();
    await settle();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    // Open the confirm modal from the header trash action.
    await act(async () => click(buttonByLabel('Delete context')));
    await settle();

    // Confirm modal's danger button (text "Delete", distinct from the icon-only trigger).
    const confirm = buttonByText('Delete');
    expect(confirm).toBeTruthy();
    await act(async () => click(confirm));
    await settle();

    expect(mockApi.contexts.remove).toHaveBeenCalledTimes(1);
    expect(mockApi.contexts.remove).toHaveBeenCalledWith(CTX.id);
    // list invalidated so the deleted row drops out of the rail
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['contexts', 'list'] });
    // the page is told to deselect (the record is gone — don't sit on a dead id)
    expect(onDeleted).toHaveBeenCalled();
  });

  it('does NOT delete until the confirm is clicked (guarded action)', async () => {
    await mount();
    await settle();
    await act(async () => click(buttonByLabel('Delete context'))); // opens confirm only
    await settle();
    expect(mockApi.contexts.remove).not.toHaveBeenCalled();
  });
});

describe('ContextDetail — edit', () => {
  it('Edit → Save writes content + tags through api.contexts.update', async () => {
    await mount();
    await settle();
    await act(async () => click(buttonByLabel('Edit context')));
    await settle();
    const save = buttonByText('Save changes');
    expect(save).toBeTruthy();
    await act(async () => click(save));
    await settle();
    expect(mockApi.contexts.update).toHaveBeenCalledTimes(1);
    expect(mockApi.contexts.update).toHaveBeenCalledWith(
      CTX.id,
      expect.objectContaining({ content: CTX.content, tags: CTX.tags }),
    );
  });
});

describe('ContextDetail — related (lazy) + metadata', () => {
  it('does not call related() until the Related section is expanded', async () => {
    await mount();
    await settle();
    expect(mockApi.contexts.related).not.toHaveBeenCalled();
    await act(async () => click(buttonByLabel('Related')));
    await settle();
    expect(mockApi.contexts.related).toHaveBeenCalledWith(CTX.id);
  });

  it('renders the record metadata when the Metadata section is expanded', async () => {
    await mount();
    await settle();
    await act(async () => click(buttonByLabel('Metadata')));
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain('source');
    expect(text).toContain('handoff');
  });
});

/**
 * THE UNDO SURFACE. The Command UI delete used to DESTROY the row, so a
 * user who deleted a context by mistake had nothing to click and nothing to recover. The
 * row now survives as `archived_at`, and the reader is where that becomes reachable —
 * the LIST hides archived rows, so the reader is the only place a user meets one.
 *
 * SMALLEST DIVERGING INPUT: the SAME component, the SAME id, differing only in whether
 * `archived_at` is set. Everything else is held constant, so a green here cannot come
 * from a render that failed, an empty record, or the wrong query.
 */
describe('ContextDetail — an archived context offers Restore, not Delete', () => {
  const ARCHIVED = { ...CTX, archived_at: new Date().toISOString() };

  it('a LIVE context shows Delete and no restore banner (the positive control)', async () => {
    mockApi.contexts.get.mockResolvedValue(CTX);
    await mount(vi.fn(), CTX);
    await settle();

    expect(buttonByLabel('Delete context')).toBeTruthy();
    expect(buttonByText('Restore')).toBeFalsy();
  });

  it('an ARCHIVED context hides Delete and offers Restore instead', async () => {
    mockApi.contexts.get.mockResolvedValue(ARCHIVED);
    await mount(vi.fn(), ARCHIVED);
    await settle();

    expect(buttonByLabel('Delete context')).toBeFalsy();
    expect(buttonByText('Restore')).toBeTruthy();
  });

  it('Restore calls api.contexts.restore with the exact id and invalidates the list + detail', async () => {
    mockApi.contexts.get.mockResolvedValue(ARCHIVED);
    await mount(vi.fn(), ARCHIVED);
    await settle();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    await act(async () => click(buttonByText('Restore')));
    await settle();

    expect(mockApi.contexts.restore).toHaveBeenCalledTimes(1);
    expect(mockApi.contexts.restore).toHaveBeenCalledWith(ARCHIVED.id);

    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(keys.some((k) => k.includes('"list"'))).toBe(true);
    // The DETAIL must be invalidated too, or the banner would survive its own undo.
    expect(keys.some((k) => k.includes('"detail"'))).toBe(true);
  });
});
