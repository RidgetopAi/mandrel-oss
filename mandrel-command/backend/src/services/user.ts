import { db as pool } from '../database/connection';
import { AuthService } from './auth';
import { User } from '../types/auth';

export interface UserUpdateData {
  username?: string;
  email?: string;
  role?: string;
  is_active?: boolean;
}

export interface PasswordUpdateData {
  currentPassword: string;
  newPassword: string;
}

/**
 * ─── PROFILE IDENTITY VALIDATION ─────────────────────────────────────────
 *
 * `PUT /api/users/profile` accepted ANY non-empty string as a username. Three consequences,
 * all of them live before this:
 *   - leading/trailing whitespace was stored verbatim, so " operator" and "operator" are two
 *     different rows that render identically in every UI that shows a username;
 *   - the uniqueness check was exact-match, so "the operator" and "operator" could coexist — a
 *     phishing surface anywhere a username is rendered as identity;
 *   - characters that have no business in a handle (spaces, control characters, RTL marks,
 *     lookalike unicode) were accepted.
 *
 * The rules are a NAMED config rather than literals inside the route, so the route, the
 * tests and any future caller read the same numbers (configs-not-hardcoded).
 */
export const USERNAME_RULES = {
  minLength: 3,
  maxLength: 32,
  /**
   * ASCII letters, digits, dot, underscore, hyphen. Deliberately a strict ALLOW-list: a
   * deny-list of confusables is unbounded and would need maintaining forever, and this is
   * an admin handle, not a display name.
   */
  pattern: /^[A-Za-z0-9._-]+$/,
} as const;

export const EMAIL_RULES = {
  /** RFC 5321 limit on the whole address. */
  maxLength: 254,
  /** Deliberately loose on the local part; the point is to reject shapes that are not addresses at all. */
  pattern: /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/,
} as const;

export interface FieldValidation {
  ok: boolean;
  /** The value to store — trimmed. Present only when ok. */
  value?: string;
  error?: string;
}

/** Validate + normalise a proposed username. Returns the value that should be STORED. */
export function validateUsername(raw: unknown): FieldValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Username must be a string' };
  }
  const value = raw.trim();
  if (value.length < USERNAME_RULES.minLength || value.length > USERNAME_RULES.maxLength) {
    return {
      ok: false,
      error: `Username must be between ${USERNAME_RULES.minLength} and ${USERNAME_RULES.maxLength} characters`,
    };
  }
  if (!USERNAME_RULES.pattern.test(value)) {
    return {
      ok: false,
      error: 'Username may contain only letters, digits, dot, underscore and hyphen',
    };
  }
  return { ok: true, value };
}

/** Validate + normalise a proposed email address. Returns the value that should be STORED. */
export function validateEmail(raw: unknown): FieldValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Email must be a string' };
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > EMAIL_RULES.maxLength) {
    return { ok: false, error: `Email must be 1-${EMAIL_RULES.maxLength} characters` };
  }
  if (!EMAIL_RULES.pattern.test(value)) {
    return { ok: false, error: 'Email is not a valid address' };
  }
  return { ok: true, value };
}

export class UserService {
  static async getAllUsers(): Promise<Omit<User, 'password_hash'>[]> {
    const result = await pool.query(`
      SELECT id, username, email, role, theme, default_project_id, is_active, must_change_password, created_at, updated_at, last_login
      FROM admin_users
      ORDER BY created_at DESC
    `);
    return result.rows;
  }

  static async getUserById(id: string): Promise<Omit<User, 'password_hash'> | null> {
    const result = await pool.query(`
      SELECT id, username, email, role, theme, default_project_id, is_active, must_change_password, created_at, updated_at, last_login
      FROM admin_users
      WHERE id = $1
    `, [id]);

    return result.rows[0] || null;
  }

