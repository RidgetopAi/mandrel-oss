import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { UserService, validateUsername, validateEmail } from '../services/user';
import { AuthService } from '../services/auth';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { ProjectAccessService } from '../services/projectAccess';
import { UserPreferencesService, isValidTheme } from '../services/userPreferences';
import { isValidUuid } from '../utils/uuid';
import { AuthenticatedRequest } from '../types/auth';
import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';

const router = Router();

/**
 * Rate limit for identity changes (issue 2).
 *
 * The uniqueness check on this endpoint answers "is this handle free RIGHT NOW". Without a
 * limit, an attacker who wants a SPECIFIC handle can poll it cheaply until the victim
 * vacates it — the claiming half of the feedback-ownership exploit. A profile edit is a
 * human action performed a handful of times a year; a low ceiling costs a real user
 * nothing and takes handle-sniping off the table.
 *
 * Keyed by the default (client IP) rather than by user id ON PURPOSE: the attacker
 * controls which account they are logged in as, so a per-user key is trivially reset by
 * rotating accounts, while the IP is the resource actually being spent.
 */
export const PROFILE_UPDATE_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  max: 10,
} as const;

const profileUpdateLimiter = rateLimit({
  windowMs: PROFILE_UPDATE_RATE_LIMIT.windowMs,
  max: PROFILE_UPDATE_RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Profile update rate limit reached', { ip: req.ip, path: req.path });
    res.status(429).json({
      success: false,
      error: 'Too Many Requests',
      message: 'Too many profile updates. Please try again later.',
    });
  },
});

/**
 * PUT /api/users/profile
 * Update current user's profile (username and/or email).
 *
 * ── THREE SEPARATE DEFECTS WERE FIXED HERE ──────────────────────────────
 *
 * 1. NO RE-AUTHENTICATION. `authenticateToken` proves you hold a session; it does not
 *    prove you are the human who owns it. Renaming the handle an account is known by is
 *    an identity-level act, and an attacker with a hijacked session could do it with no
 *    secret they did not already have. `currentPassword` is now REQUIRED whenever a value
 *    actually CHANGES — a no-op PUT still succeeds, so a client that re-submits unchanged
 *    fields is not forced to collect a password for nothing.
 *
 * 2. NO RATE LIMIT. See `profileUpdateLimiter` above.
 *
 * 3. NO FORMAT VALIDATION. Any non-empty string was stored verbatim, so whitespace was
 *    preserved and the exact-match uniqueness check let "Operator" and "operator" coexist. See
 *    `validateUsername` / `UserService.isUsernameTaken` in services/user.ts.
 *
 * ⚠️ CLIENT CONTRACT CHANGE: a real change now requires `currentPassword` in the body and
 * answers 401 `code: 'REAUTH_REQUIRED'` without it. The code is machine-readable so a UI
 * can prompt for the password rather than showing a generic failure.
 */
