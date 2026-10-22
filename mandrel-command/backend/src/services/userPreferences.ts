/**
 * userPreferences — the per-user preference row on `admin_users` (theme +
 * default_project_id). Epic 41293984 §A.
 *
 * ── WHY A SERVICE AND NOT INLINE IN THE ROUTE ────────────────────────────────────────
 * Setting a default project is an AUTHORIZATION decision, not a form field. "May this
 * user pin THIS project as their default?" is the same question the F-04 middleware asks
 * of `X-Project-ID`, and it has exactly one correct answer source: ProjectAccessService
 * (migration 075's grant table + the admin bypass). Putting the decision here means the
 * route cannot express it a second, subtly-different way, and means the rule is testable
 * against a real migrated DB without standing up Express (C3: anchor on the choke point).
 *
 * ── THE ORDER OF THE CHECKS IS LOAD-BEARING ──────────────────────────────────────────
 *   1. UUID shape        -> 'invalid'    (400)
 *   2. may the user see it? -> 'forbidden' (403)
 *   3. does it exist?    -> 'not-found'  (404)
 *
 * ACCESS IS CHECKED BEFORE EXISTENCE ON PURPOSE. A non-admin has no grant row for a
 * project that does not exist, so step 2 already answers 'forbidden' and the caller never
 * learns whether the id names a real project — no existence oracle. An ADMIN bypasses
 * step 2 by definition, so for an admin step 3 is reachable and returns an honest 404.
 * Reversing these two would turn 404 into an enumeration oracle for every user.
 *
 * ── THREE STATES, NOT TWO (C1) ───────────────────────────────────────────────────────
 * A DB error THROWS out of here. It is never mapped onto 'forbidden' (which would read as
 * a decision nobody made) or onto success. The route turns the throw into a 500. "Could
 * not measure" gets its own path, and that path never writes.
 *
 * ── NULL IS A REAL VALUE ─────────────────────────────────────────────────────────────
 * `defaultProjectId: null` CLEARS the preference and is always allowed — clearing your own
 * preference needs no project authorization because it names no project. This is the
 * "empty population" C3 asks you to probe, and it is why the signature takes
 * `string | null` rather than `string | undefined`: undefined means "the caller did not
 * mention this field, leave it alone", null means "clear it". Collapsing those two is how
 * a theme-only PATCH would silently wipe somebody's default project.
 */

import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import { isValidUuid } from '../utils/uuid';
import { ProjectAccessService, type ProjectAccessUser } from './projectAccess';

/** The preference shape the API reads and writes. */
export interface UserPreferences {
  theme: string | null;
  defaultProjectId: string | null;
}

/**
 * Why a default-project write was refused. Every value maps to exactly one HTTP status
 * in the route; there is deliberately no catch-all, so a new reason cannot be added
 * without the route being forced to decide what it means.
 */
export type DefaultProjectRejection = 'invalid' | 'forbidden' | 'not-found';

export type DefaultProjectCheck =
  | { ok: true }
  | { ok: false; reason: DefaultProjectRejection };

/** A theme value the `admin_users_theme_check` constraint accepts (migration 001). */
export const VALID_THEMES = ['light', 'dark'] as const;
export type Theme = (typeof VALID_THEMES)[number];

export const isValidTheme = (value: unknown): value is Theme =>
  typeof value === 'string' && (VALID_THEMES as readonly string[]).includes(value);

export class UserPreferencesService {
  /** Read this user's preferences. `null` when the user row does not exist. */
  static async get(userId: string): Promise<UserPreferences | null> {
    const result = await pool.query(
      'SELECT theme, default_project_id FROM admin_users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return {
      theme: result.rows[0].theme ?? null,
      defaultProjectId: result.rows[0].default_project_id ?? null,
    };
  }

  /**
   * May `user` pin `projectId` as their default? See the module header for why the
   * checks run in this order. Clearing (`null`) is not routed here — it names no
   * project, so there is nothing to authorize.
   */
  static async mayUseAsDefault(
    user: ProjectAccessUser,
    projectId: string
  ): Promise<DefaultProjectCheck> {
    if (!isValidUuid(projectId)) {
      return { ok: false, reason: 'invalid' };
    }

    // 1. AUTHORIZATION — the SAME path the F-04 middleware uses. Not a second copy.
    const allowed = await ProjectAccessService.userHasProjectAccess(user, projectId);
    if (!allowed) {
      return { ok: false, reason: 'forbidden' };
    }

    // 2. EXISTENCE — only reachable by a principal already authorized for the id
    //    (in practice: an admin, who bypasses the grant table).
    const resolved = await ProjectAccessService.resolveProjectId(projectId);
    if (!resolved) {
      return { ok: false, reason: 'not-found' };
    }

    return { ok: true };
  }

  /**
   * Persist preferences. Fields left `undefined` are NOT touched; `defaultProjectId: null`
   * clears the default. Returns the resulting row, or `null` when the user does not exist.
   *
   * This method does NOT authorize — callers MUST have passed `mayUseAsDefault` first.
   * It is separated so the authorization decision has exactly one implementation and the
   * write has exactly one implementation, rather than one function that can be called in
   * a way that skips half of itself.
   */
  static async update(
    userId: string,
    updates: { theme?: Theme; defaultProjectId?: string | null }
  ): Promise<UserPreferences | null> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.theme !== undefined) {
      values.push(updates.theme);
      sets.push(`theme = $${values.length}`);
    }
    if (updates.defaultProjectId !== undefined) {
      values.push(updates.defaultProjectId);
      sets.push(`default_project_id = $${values.length}`);
    }

    if (sets.length === 0) {
      // Nothing to write — read back rather than issuing a no-op UPDATE.
      return UserPreferencesService.get(userId);
    }

    values.push(userId);
    const result = await pool.query(
      `UPDATE admin_users
          SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${values.length}
        RETURNING theme, default_project_id`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    logger.info('[userPreferences] updated', {
      userId,
      fields: Object.keys(updates).filter(
        (k) => (updates as Record<string, unknown>)[k] !== undefined
      ),
    });

    return {
      theme: result.rows[0].theme ?? null,
      defaultProjectId: result.rows[0].default_project_id ?? null,
    };
  }
}
