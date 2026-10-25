import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthService } from '../services/auth';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { LoginRequest, RegisterRequest, AuthenticatedRequest } from '../types/auth';
import { logger } from '../config/logger';
import { declareIntentionallyUnauthenticated, declareAnyAuthenticatedMayWrite } from '../middleware/authz';

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       required:
 *         - id
 *         - username
 *         - email
 *         - role
 *         - is_active
 *         - created_at
 *         - updated_at
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique user identifier
 *         username:
 *           type: string
 *           description: Unique username
 *         email:
 *           type: string
 *           format: email
 *           description: User email address
 *         role:
 *           type: string
 *           enum: [admin, user]
 *           description: User role
 *         is_active:
 *           type: boolean
 *           description: Whether the user account is active
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Account creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 *         last_login:
 *           type: string
 *           format: date-time
 *           description: Last login timestamp
 *         must_change_password:
 *           type: boolean
 *           description: When true, the user must set a new password on first login before using the app
 *     LoginRequest:
 *       type: object
 *       required:
 *         - username
 *         - password
 *       properties:
 *         username:
 *           type: string
 *           description: Username
 *           example: admin
 *         password:
 *           type: string
 *           format: password
 *           description: Password
 *           example: password123
 *     LoginResponse:
 *       type: object
 *       required:
 *         - user
 *         - token
 *         - expires
 *       properties:
 *         user:
 *           $ref: '#/components/schemas/User'
 *         token:
 *           type: string
 *           description: JWT authentication token
 *         expires:
 *           type: string
 *           format: date-time
 *           description: Token expiration timestamp
 *     RegisterRequest:
 *       type: object
 *       required:
 *         - username
 *         - email
 *         - password
 *       properties:
 *         username:
 *           type: string
 *           minLength: 3
 *           description: Unique username
 *         email:
 *           type: string
 *           format: email
 *           description: User email address
 *         password:
 *           type: string
 *           format: password
 *           minLength: 6
 *           description: Password (minimum 6 characters)
 *         role:
 *           type: string
 *           enum: [admin, user]
 *           default: admin
 *           description: User role
 *     ProfileResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         data:
 *           type: object
 *           properties:
 *             user:
 *               $ref: '#/components/schemas/User'
 *     RefreshTokenResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           type: object
 *           properties:
 *             token:
 *               type: string
 *               description: New JWT token
 *             expires_at:
 *               type: string
 *               format: date-time
 *               description: New token expiration timestamp
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error type
 *         message:
 *           type: string
 *           description: Human-readable error message
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 * tags:
 *   - name: Authentication
 *     description: User authentication and authorization endpoints
 */

const router = Router();

// Rate limiting for auth endpoints - Production-safe with admin considerations
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 100 : 30, // Increased for testing
  message: {
    error: 'Too many authentication attempts',
    message: 'Rate limit exceeded. Please wait before trying again. If you are a legitimate admin user experiencing issues, check your credentials and try again after the cooldown period.',
    retryAfter: Math.ceil(15 * 60) // 15 minutes in seconds
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Remove custom keyGenerator to use default IPv6-safe implementation
  // Enhanced rate limit handler with better logging
  handler: (req: any, res: any) => {
    logger.warn('Authentication rate limit reached', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method
    });
    res.status(429).json({ 
      error: 'Too many authentication attempts. Please try again later.' 
    });
  }
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes  
  max: 200, // Increased from 100 to 200 for better admin experience
  message: {
    error: 'Too many requests',
    message: 'Please try again later. Rate limit exceeded.',
    retryAfter: Math.ceil(15 * 60 / 1000)
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Validation helper
const validateLoginRequest = (body: any): body is LoginRequest => {
  return body && 
         typeof body.username === 'string' && 
         typeof body.password === 'string' &&
         body.username.trim().length > 0 && 
         body.password.length > 0;
};

const validateRegisterRequest = (body: any): body is RegisterRequest => {
  return body && 
         typeof body.username === 'string' && 
         typeof body.email === 'string' && 
         typeof body.password === 'string' &&
         body.username.trim().length >= 3 && 
         body.email.includes('@') &&
         body.password.length >= 6;
};

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: User login
 *     description: Authenticate a user with username and password
 *     tags: [Authentication]
 *     # The global `security` in config/openapi requires bearerAuth on every operation, so
 *     # without this override the SHIPPED SPEC told customers that the login endpoint needs
 *     # a bearer token — which is both false and impossible, and it is what a generated
 *     # client would try to attach. Found 2026-08-25 by cross-checking the live spec
 *     # against the route census (the class is the route-census drift class).
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Too many login attempts
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// POST /api/auth/login
router.post('/login', authLimiter,
  declareIntentionallyUnauthenticated('login IS the credential exchange — it cannot require one; rate-limited by authLimiter'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    if (!validateLoginRequest(req.body)) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'Username and password are required'
      });
      return;
    }

    const { username, password } = req.body;
    const result = await AuthService.login({ username, password });

    if (!result) {
      res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid username or password'
      });
      return;
    }

    res.json({
      user: result.user,
      token: result.token,
      expires: result.expiresAt.toISOString()
    });
  } catch (error) {
    logger.error('Login error', { error });
    res.status(500).json({
      error: 'Server error',
      message: 'An error occurred during login'
    });
  }
});

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: User logout
 *     description: Logout the authenticated user and invalidate their token
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// POST /api/auth/logout
router.post('/logout', generalLimiter, authenticateToken,
  declareAnyAuthenticatedMayWrite('a user ending their own session'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (req.tokenId) {
      await AuthService.logout(req.tokenId);
    }

    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    logger.error('Logout error', { error });
    res.status(500).json({
      error: 'Server error',
      message: 'An error occurred during logout'
    });
  }
});