router.put('/profile',
  profileUpdateLimiter,
  authenticateToken,
  declareAnyAuthenticatedMayWrite('a user editing their OWN profile, re-verified with their current password'),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
      return;
    }

    const { username, email, currentPassword } = req.body ?? {};

    // Validate input
    if (username === undefined && email === undefined) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'At least one field (username or email) must be provided'
      });
      return;
    }

    // FORMAT VALIDATION (issue 3) — before anything touches the database, and before the
    // password is checked, so a malformed request cannot be used as a password oracle.
    let nextUsername: string | undefined;
    if (username !== undefined) {
      const check = validateUsername(username);
      if (!check.ok) {
        res.status(400).json({ success: false, error: 'Bad Request', message: check.error });
        return;
      }
      nextUsername = check.value;
    }

    let nextEmail: string | undefined;
    if (email !== undefined) {
      const check = validateEmail(email);
      if (!check.ok) {
        res.status(400).json({ success: false, error: 'Bad Request', message: check.error });
        return;
      }
      nextEmail = check.value;
    }

    // What is actually CHANGING. A PUT that restates the current values is a no-op and
    // needs no password; anything else is an identity change and does.
    const current = await UserService.getUserById(userId);
    if (!current) {
      res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'User not found'
      });
      return;
    }

    const usernameChanging = nextUsername !== undefined && nextUsername !== current.username;
    const emailChanging = nextEmail !== undefined && nextEmail !== current.email;

    if ((usernameChanging || emailChanging) && current.auth_user_id) {
      // ONE LOGIN: this row signs in through better-auth, which owns the
      // email it signs in with. Changing the dashboard copy would split the two, and the row
      // may hold no dashboard password to re-verify against. Refused, and said so — not a
      // REAUTH_REQUIRED that no password could ever satisfy.
      res.status(409).json({
        success: false,
        error: 'Conflict',
        code: 'SIGN_IN_MANAGED',
        message: 'This account signs in with your Mandrel sign-in; its username and email cannot be changed here.'
      });
      return;
    }

    if (usernameChanging || emailChanging) {
      // RE-AUTHENTICATION (issue 1).
      const reauthed = await UserService.verifyCurrentPassword(userId, currentPassword);
      if (!reauthed) {
        logger.warn('Profile update refused: re-authentication failed', {
          userId,
          ip: req.ip,
          fields: { username: usernameChanging, email: emailChanging },
        });
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          code: 'REAUTH_REQUIRED',
          message: 'Your current password is required to change your username or email'
        });
        return;
      }
    }

    // Uniqueness — CASE-INSENSITIVE now (issue 3).
    if (nextUsername !== undefined && usernameChanging && await UserService.isUsernameTaken(nextUsername, userId)) {
      res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Username already taken'
      });
      return;
    }

    if (nextEmail !== undefined && emailChanging && await UserService.isEmailTaken(nextEmail, userId)) {
      res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Email already in use'
      });
      return;
    }

    // Update user with the NORMALISED values (trimmed), never the raw body.
    const updatedUser = await UserService.updateUser(userId, {
      username: nextUsername,
      email: nextEmail,
    });

    if (!updatedUser) {
      res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'User not found'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: { user: updatedUser }
    });
  } catch (error) {
    logger.error('Error updating profile', { error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to update profile'
    });
  }
});

/**
 * POST /api/users/change-password
 * Change current user's password
 */
router.post('/change-password', authenticateToken,
  declareAnyAuthenticatedMayWrite('a user changing their OWN password (current password re-verified in the handler)'),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
      return;
    }

    const { currentPassword, newPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Both currentPassword and newPassword are required'
      });
      return;
    }

    // Validate new password strength
    const passwordValidation = await UserService.validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Password does not meet requirements',
        details: passwordValidation.errors
      });
      return;
    }

    // Update password
    const outcome = await UserService.updatePassword(userId, {
      currentPassword,
      newPassword
    });

    if (outcome === 'managed-by-sign-in') {
      res.status(409).json({
        success: false,
        error: 'Conflict',
        code: 'SIGN_IN_MANAGED',
        message: 'Your password is your Mandrel sign-in password, so it is changed with a set-password link, not here.'
      });
      return;
    }

    if (outcome !== 'changed') {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Current password is incorrect'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    logger.error('Error changing password', { error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to change password'
    });
  }
});

/**
 * GET /api/users/preferences
 * Read the CURRENT user's preferences (theme + default project). The read half of
 * the pair — the Command UI's SettingsContext seeds from this and treats
 * localStorage purely as a cache (an earlier epic §A).
 */
router.get('/preferences', authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
      return;
    }

    const preferences = await UserPreferencesService.get(userId);

    if (!preferences) {
      res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'User not found'
      });
      return;
    }

    res.json({ success: true, data: { preferences } });
  } catch (error) {
    logger.error('Error reading preferences', { error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to read preferences'
    });
  }
});