  static async updateUser(id: string, updateData: UserUpdateData): Promise<Omit<User, 'password_hash'> | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updateData.username !== undefined) {
      fields.push(`username = $${paramIndex}`);
      values.push(updateData.username);
      paramIndex++;
    }

    if (updateData.email !== undefined) {
      fields.push(`email = $${paramIndex}`);
      values.push(updateData.email);
      paramIndex++;
    }

    if (updateData.role !== undefined) {
      fields.push(`role = $${paramIndex}`);
      values.push(updateData.role);
      paramIndex++;
    }

    if (updateData.is_active !== undefined) {
      fields.push(`is_active = $${paramIndex}`);
      values.push(updateData.is_active);
      paramIndex++;
    }

    if (fields.length === 0) {
      return null;
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `
      UPDATE admin_users
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, username, email, role, theme, default_project_id, is_active, must_change_password, created_at, updated_at, last_login
    `;

    const result = await pool.query(query, values);
    return result.rows[0] || null;
  }

  /**
   * Re-authentication for identity-level changes.
   *
   * Renaming the handle you are known by, or moving the address the account is reachable
   * at, is an identity action — `POST /users/change-password` already re-verifies the
   * current password and this is the same class of act. Before this, a hijacked session
   * could rename the account outright with no secret the attacker did not already have.
   *
   * Returns false for a wrong password AND for a user that does not exist or has no hash;
   * the caller must not be able to tell those apart.
   */
  static async verifyCurrentPassword(userId: string, currentPassword: unknown): Promise<boolean> {
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return false;
    }

    const result = await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [userId]);
    const hash = result.rows[0]?.password_hash;
    if (!hash) {
      return false;
    }

    return AuthService.verifyPassword(currentPassword, hash);
  }

  /**
   * CASE-INSENSITIVE uniqueness. The old check was `WHERE username = $1`, which let
   * "the operator" and "operator" coexist. Reserving the case-folded handle is the fix, because the
   * confusion this prevents is a HUMAN one — nobody reading a UI distinguishes them.
   */
  static async isUsernameTaken(username: string, excludeUserId: string): Promise<boolean> {
    const result = await pool.query(
      'SELECT id FROM admin_users WHERE LOWER(username) = LOWER($1) AND id != $2',
      [username, excludeUserId]
    );
    return result.rows.length > 0;
  }

  /** Same case-insensitive rule for email — addresses are case-insensitive in practice. */
  static async isEmailTaken(email: string, excludeUserId: string): Promise<boolean> {
    const result = await pool.query(
      'SELECT id FROM admin_users WHERE LOWER(email) = LOWER($1) AND id != $2',
      [email, excludeUserId]
    );
    return result.rows.length > 0;
  }

  static async updatePassword(userId: string, passwordData: PasswordUpdateData): Promise<boolean> {
    // Get current user with password hash
    const userResult = await pool.query(
      'SELECT password_hash FROM admin_users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return false;
    }

    const currentHash = userResult.rows[0].password_hash;

    // Verify current password
    const isValidCurrentPassword = await AuthService.verifyPassword(
      passwordData.currentPassword, 
      currentHash
    );

    if (!isValidCurrentPassword) {
      return false;
    }

    // Hash new password
    const newHash = await AuthService.hashPassword(passwordData.newPassword);

    // Update password and clear the force-change flag (a successful, policy-compliant
    // change satisfies the first-login requirement, so normal access resumes).
    await pool.query(
      'UPDATE admin_users SET password_hash = $1, must_change_password = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newHash, userId]
    );

    // Invalidate all existing sessions for this user (force re-login)
    await AuthService.invalidateAllUserSessions(userId);

    return true;
  }

  static async deleteUser(id: string): Promise<boolean> {
    const result = await pool.query(
      'DELETE FROM admin_users WHERE id = $1',
      [id]
    );
    
    return (result.rowCount ?? 0) > 0;
  }

  static async deactivateUser(id: string): Promise<boolean> {
    const result = await pool.query(
      'UPDATE admin_users SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    if ((result.rowCount ?? 0) > 0) {
      // Invalidate all sessions for deactivated user
      await AuthService.invalidateAllUserSessions(id);
      return true;
    }

    return false;
  }

  static async activateUser(id: string): Promise<boolean> {
    const result = await pool.query(
      'UPDATE admin_users SET is_active = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );
    
    return (result.rowCount ?? 0) > 0;
  }

  static async validatePasswordStrength(password: string): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }

    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain at least one number');
    }

    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
