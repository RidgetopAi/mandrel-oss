/**
 * Settings data hooks — every WRITE rides the UNIFIED client (`api.<domain>.*`) through
 * react-query, mirroring the Decisions/Contexts reference. NO axios / generated clients
 * and NO raw `fetch` here (the legacy Settings page hand-rolled fetch calls — that's what
 * this rebuild retires).
 *
 * Grounded against the real backend routes:
 *   • useUpdateProfile   → PUT   /api/users/profile          (api.users.updateProfile)
 *   • useChangePassword  → POST  /api/users/change-password  (api.users.changePassword)
 *   • useUpdateTheme     → PATCH /api/users/preferences      (api.users.updatePreferences)
 *   • useRevokeSessions  → POST  /api/users/revoke-sessions  (api.users.revokeSessions)
 *   • useDeleteProject   → DELETE /api/projects/:id          (api.projects.remove)
 *
 * DELETED HERE (epic 41293984 §A): `useSetPrimaryProject` / `useClearPrimaryProject`.
 * They wrote `projects.metadata.is_primary` — an INSTANCE-WIDE flag, so one user setting
 * "their" default set it for everyone, and `clearPrimary` cleared it for everyone with no
 * user scoping in the SQL at all. The default project is now a per-user preference
 * (`PATCH /api/users/preferences`), written through SettingsContext.setDefaultProjectId,
 * which is the ONE writer. The endpoints themselves are NOT deleted — they have non-UI
 * consumers (mcp-server bootstrap) — but nothing in this UI calls them any more, and
 * leaving unused hooks here is how the next author reintroduces the instance-wide write.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { ProfileUpdate } from '../../api/domains/users';

/** PUT /api/users/profile — update username / email, then refresh the cached profile. */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: ProfileUpdate) => api.users.updateProfile(updates),
    onSuccess: (user) => {
      // Keep the app's auth profile query in lock-step with the saved values.
      qc.setQueryData(['auth', 'profile'], user);
      qc.invalidateQueries({ queryKey: ['auth', 'profile'] });
    },
  });
}

/** POST /api/users/change-password — the server re-validates strength + current password. */
export function useChangePassword() {
  return useMutation({
    mutationFn: ({
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    }) => api.users.changePassword(currentPassword, newPassword),
  });
}

/** PATCH /api/users/preferences — persist the theme choice (light | dark). */
export function useUpdateTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (theme: 'light' | 'dark') => api.users.updatePreferences({ theme }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth', 'profile'] });
    },
  });
}

/** POST /api/users/revoke-sessions — log out every device (self-invalidating). */
export function useRevokeSessions() {
  return useMutation({
    mutationFn: () => api.users.revokeSessions(),
  });
}

/**
 * DELETE /api/projects/:id?confirm=true — irreversible.
 *
 * `confirm` is sent because DangerZoneSection only reaches this hook AFTER the user has
 * typed the project name into the confirm modal. That modal is a UX affordance, not the
 * gate: the real gate is server-side (an earlier task — the mcp-server `project_delete`
 * survey), which refuses with 409 + the measured blast radius when the flag is absent.
 * If this flag were ever dropped by a refactor the delete would start FAILING LOUDLY with
 * the impact counts instead of silently destroying the project — which is exactly the
 * property that was missing before.
 */
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.projects.remove(projectId, { confirm: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