/**
 * @swagger
 * /auth/profile:
 *   get:
 *     summary: Get user profile
 *     description: Get the profile of the authenticated user
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProfileResponse'
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// GET /api/auth/profile
router.get('/profile', generalLimiter, authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        error: 'User not found',
        message: 'Please log in again'
      });
      return;
    }

    const { password_hash: _password_hash, ...userProfile } = req.user as any;
    
    res.json({
      success: true,
      data: { user: userProfile }
    });
  } catch (error) {
    logger.error('Profile error', { error });
    res.status(500).json({
      error: 'Server error',
      message: 'Could not retrieve user profile'
    });
  }
});

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh authentication token
 *     description: Refresh the JWT token for the authenticated user
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RefreshTokenResponse'
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// POST /api/auth/refresh
router.post('/refresh', generalLimiter, authenticateToken,
  declareAnyAuthenticatedMayWrite('a user refreshing their own token'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.tokenId) {
      res.status(401).json({
        error: 'Invalid token',
        message: 'Token ID not found'
      });
      return;
    }

    const result = await AuthService.refreshToken(req.tokenId);

    if (!result) {
      res.status(401).json({
        error: 'Refresh failed',
        message: 'Unable to refresh token'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        token: result.token,
        expires_at: result.expiresAt.toISOString()
      }
    });
  } catch (error) {
    logger.error('Token refresh error', { error });
    res.status(500).json({
      error: 'Server error',
      message: 'An error occurred during token refresh'
    });
  }
});

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register new user (Admin only)
 *     description: Register a new user account. Requires admin privileges.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterRequest'
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden - admin privileges required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Conflict - username or email already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Too many registration attempts
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// POST /api/auth/register (Admin only)
router.post('/register', authLimiter, authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!validateRegisterRequest(req.body)) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'Username (3+ chars), valid email, and password (6+ chars) are required'
      });
      return;
    }

    const { username, email, password, role } = req.body;

    // Check if user already exists
    const existingUser = await AuthService.findUserByUsername(username);
    if (existingUser) {
      res.status(409).json({
        error: 'User exists',
        message: 'Username already taken'
      });
      return;
    }

    const newUser = await AuthService.createUser({ username, email, password, role: role || 'admin' });
    
    const { password_hash: _password_hash, ...userResponse } = newUser as any;
    
    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: { user: userResponse }
    });
  } catch (error: any) {
    logger.error('Registration error', { error });
    
    if (error.code === '23505') { // PostgreSQL unique violation
      res.status(409).json({
        error: 'Duplicate entry',
        message: 'Username or email already exists'
      });
      return;
    }

    res.status(500).json({
      error: 'Server error',
      message: 'An error occurred during registration'
    });
  }
});

export default router;
