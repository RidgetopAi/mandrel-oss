import { Request } from 'express';
import { ResolvedProjectScope } from '../services/projectScopeResolver';

export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  theme?: string;
  /**
   * This user's default project (epic 41293984 §A) — a UUID, or null when they have set
   * none. Per-user and stored as an ID, replacing the instance-wide, name-keyed
   * `projects.metadata.is_primary` flag the UI used to read.
   */
  default_project_id?: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login?: Date;
  password_hash?: string;
  // When true, the user is forced to set a new password on first dashboard login
  // before they can use the app. New provisions are flagged true; existing admins
  // are grandfathered (false). Cleared on a successful policy-compliant change.
  must_change_password?: boolean;
}

export interface UserSession {
  id: string;
  user_id: string;
  token_id: string;
  created_at: Date;
  expires_at: Date;
  is_active: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: Omit<User, 'password_hash'>;
  token: string;
  expires_at: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  role?: string;
}

export interface JWTPayload {
  userId: string;
  username: string;
  email: string;
  role: string;
  tokenId: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user?: User;
  tokenId?: string;
  /**
   * The AUTHORIZED winning project id. Attached by middleware/project.ts.
   * Prefer `getRequestProjectId(req)` (services/projectScopeResolver) in handlers: it
   * throws when the middleware never ran, where this field would just read `undefined`.
   */
  projectId?: string;
  /**
   * The full resolved+authorized project scope. Present on every request
   * that passed projectContextMiddleware, INCLUDING unscoped ones — its absence means the
   * middleware did not run, which getRequestProjectId() turns into a loud 500 rather than
   * a silent "no project".
   */
  projectScope?: ResolvedProjectScope;
  /**
   * Set by `authenticateAgentOrUser` (middleware/agentAuth.ts) when the request presented
   * the MANDREL_AGENT_TOKEN service credential rather than a user JWT. `user` is
   * deliberately NOT populated in that case — a machine is not a person — so any
   * downstream check that gates on `user` (e.g. project-ownership authorizers) must check
   * this FIRST, the same way it already special-cases `user.role === 'admin'`.
   */
  agentAuthenticated?: boolean;
}
