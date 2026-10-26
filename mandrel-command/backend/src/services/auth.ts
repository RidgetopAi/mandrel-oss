import bcrypt from 'bcrypt';
import { sign, verify } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { db as pool } from '../database/connection';
import { User, JWTPayload, LoginRequest, RegisterRequest } from '../types/auth';
import { logger } from '../config/logger';
import { signInThroughBetterAuth, type BetterAuthSignIn } from './betterAuthSignIn';

// Helper function to get environment variable with MANDREL_ prefix and AIDIS_ fallback
function getEnvVar(mandrelKey: string, aidisKey: string, defaultValue: string = ''): string {
  const value = process.env[mandrelKey] || process.env[aidisKey] || defaultValue; // env-read: via-callers

  // Log deprecation warning if old var is used
  if (process.env[aidisKey] && !process.env[mandrelKey]) { // env-read: via-callers
    logger.warn(`⚠️  ${aidisKey} is deprecated. Use ${mandrelKey} instead.`);
  }
  
  return value;
}

function getEnvVarInt(mandrelKey: string, aidisKey: string, defaultValue: string = '0'): number {
  const value = getEnvVar(mandrelKey, aidisKey, defaultValue);
  return parseInt(value);
}

const JWT_SECRET = getEnvVar('MANDREL_JWT_SECRET', 'AIDIS_JWT_SECRET', 'aidis-secret-key-change-in-production');
const JWT_EXPIRES_IN = getEnvVar('MANDREL_JWT_EXPIRES_IN', 'AIDIS_JWT_EXPIRES_IN', '24h');
const BCRYPT_ROUNDS = getEnvVarInt('MANDREL_BCRYPT_ROUNDS', 'AIDIS_BCRYPT_ROUNDS', '12');

/**
 * The outcome of a dashboard sign-in. Not a nullable: "could not check" and "too many tries"
 * are different answers from "wrong password", and the route answers them differently
 * (503 / 429 / 401). `no-dashboard-access` = better-auth accepted the password, but no ACTIVE
 * dashboard row is linked to that login (linking is an operator act).
 */
export type LoginOutcome =
  | { kind: 'ok'; user: User; token: string; expiresAt: Date }
  | { kind: 'invalid' }
  | { kind: 'no-dashboard-access' }
  | { kind: 'rate-limited' }
  | { kind: 'unavailable' };