/**
 * PATCH /api/users/preferences
 * Update the CURRENT user's preferences: `theme` and/or `defaultProjectId`.
 *
 * `defaultProjectId` (an earlier epic §A) is a UUID, or `null` to clear. It replaces the
 * instance-wide `projects.metadata.is_primary` flag as the UI's default-project source:
 * that flag was global (one user clearing it cleared everyone's) and was carried as a
 * project NAME, so a rename broke it. This is per-user and stores the id.
 *
 * SETTING IT IS AN AUTHORIZATION DECISION, not a preference write. The project must
 * exist AND the requesting user must be allowed to scope work to it — checked through
 * ProjectAccessService (migration 075), the SAME path middleware/project.ts uses for
 * X-Project-ID. It is deliberately not re-implemented here: see
 * services/userPreferences.ts for why the checks run access-before-existence.
 *
 * OMITTED FIELD != NULL. A theme-only PATCH must not wipe the default project, so an
 * absent key is left untouched and only an explicit `null` clears.
 *
 * ── ONE ASYMMETRY, DOCUMENTED RATHER THAN SILENT ─────────────────────────────────────
 * `null` means different things for the two fields, and that is deliberate:
 *   • `defaultProjectId: null`  CLEARS the stored default.
 *   • `theme: null`             is IGNORED — the stored theme is left as it is.
 * The reason is the schema, not taste: `default_project_id` is a nullable FK whose NULL is
 * a real, meaningful value ("no default"), while `theme` is governed by the
 * `admin_users_theme_check` constraint from migration 001 and has no "unset" member — a
 * NULL theme is not a preference, it is a row the UI then has to invent a value for. So
 * `null` is accepted (not a 400) and treated as "no change", which is what an unmodified
 * theme picker sends.
 * Both behaviours are asserted through HTTP in `__tests__/userPreferencesRoute.db.test.ts`
 * so the asymmetry cannot drift into whichever one the next reader assumes.
 */
router.patch('/preferences', authenticateToken,
  declareAnyAuthenticatedMayWrite('a user editing their OWN preferences'),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;
    const userId = user?.id;

    if (!user || !userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
      return;
    }

    const { theme } = req.body ?? {};
    // NOT a project SCOPE read (the eslint no-restricted-syntax door) — this names the
    // project being STORED as this user's own preference, and it is authorized below
    // through the same ProjectAccessService the scope middleware uses.
    const rawDefaultProjectId = (req.body ?? {}).defaultProjectId;

    // Validate theme value
    if (theme !== undefined && theme !== null && !isValidTheme(theme)) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid theme value. Must be "light" or "dark"'
      });
      return;
    }

    // Resolve the three meanings of the defaultProjectId key:
    //   absent    -> undefined -> leave the stored value alone
    //   null/''   -> null      -> CLEAR the default (allowed unconditionally: names no project)
    //   a string  -> authorize it before it is allowed anywhere near the UPDATE
    let defaultProjectId: string | null | undefined;
    if (rawDefaultProjectId === undefined) {
      defaultProjectId = undefined;
    } else if (rawDefaultProjectId === null || rawDefaultProjectId === '') {
      defaultProjectId = null;
    } else if (typeof rawDefaultProjectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'defaultProjectId must be a UUID string or null'
      });
      return;
    } else {
      const check = await UserPreferencesService.mayUseAsDefault(
        { id: userId, role: user.role },
        rawDefaultProjectId
      );
      if (!check.ok) {
        const status = check.reason === 'invalid' ? 400 : check.reason === 'forbidden' ? 403 : 404;
        res.status(status).json({
          success: false,
          error: status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Not Found',
          message:
            check.reason === 'invalid'
              ? 'defaultProjectId must be a UUID string or null'
              : check.reason === 'forbidden'
                ? 'You do not have access to that project'
                : 'Project not found'
        });
        return;
      }
      defaultProjectId = rawDefaultProjectId;
    }

    const preferences = await UserPreferencesService.update(userId, {
      // `undefined` = leave alone. An explicit `theme: null` lands here as `undefined`
      // ON PURPOSE — see "ONE ASYMMETRY" above; theme has no meaningful NULL.
      theme: isValidTheme(theme) ? theme : undefined,
      defaultProjectId,
    });

    if (!preferences) {
      res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'User not found'
      });
      return;
    }

    // `user` is kept for backward compatibility with existing consumers of this route;
    // `preferences` is the shape the typed client (api.users.updatePreferences) reads.
    const refreshed = await UserService.getUserById(userId);

    res.json({
      success: true,
      message: 'Preferences updated successfully',
      data: { preferences, user: refreshed }
    });
  } catch (error) {
    logger.error('Error updating preferences', { error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to update preferences'
    });
  }
});

/**
 * POST /api/users/revoke-sessions
 * Revoke all active sessions for current user
 */
