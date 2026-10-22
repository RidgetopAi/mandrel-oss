import bcrypt from 'bcrypt';
import { sign, verify } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { db as pool } from '../database/connection';
import { User, JWTPayload, LoginRequest, RegisterRequest } from '../types/auth';
import { logger } from '../config/logger';

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

  static async createSession(userId: string): Promise<{ tokenId: string; expiresAt: Date }> {
    const tokenId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours from now

    // Create auth token (separate from work sessions)
    await pool.query(
      `INSERT INTO auth_tokens (user_id, token_id, expires_at) 
       VALUES ($1, $2, $3)`,
      [userId, tokenId, expiresAt]
    );

    return { tokenId, expiresAt };
  }

  static async validateSession(tokenId: string): Promise<boolean> {
    // Update last_used_at and check validity
    const result = await pool.query(
      `UPDATE auth_tokens 
       SET last_used_at = NOW()
       WHERE token_id = $1 
       AND expires_at > NOW()
       AND invalidated_at IS NULL
       RETURNING id`,
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

  static async login(credentials: LoginRequest): Promise<{ user: User; token: string; expiresAt: Date } | null> {
    const user = await this.findUserByUsername(credentials.username);
    if (!user) {
      return null;
    }

    const isValidPassword = await this.verifyPassword(credentials.password, user.password_hash!);
    if (!isValidPassword) {
      return null;
    }

    // Create new session
    const { tokenId, expiresAt } = await this.createSession(user.id);
    
    // Generate JWT
    const token = this.generateJWT(user, tokenId);
    
    // Update last login
    await this.updateLastLogin(user.id);

    // Remove password_hash from user object
    const { password_hash: _password_hash, ...userWithoutPassword } = user;

    return {
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
      `SELECT user_id FROM auth_tokens
       WHERE token_id = $1
       AND expires_at > NOW()
       AND invalidated_at IS NULL`,
      [tokenId]
    );

    if (tokenResult.rows.length === 0) {
      return null;
    }

    const userId = tokenResult.rows[0].user_id;
    const user = await this.findUserById(userId);
    
    if (!user) {
      return null;
    }

    // Invalidate old session and create new one
    await this.invalidateSession(tokenId);
    const { tokenId: newTokenId, expiresAt } = await this.createSession(userId);
    
    // Generate new JWT
    const token = this.generateJWT(user, newTokenId);

    return { token, expiresAt };
  }
}