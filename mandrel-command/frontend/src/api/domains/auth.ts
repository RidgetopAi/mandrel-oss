/**
 * auth domain — login / logout / profile / refresh, on the unified client.
 *
 * All four ride the shared axios instance (bearer token + interceptors), so the
 * DISCRIMINATING 401 force-logout now covers the auth-critical
 * calls uniformly. Response shapes reuse the generated OpenAPI models
 * (LoginResponse / ProfileResponse / RefreshTokenResponse / User) — no type info
 * is thrown away by moving off the generated fetch client.
 */
import { http } from '../request';
import type { LoginRequest } from '../generated/models/LoginRequest';
import type { LoginResponse } from '../generated/models/LoginResponse';
import type { ProfileResponse } from '../generated/models/ProfileResponse';
import type { RefreshTokenResponse } from '../generated/models/RefreshTokenResponse';
import type { User } from '../generated/models/User';

export const authApi = {
  /** POST /api/auth/login — returns the raw `{ user, token, expires }` body. */
  login(credentials: LoginRequest): Promise<LoginResponse> {
    return http.post<LoginResponse>('/auth/login', credentials);
  },

  /** POST /api/auth/logout — invalidate the server session. */
  async logout(): Promise<void> {
    await http.post<{ success?: boolean; message?: string }>('/auth/logout');
  },

  /** GET /api/auth/profile — the current user, unwrapped from the profile envelope. */
  async profile(): Promise<User> {
    const body = await http.get<ProfileResponse>('/auth/profile');
    const user = body.data?.user;
    if (!user) {
      throw new Error('Invalid profile response');
    }
    return user;
  },

  /** POST /api/auth/refresh — a fresh JWT (server-driven; no client auto-refresh loop). */
  async refresh(): Promise<{ token?: string; expiresAt?: string }> {
    const body = await http.post<RefreshTokenResponse>('/auth/refresh');
    return { token: body.data?.token, expiresAt: body.data?.expires_at };
  },
};

export type AuthApi = typeof authApi;
