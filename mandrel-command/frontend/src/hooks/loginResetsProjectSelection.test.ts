/**
 * useLogin — a FRESH LOGIN opens on the Settings default.
 *
 * Logout already drops the topbar selection through `resetAuthState`
 * (hooks/logoutClearsProjectScope.test.ts). This covers the path that does NOT go through
 * it: the 401 self-heal in services/api.ts removes the token and does
 * `window.location.href = '/login'` — a same-tab reload, which localStorage survives.
 * Without a reset on the way IN, the next login would inherit the previous pick.
 *
 * Drives the real `useLogin` mutation with its one network call stubbed (the login
 * response is irrelevant here; `onSuccess` fires either way), and reads the real store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PROJECT_A = 'aaaaaaaa-1111-4111-8111-111111111111';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useLogin — the selection does not survive into the next login', () => {
  it('after the real login mutation succeeds, the switch holds nothing', async () => {
    vi.doMock('../api/domains/auth', () => ({
      authApi: {
        login: vi.fn(async () => ({
          token: 'a.token.value',
          user: { id: 'user-b', username: 'b' },
        })),
      },
    }));
    vi.resetModules();

    const React = (await import('react')).default;
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { useLogin } = await import('./useAuth');
    const store = await import('../stores/projectSelectionStore');

    // The previous session's pick, as localStorage would still hold it after the
    // self-heal reload — written through the FRESHLY imported module instance.
    store.useProjectSelectionStore.getState().select(PROJECT_A);
    expect(store.useProjectSelectionStore.getState().selectedProjectId).toBe(PROJECT_A);
    expect(localStorage.getItem(store.PROJECT_SELECTION_STORAGE_KEY) ?? '').toContain(PROJECT_A);

    let login: { mutateAsync: (c: unknown) => Promise<unknown> } | undefined;
    const Probe: React.FC = () => {
      login = useLogin() as unknown as { mutateAsync: (c: unknown) => Promise<unknown> };
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    await act(async () => {
      await login!.mutateAsync({ username: 'b', password: 'x' });
    });

    expect(store.useProjectSelectionStore.getState().selectedProjectId).toBeUndefined();
    expect(localStorage.getItem(store.PROJECT_SELECTION_STORAGE_KEY) ?? '').not.toContain(PROJECT_A);

    await act(async () => root.unmount());
    container.remove();
  });
});
