/**
 * auth domain — the live-wired flow on the unified client.
 *
 * Proves the four auth methods hit the right `/api/auth/*` paths through the ONE
 * shared transport and correctly shape their results:
 *   - login() returns the raw `{ user, token }` body (no envelope),
 *   - profile() UNWRAPS the `{ data: { user } }` envelope to the User, and throws
 *     when the profile payload is missing,
 *   - logout()/refresh() route to their paths.
 * This is the coverage migrated off the generated AuthenticationService when
 * useAuth moved onto api.auth.
 */
import { authApi } from './auth';
import { http } from '../request';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authApi', () => {
  test('login() POSTs /auth/login and returns the raw body', async () => {
    const spy = vi
      .spyOn(http, 'post')
      .mockResolvedValue({ user: { id: 'u1' }, token: 'jwt' } as never);
    const out = await authApi.login({ username: 'operator', password: 'pw' });
    expect(spy.mock.calls[0][0]).toBe('/auth/login');
    expect(out).toEqual({ user: { id: 'u1' }, token: 'jwt' });
  });

  test('profile() GETs /auth/profile and unwraps data.user', async () => {
    const spy = vi
      .spyOn(http, 'get')
      .mockResolvedValue({ success: true, data: { user: { id: 'u1', username: 'operator' } } } as never);
    const user = await authApi.profile();
    expect(spy.mock.calls[0][0]).toBe('/auth/profile');
    expect(user).toEqual({ id: 'u1', username: 'operator' });
  });

  test('profile() throws when the user payload is missing (dead/blank profile)', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: {} } as never);
    await expect(authApi.profile()).rejects.toThrow('Invalid profile response');
  });

  test('logout() POSTs /auth/logout', async () => {
    const spy = vi.spyOn(http, 'post').mockResolvedValue({ success: true } as never);
    await authApi.logout();
    expect(spy.mock.calls[0][0]).toBe('/auth/logout');
  });

  test('refresh() POSTs /auth/refresh and returns the new token', async () => {
    const spy = vi
      .spyOn(http, 'post')
      .mockResolvedValue({ data: { token: 'new-jwt', expires_at: '2026' } } as never);
    const out = await authApi.refresh();
    expect(spy.mock.calls[0][0]).toBe('/auth/refresh');
    expect(out).toEqual({ token: 'new-jwt', expiresAt: '2026' });
  });
});