/** An identifier is tried against better-auth only if it is shaped like an email address. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

export class AuthService {
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  static generateJWT(user: User, tokenId: string): string {
    const payload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      tokenId
    };

    // Force type casting to avoid complex typing issues
    return (sign as any)(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  static verifyJWT(token: string): JWTPayload | null {
    try {
      return verify(token, JWT_SECRET) as JWTPayload;
    } catch (error) {
      return null;
    }
  }

  static async findUserByUsername(username: string): Promise<User | null> {
    const result = await pool.query(
      'SELECT * FROM admin_users WHERE username = $1 AND is_active = true',
      [username]
    );
    return result.rows[0] || null;
  }

  /**
   * The ACTIVE dashboard row linked to a better-auth user (migration 109), or null. A login
   * with no linked row has no dashboard here — no row is ever created at sign-in time.
   */
  static async findUserByAuthUserId(authUserId: string): Promise<User | null> {
    const result = await pool.query(
      'SELECT * FROM admin_users WHERE auth_user_id = $1 AND is_active = true',
      [authUserId]
    );
    return result.rows[0] || null;
  }

  static async findUserById(id: string): Promise<User | null> {
    const result = await pool.query(
      'SELECT * FROM admin_users WHERE id = $1 AND is_active = true',
      [id]
    );
    return result.rows[0] || null;
  }

  static async createUser(userData: RegisterRequest): Promise<User> {
    const hashedPassword = await this.hashPassword(userData.password);

    const result = await pool.query(
      `INSERT INTO admin_users (username, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, theme, is_active, created_at, updated_at, last_login`,
      [userData.username, userData.email, hashedPassword, userData.role || 'admin']
    );

    return result.rows[0];
  }

  /**
   * @param authSessionId the better-auth session this dashboard session was opened from, or
   *   null for a dashboard-password sign-in. When set, the dashboard session lives only as long
   *   as that better-auth session (validateSession; FK ON DELETE CASCADE, migration 109).
   */
  static async createSession(
    userId: string,
    authSessionId: string | null = null
  ): Promise<{ tokenId: string; expiresAt: Date }> {
    const tokenId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours from now

    // Create auth token (separate from work sessions)
    await pool.query(
      `INSERT INTO auth_tokens (user_id, token_id, expires_at, auth_session_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, tokenId, expiresAt, authSessionId]
    );

    return { tokenId, expiresAt };
  }

  static async validateSession(tokenId: string): Promise<boolean> {
    // Update last_used_at and check validity. A session opened through better-auth also needs
    // its better-auth session to be alive: better-auth ends it on a password reset
    // (revokeSessionsOnPasswordReset) — the row then cascades away — or lets it expire, which
    // only the expiresAt comparison here notices.
    const result = await pool.query(
      `UPDATE auth_tokens t
       SET last_used_at = NOW()
       WHERE t.token_id = $1
       AND t.expires_at > NOW()
       AND t.invalidated_at IS NULL
       AND (
         t.auth_session_id IS NULL
         OR EXISTS (
           SELECT 1 FROM "session" s
            WHERE s.id = t.auth_session_id AND s."expiresAt" > NOW()
         )
       )
       RETURNING t.id`,
      [tokenId]
    );
    return result.rows.length > 0;
  }

  static async invalidateSession(tokenId: string): Promise<void> {
    await pool.query(
      `UPDATE auth_tokens 
       SET invalidated_at = NOW() 
       WHERE token_id = $1`,
      [tokenId]
    );
  }

  static async invalidateAllUserSessions(userId: string): Promise<void> {
    await pool.query(
      `UPDATE auth_tokens 
       SET invalidated_at = NOW() 
       WHERE user_id = $1 AND invalidated_at IS NULL`,
      [userId]
    );
  }

  static async updateLastLogin(userId: string): Promise<void> {
    await pool.query(
      'UPDATE admin_users SET last_login = NOW() WHERE id = $1',
      [userId]
    );
  }

  /**
   * Sign in to the dashboard. ONE LOGIN, in this order:
   *   1. a dashboard password: an active admin_users row with this USERNAME and a password
   *      hash that matches — every pre-existing login (prod's admin, a self-hoster's admin, a
   *      tenant's operator `admin`), unchanged;
   *   2. otherwise, if the identifier is an email address, better-auth's own email+password
   *      sign-in (the password the welcome link set). Accepted → the ACTIVE dashboard row
   *      linked to that better-auth user, and the dashboard session is bound to the
   *      better-auth session. No linked row → `no-dashboard-access`; the row is never created
   *      here (linking is the operator's provisioning act — services/dashboardOwner.ts).
   * The role, and so every permission, comes from admin_users — never from better-auth.
   */
  static async login(
    credentials: LoginRequest,
    signIn: BetterAuthSignIn = signInThroughBetterAuth,
    clientIp?: string
  ): Promise<LoginOutcome> {
    const user = await this.findUserByUsername(credentials.username);
    // A row linked to better-auth may carry no dashboard password at all (migration 109).
    if (user && user.password_hash && await this.verifyPassword(credentials.password, user.password_hash)) {
      return this.openSession(user, null);
    }

    const identifier = credentials.username.trim();
    if (!EMAIL_SHAPE.test(identifier)) {
      return { kind: 'invalid' };
    }

    const verdict = await signIn(identifier, credentials.password, clientIp);
    switch (verdict.kind) {
      case 'no-match':
        return { kind: 'invalid' };
      case 'rate-limited':
        return { kind: 'rate-limited' };
      case 'unavailable':
        return { kind: 'unavailable' };
      case 'ok': {
        const linked = await this.findUserByAuthUserId(verdict.authUserId);
        if (!linked) {
          logger.warn('Dashboard sign-in refused: better-auth login has no active dashboard user', {
            authUserId: verdict.authUserId,
          });
          return { kind: 'no-dashboard-access' };
        }
        return this.openSession(linked, verdict.authSessionId);
      }
    }
  }

  private static async openSession(user: User, authSessionId: string | null): Promise<LoginOutcome> {
    const { tokenId, expiresAt } = await this.createSession(user.id, authSessionId);
    const token = this.generateJWT(user, tokenId);
    await this.updateLastLogin(user.id);

    // Remove password_hash from user object
    const { password_hash: _password_hash, ...userWithoutPassword } = user;

    return {
      kind: 'ok',
      user: userWithoutPassword as User,
      token,
      expiresAt
    };
  }

  static async logout(tokenId: string): Promise<void> {
    await this.invalidateSession(tokenId);
  }

  static async refreshToken(tokenId: string): Promise<{ token: string; expiresAt: Date } | null> {
    // Validate current session
    const isValidSession = await this.validateSession(tokenId);
    if (!isValidSession) {
      return null;
    }

    // Get auth token info
    const tokenResult = await pool.query(
      `SELECT user_id, auth_session_id FROM auth_tokens
       WHERE token_id = $1
       AND expires_at > NOW()
       AND invalidated_at IS NULL`,
      [tokenId]
    );

    if (tokenResult.rows.length === 0) {
      return null;
    }

    const userId = tokenResult.rows[0].user_id;
    // A refreshed session stays bound to the same better-auth session, so a
    // refresh can never outlive a password reset.
    const authSessionId: string | null = tokenResult.rows[0].auth_session_id ?? null;
    const user = await this.findUserById(userId);
    
    if (!user) {
      return null;
    }

    // Invalidate old session and create new one
    await this.invalidateSession(tokenId);
    const { tokenId: newTokenId, expiresAt } = await this.createSession(userId, authSessionId);
    
    // Generate new JWT
    const token = this.generateJWT(user, newTokenId);

    return { token, expiresAt };
  }
}