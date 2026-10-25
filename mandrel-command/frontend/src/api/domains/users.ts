/**
 * users domain — self-service profile / password / preferences / session-revoke
 * (`/api/users/*`, Command backend). Reuses the generated User model.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { User } from '../generated/models/User';

/**
 * The per-user preference row (page-scope epic §A). `defaultProjectId` is a UUID —
 * never a project name — so renaming a project cannot break somebody's default.
 * `null` on either field means "not set", which is a real, expected state.
 */
export interface UserPreferences {
  theme: string | null;
  defaultProjectId: string | null;
}

/** A PATCH body. An ABSENT key is untouched; an explicit `null` clears the value. */
export interface UserPreferencesUpdate {
  theme?: 'light' | 'dark';
  defaultProjectId?: string | null;
}

/**
 * A profile PUT body. `currentPassword` re-verifies the human behind an authenticated
 * session before an identity field moves — a stolen session token alone must not be
 * enough to take over an account.
 */
export type ProfileUpdate = Partial<Pick<User, 'username' | 'email'>> & {
  currentPassword?: string;
};

/** The backend's machine-readable "prompt them for their password" signal. */
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

export const usersApi = {
  /**
   * PUT /api/users/profile
   *
   * `currentPassword` is REQUIRED whenever a value actually changes — the backend
   * answers 401 `code: 'REAUTH_REQUIRED'` without it. It is optional
   * in this type only because a no-op save (nothing dirty) is still a legal call.
   * Never persist or log it; it is passed straight through and discarded.
   */
  async updateProfile(updates: ProfileUpdate): Promise<User> {
    const body = await http.put<ApiEnvelope<{ user?: User }>>('/users/profile', updates);
    const user = unwrapData(body, 'Failed to update profile')?.user;
    if (!user) {
      throw new Error('Profile update payload missing in response');
    }
    return user;
  },

  /** POST /api/users/change-password */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await http.post<ApiEnvelope<unknown>>('/users/change-password', {
      currentPassword,
      newPassword,
    });
  },

  /** GET /api/users/preferences — the CURRENT user's theme + default project. */
  async getPreferences(): Promise<UserPreferences> {
    const body = await http.get<ApiEnvelope<{ preferences?: UserPreferences }>>(
      '/users/preferences'
    );
    const prefs = unwrapData(body, 'Failed to read preferences')?.preferences;
    return { theme: prefs?.theme ?? null, defaultProjectId: prefs?.defaultProjectId ?? null };
  },

  /**
   * PATCH /api/users/preferences — partial update.
   *
   * OMITTING a key leaves it alone; sending `defaultProjectId: null` CLEARS the default.
   * The two are NOT interchangeable — that distinction is enforced end-to-end (see
   * backend services/userPreferences.ts), because collapsing them would make a
   * theme-only save silently wipe the user's default project.
   */
  async updatePreferences(preferences: UserPreferencesUpdate): Promise<UserPreferences> {
    const body = await http.patch<ApiEnvelope<{ preferences?: UserPreferences }>>(
      '/users/preferences',
      preferences
    );
    const prefs = unwrapData(body, 'Failed to update preferences')?.preferences;
    return { theme: prefs?.theme ?? null, defaultProjectId: prefs?.defaultProjectId ?? null };
  },

  /** POST /api/users/revoke-sessions — revoke every JWT session for this user. */
  async revokeSessions(): Promise<void> {
    await http.post<ApiEnvelope<unknown>>('/users/revoke-sessions');
  },
};

export type UsersApi = typeof usersApi;
