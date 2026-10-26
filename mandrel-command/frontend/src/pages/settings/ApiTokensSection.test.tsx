/**
 * Settings → API tokens — the REAL section driven the way a user drives it,
 * with only the `api` boundary mocked.
 *
 *   create → the show-once modal holds the token, Copy writes it to the clipboard, and
 *            "I've stored it" removes it from the DOM AND from react-query's caches;
 *   list   → name, prefix, last used ("Never" for the ZERO member) — never a plaintext;
 *   revoke → nothing is revoked until the confirm modal's Revoke is pressed, and then
 *            exactly the chosen id is sent;
 *   errors → a 409 cap message from the server is shown, and no modal opens;
 *   role   → a non-admin sees the admins-only explanation and the list is never requested.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../api', () => ({
  api: { apiTokens: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() } },
}));

const authUser: { current: { username: string; role: 'admin' | 'user' } } = {
  current: { username: 'operator', role: 'admin' },
};
vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({ user: authUser.current }),
}));

import { ApiTokensSection } from './ApiTokensSection';
import { api } from '../../api';

const mock = (api as unknown as {
  apiTokens: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
}).apiTokens;

/** Self-labelling fixture: mocked api, authenticates nothing. */
const PLAINTEXT = 'mdl_not-a-real-token-test-fixture-0000000000000';

const EXISTING = {
  id: 'tok-1',
  name: 'old laptop',
  prefix: 'mdl_OldOld12',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Poll (flushing React) until `probe` is truthy — never a fixed number of ticks. */
async function waitFor<T>(probe: () => T | null | undefined | false, what: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

const rowWith = (text: string) =>
  Array.from(container.querySelectorAll('tr')).find((tr) => (tr.textContent ?? '').includes(text));

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <ApiTokensSection />
      </QueryClientProvider>,
    );
  });
  await flush();
}

const buttons = () => Array.from(document.body.querySelectorAll('button'));
const button = (text: string) => {
  const b = buttons().find((x) => (x.textContent ?? '').trim() === text);
  if (!b) throw new Error(`button "${text}" not found; have: ${buttons().map((x) => x.textContent).join(' | ')}`);
  return b;
};
async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}
async function typeName(value: string) {
  const input = container.querySelector('input[aria-label="Token name"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submitCreate() {
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  authUser.current = { username: 'operator', role: 'admin' };
  mock.list.mockResolvedValue([EXISTING]);
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ApiTokensSection — list', () => {
  it('shows name, display prefix and "Never" for an unused token', async () => {
    await mount();
    const row = await waitFor(() => rowWith('old laptop'), 'the token row');
    expect(mock.list).toHaveBeenCalled();
    expect(row.textContent).toContain('mdl_OldOld12');
    expect(row.textContent).toContain('Never');
  });

  it('the ZERO member: no tokens renders the empty state, not an error', async () => {
    mock.list.mockResolvedValue([]);
    await mount();
    await waitFor(() => rowWith('No tokens yet'), 'the empty-state row');
  });
});

describe('ApiTokensSection — create shows the token ONCE', () => {
  it('create → modal with the token → Copy → "I\'ve stored it" drops it everywhere', async () => {
    mock.create.mockResolvedValue({
      plaintext: PLAINTEXT,
      token: { ...EXISTING, id: 'tok-2', name: 'loop on laptop', prefix: PLAINTEXT.slice(0, 12) },
    });
    await mount();
    await typeName('  loop on laptop  ');
    await submitCreate();

    expect(mock.create).toHaveBeenCalledWith('loop on laptop');
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    const field = dialog.querySelector('input[aria-label="API token"]') as HTMLInputElement;
    expect(field.value).toBe(PLAINTEXT);
    expect(field.readOnly).toBe(true);

    await click(button('Copy'));
    expect(writeText).toHaveBeenCalledWith(PLAINTEXT);
    expect(button('Copied')).toBeTruthy();

    // The mutation cache must not be holding the plaintext even while the modal is open.
    const mutationData = client.getMutationCache().getAll().map((m) => JSON.stringify(m.state.data ?? null));
    expect(mutationData.some((d) => d.includes(PLAINTEXT))).toBe(false);

    await click(button("I've stored it"));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.innerHTML.includes(PLAINTEXT)).toBe(false);
    const queryData = client.getQueryCache().getAll().map((q) => JSON.stringify(q.state.data ?? null));
    expect(queryData.some((d) => d.includes(PLAINTEXT))).toBe(false);
  });

  it('when the clipboard is unavailable, Copy says so instead of claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    mock.create.mockResolvedValue({ plaintext: PLAINTEXT, token: { ...EXISTING, id: 'tok-3' } });
    await mount();
    await typeName('x');
    await submitCreate();
    await click(button('Copy'));
    expect(document.body.textContent).toContain("Couldn't reach the clipboard");
    expect(buttons().some((b) => b.textContent === 'Copied')).toBe(false);
  });

  it('a blank name never calls the API', async () => {
    await mount();
    await typeName('   ');
    await submitCreate();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('a server refusal (the per-user cap) is shown and no modal opens', async () => {
    mock.create.mockRejectedValue(
      Object.assign(new Error('You already have 20 active tokens. Revoke one before creating another.'), {
        response: { status: 409 },
      }),
    );
    await mount();
    await typeName('one too many');
    await submitCreate();
    expect(container.textContent).toContain("Couldn't create the token");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('ApiTokensSection — admins only', () => {
  it('a non-admin sees the explanation, no create control, and the list is never requested', async () => {
    authUser.current = { username: 'pat', role: 'user' };
    await mount();
    expect(container.textContent).toContain('only an admin can create them');
    expect(container.querySelector('input[aria-label="Token name"]')).toBeNull();
    expect(buttons().some((b) => (b.textContent ?? '').trim() === 'Create token')).toBe(false);
    expect(mock.list).not.toHaveBeenCalled();
  });

  it('CONTROL: an admin gets the controls and the list', async () => {
    await mount();
    expect(container.querySelector('input[aria-label="Token name"]')).not.toBeNull();
    expect(mock.list).toHaveBeenCalled();
  });
});

describe('ApiTokensSection — revoke asks first', () => {
  it('Revoke opens a confirm; only the confirm sends the chosen id', async () => {
    mock.revoke.mockResolvedValue(undefined);
    await mount();
    await waitFor(() => document.body.querySelector('button[aria-label="Revoke old laptop"]'), 'the revoke button');
    const rowRevoke = document.body.querySelector('button[aria-label="Revoke old laptop"]') as HTMLButtonElement;
    await click(rowRevoke);
    expect(mock.revoke).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('old laptop');

    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Revoke')!;
    await click(confirm);
    expect(mock.revoke).toHaveBeenCalledTimes(1);
    expect(mock.revoke).toHaveBeenCalledWith('tok-1');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Cancel revokes nothing', async () => {
    await mount();
    await waitFor(() => document.body.querySelector('button[aria-label="Revoke old laptop"]'), 'the revoke button');
    await click(document.body.querySelector('button[aria-label="Revoke old laptop"]') as HTMLButtonElement);
    await click(button('Cancel'));
    expect(mock.revoke).not.toHaveBeenCalled();
  });
});