router.post('/revoke-sessions', authenticateToken,
  declareAnyAuthenticatedMayWrite('a user revoking their OWN sessions'),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
      return;
    }

    // ---------------------------------------------------------------------------
    // 1. THE SECURITY ACTION — do this FIRST, and fail
    //    closed on it.
    //
    // This route's whole promise is the UI's "Sign out everywhere — useful if a
    // device was lost". The ONLY thing that keeps a device signed in is a row in
    // `auth_tokens`: `authenticateToken` -> `AuthService.validateSession(tokenId)`
    // gates on `expires_at > NOW() AND invalidated_at IS NULL`. Nothing in the
    // authentication path reads the `sessions` table below — that is WORK/ANALYTICS
    // state. So closing `sessions` rows revokes exactly nothing; until this call was
    // added, every issued JWT stayed accepted for the rest of its 24h TTL while the
    // response said "All sessions revoked successfully."
    //
    // Any future edit that removes this call re-opens that hole silently: the
    // analytics UPDATE would still succeed and the message would still reassure.
    // Guarded by revokeSessionsInvalidatesTokens.db.test.ts, which replays a captured
    // JWT against a real authenticated route and requires a 401.
    //
    // That guard RUNS IN THE GATE — which is a claim worth stating precisely, because
    // when this fix first shipped it did not. The suite carried the repo's usual
    // `MANDREL_SKIP_DB_TESTS` opt-out, and both the CI gate (STAGE 4) and
    // .github/workflows/ci.yml set that flag job-wide, so removing the line above left
    // the full backend suite at 408 passed / 0 failed. It is now declared via
    // `describeDb` (src/__tests__/helpers/dbContractGate.ts), which does not read that
    // flag; the same mutation now fails the suite under STAGE 4 conditions. Verify with
    // the mutation, never by reading this comment.
    //
    // NOT wrapped in its own try/catch on purpose: a throw must reach the handler's
    // catch and produce a 500 with NO success claim. Telling a user their lost device
    // is cut off when it is not is the bug this task fixed — do not "handle" it here.
    await AuthService.invalidateAllUserSessions(userId);

    // ---------------------------------------------------------------------------
    // 2. ANALYTICS BOOKKEEPING — NOT the security action.
    //
    // Closing the user's open work sessions keeps session analytics honest (their
    // `sessions` rows would otherwise sit 'active' forever after a sign-out-
    // everywhere). It grants and revokes no access whatsoever. It runs AFTER the
    // credential revocation and its failure is reported separately (see below) so it
    // can never be mistaken for, or stand in for, the security outcome.
    //
    // CLOCK DOMAINS: `ended_at` must NOT come from the
    // Postgres clock here. `sessions.started_at` is written from the NODE clock
    // (SessionRepo.create binds `params.startTime`; callers pass `new Date()`), and
    // the DB enforces
    //     CONSTRAINT reasonable_session_duration
    //       CHECK (ended_at IS NULL OR ended_at >= started_at)
    // so a DB-clock `NOW()` compares two different clocks with NO time gate. This route can
    // fire on a session minted milliseconds ago, so the instant the Postgres clock lags
    // the app clock the UPDATE violates the CHECK and the request 500s. That is latent
    // only while app and Postgres share one host clock; it goes live when the DB moves
    // off-box, a tenant container's clock drifts, or NTP corrects the unlucky way.
    //
    // The idle reaper `timeout_inactive_sessions()` has the SAME defect, and its 1-2h idle
    // gate is NOT a safety property: the gate only holds while the Node-ahead skew is
    // SMALLER than the idle threshold. At a skew larger than the threshold, a row is
    // selected (its last_activity_at really is old) while its started_at is still in the
    // DB's future — measured: `timeout_inactive_sessions('2 hours')` raises the same
    // violation. That is fixed by migration 072 (floored ended_at), not by this route.
    // Do not read the gated sweeps as "safe" — read them as "fails later".
    //
    // Instead, close each session at a time the session ITSELF already recorded, in the
    // domain it was recorded in — migration 051:40's "honest close time, not now()".
    // The GREATEST floor is load-bearing, not belt-and-braces: `last_activity_at` is a
    // MIXED-domain column (app clock at SessionRepo.create, but CURRENT_TIMESTAMP/NOW()
    // on every later touch — the update_session_activity trigger and SessionRepo's
    // reactivate/touch paths), so under a Node-ahead skew it can sit BELOW started_at
    // and a bare COALESCE would violate the very same CHECK. GREATEST makes ended_at
    // >= started_at true by construction, for any clock offset in either direction.
    //
    // The CHECK is correct and is what surfaced this class — never widen or drop it.
    //
    // Best-effort BY DESIGN, and reported: the credentials are already revoked by the
    // time this runs, so a bookkeeping failure must not make the response say
    // "Failed to revoke sessions" — that message would be false, and the user would
    // believe a lost device still has access. Both statements the response makes have
    // to be true, so the security outcome and the bookkeeping outcome are reported
    // separately rather than collapsed into one status code.
    let analyticsSessionsClosed = true;
    try {
      await pool.query(
        `UPDATE sessions
         SET status = 'inactive',
             ended_at = GREATEST(started_at, COALESCE(last_activity_at, started_at))
         WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );
    } catch (analyticsError) {
      analyticsSessionsClosed = false;
      // Log the MESSAGE, not the raw driver error object: a pg error carries the
      // failing statement and its bound parameters, so dumping it whole puts row data
      // (and anything a future caller binds) into the log file.
      logger.error('Revoke-sessions: credentials WERE revoked but the analytics sessions update failed', {
        userId,
        error: analyticsError instanceof Error ? analyticsError.message : String(analyticsError)
      });
    }

    res.json({
      success: true,
      message: 'All sessions revoked successfully. Please log in again.',
      data: { analyticsSessionsClosed }
    });
  } catch (error) {
    // Same `.message`-only treatment as the analytics catch above: this handler now
    // receives a pg error BY DESIGN (the credential revocation is deliberately not
    // wrapped, so its failure lands here), and a raw pg error carries the failing
    // statement plus its bound parameters.
    logger.error('Error revoking sessions', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to revoke sessions'
    });
  }
});

// ============================================================================
// PER-USER PROJECT ACCESS management (an earlier task — the F-04 grant surface).
// Admin-only: granting/revoking project scope IS an authorization decision, so it
// carries the enforced `requireAdmin` classification, not a declared marker.
// Without these routes the deny-by-default model would only be operable via SQL
// (the no-cheating rule: reaching past the product's surface is a flagged gap).
// ============================================================================

/**
 * GET /api/users/:userId/project-access — list the project ids granted to a user.
 * Admin-only: it enumerates another user's authorization state.
 */
router.get('/:userId/project-access', authenticateToken, requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const projectIds = await ProjectAccessService.listAccessibleProjectIds(req.params.userId);
      res.json({ success: true, data: { userId: req.params.userId, projectIds } });
    } catch (error) {
      logger.error('Error listing project access', {
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  });

/**
 * POST /api/users/:userId/project-access — grant a user access to a project.
 * Body: { projectId: "<uuid>" }. Idempotent.
 */
router.post('/:userId/project-access', authenticateToken, requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // this is the OBJECT of a grant — the project being granted
      // TO someone else — not the scope of this request, so getRequestProjectId() is the
      // wrong value. The route is `requireAdmin`, and admins hold every project by
      // definition, so there is no scope to escalate here.
      // eslint-disable-next-line no-restricted-syntax -- grant object on a requireAdmin route
      const { projectId } = req.body ?? {};
      if (typeof projectId !== 'string' || !isValidUuid(projectId)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'projectId must be a valid UUID'
        });
        return;
      }
      await ProjectAccessService.grantAccess(req.params.userId, projectId, req.user?.id);
      res.status(201).json({ success: true, data: { userId: req.params.userId, projectId } });
    } catch (error) {
      logger.error('Error granting project access', {
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  });

/**
 * DELETE /api/users/:userId/project-access/:projectId — revoke a grant. Idempotent.
 */
router.delete('/:userId/project-access/:projectId', authenticateToken, requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // `:projectId` here is the OBJECT of a revoke — the project
      // being taken AWAY from another user — not this request's scope. The route is
      // requireAdmin, and admins hold every project by definition, so there is no scope to
      // escalate.
      // eslint-disable-next-line no-restricted-syntax -- revoke object on a requireAdmin route
      if (!isValidUuid(req.params.projectId)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'projectId must be a valid UUID'
        });
        return;
      }
      // eslint-disable-next-line no-restricted-syntax -- revoke object on a requireAdmin route (see above)
      await ProjectAccessService.revokeAccess(req.params.userId, req.params.projectId);
      // eslint-disable-next-line no-restricted-syntax -- echoing the revoked id back, same route
      res.json({ success: true, data: { userId: req.params.userId, projectId: req.params.projectId } });
    } catch (error) {
      logger.error('Error revoking project access', {
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  });

export default router;
