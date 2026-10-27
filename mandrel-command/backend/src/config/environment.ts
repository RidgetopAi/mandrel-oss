import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import dotenvSafe from 'dotenv-safe';
import { logger } from './logger';

// Load environment variables with centralized configuration hierarchy:
// 1. Environment-specific file from /config/environments/
// 2. Repository root .env (deployment overrides)
// 3. Backend-specific .env (legacy support)
// 4. process.env (highest priority)
// Existing process.env values are preserved.

const nodeEnv = process.env.NODE_ENV || 'development';
const configRoot = path.resolve(__dirname, '../../../../config');

const envPaths = [
  path.join(configRoot, 'environments', `.env.${nodeEnv}.local`), // Local overrides (gitignored) - loaded first for priority
  path.join(configRoot, 'environments', `.env.${nodeEnv}`),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../backend/.env')
];

logger.info(`🔧 Loading configuration for environment: ${nodeEnv}`);

// Load hierarchical configuration with dotenv first (preserve existing logic)
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    logger.info(`📄 Loading config from: ${envPath}`);
    dotenv.config({ path: envPath, override: false });
  } else {
    logger.info(`⚠️  Config file not found: ${envPath}`);
  }
}

dotenv.config({ override: false });

// Validate required variables using dotenv-safe with backend's .env.example
const backendExamplePath = path.resolve(__dirname, '../../.env.example');
try {
  dotenvSafe.config({
    example: backendExamplePath,
    allowEmptyValues: true, // Allow empty values for optional variables
    path: false as any // Don't load any .env file, just validate current process.env
  });
  logger.info('✅ Environment variable validation passed');
} catch (error) {
  logger.error('❌ Environment variable validation failed', { error: (error as Error).message });
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  } else {
    logger.warn('⚠️  Continuing in development mode despite validation errors');
  }
}

/**
 * Parse the TRUST_PROXY env var into an Express `trust proxy` setting.
 *
 * SECURITY-sensitive. Express needs to know how many reverse proxies sit in
 * front so that `req.ip` and express-rate-limit key off the REAL client IP
 * (from X-Forwarded-For) instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
 * or bucketing every client under the shared proxy IP.
 *
 * Accepted values:
 *   - unset / ''      -> 'loopback'   (DEFAULT — safe for prod's single loopback nginx)
 *   - 'loopback'      -> 'loopback'   (named subnet: trusts 127.0.0.1/::1 only)
 *   - 'false'         -> false        (trust no proxy; req.ip is the socket peer)
 *   - 'true'          -> true         (trust the ENTIRE XFF chain — see WARNING)
 *   - an integer e.g. '1', '2', '3'   -> number of proxy hops to trust
 *   - any other string (IP / CIDR / CSV / named subnet) -> passed through to Express
 *
 * WARNING: do NOT default to `true`. `trust proxy: true` trusts every entry in
 * X-Forwarded-For, so any client can forge that header to spoof its IP and
 * bypass the rate limiter (security regression).
 *   - Prod (systemd, nginx -> backend on loopback): leave unset => 'loopback'.
 *   - Fleet tenant chain (host-nginx -> Traefik -> tenant-nginx -> backend): set
 *     the EXACT integer hop-count via TRUST_PROXY (e.g. 3) and VERIFY it — NOT 'true'.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? '').trim();
  if (value === '') return 'loopback';
  const lower = value.toLowerCase();
  if (lower === 'false') return false;
  if (lower === 'true') return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  // Named subnet ('loopback'/'linklocal'/'uniquelocal'), an IP/CIDR, or a CSV
  // list of them — Express understands these strings directly.
  return value;
}

export const config = {
  // Server configuration
  port: parseInt(process.env.MANDREL_HTTP_PORT || process.env.PORT || '5000'),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Reverse-proxy trust (SECURITY-sensitive). Default 'loopback' is safe for
  // prod's single loopback nginx; override per-environment via TRUST_PROXY.
  // See parseTrustProxy above for the full contract + the no-`true` warning.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Database configuration
  // Connections are built from discrete fields below (see database/connection.ts);
  // there is no DATABASE_URL consumer, so secrets are never embedded in a URL.
  database: {
    user: process.env.DATABASE_USER || 'mandrel',
    host: process.env.DATABASE_HOST || 'localhost',
    database: process.env.DATABASE_NAME || 'mandrel',
    password: process.env.DATABASE_PASSWORD || (() => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_PASSWORD environment variable is required in production');
      }
      logger.warn('⚠️  DATABASE_PASSWORD not set - using empty string in development');
      return '';
    })(),
    port: parseInt(process.env.DATABASE_PORT || '5432'),
  },

  // Authentication configuration
  // Canonical key is MANDREL_JWT_SECRET (the value AuthService actually signs with,
  // see services/auth.ts). JWT_SECRET is accepted as a transitional fallback only.
  auth: {
    jwtSecret: process.env.MANDREL_JWT_SECRET || process.env.JWT_SECRET || (() => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('MANDREL_JWT_SECRET environment variable is required in production');
      }
      logger.warn('⚠️  Using default JWT secret - set MANDREL_JWT_SECRET environment variable');
      return 'dev-only-' + Math.random().toString(36).substring(7);
    })(),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12'),
  },

  // MCP bridge client configuration. SECURITY P0 interim shield: the static
  // Bearer token this backend presents to the mcp-server's on-box /mcp/tools/* bridge, so its
  // tool calls authenticate once the mcp-server's MCP_BRIDGE_AUTH_ENABLED gate is flipped ON.
  // MUST match the mcp-server's MCP_AUTH_TOKEN. NO hardcoded value (configs-not-hardcoded) —
  // read from env; empty when unset, in which case McpService sends no Authorization header
  // (byte-identical to the pre-shield behavior, safe while the gate is still OFF). NEVER logged.
  mcp: {
    authToken: process.env.MCP_AUTH_TOKEN || '',
  },

  // INBOUND machine credential. The mirror of `mcp.authToken`: that one is
  // what this backend PRESENTS to the mcp-server; this one is what a headless agent must
  // PRESENT to this backend on `POST /api/git/push-stats`.
  //
  // Why a static service token and not a JWT: `authenticateToken` only accepts user JWTs
  // and `auth.jwtExpiresIn` is 24h, so there is no way to credential a long-lived daemon
  // without widening token lifetime for every human user — the wrong trade, and the task
  // says so explicitly. A static token scoped to ONE route is the smaller blast radius.
  //
  // NO hardcoded value and NO default (configs-not-hardcoded). Empty when unset, and empty
  // means the agent path is CLOSED — `authenticateAgentOrUser` refuses rather than falling
  // open. A user JWT still works on that route when this is unset. NEVER logged.
  agent: {
    pushToken: process.env.MANDREL_AGENT_TOKEN || '',
  },

  // Request-body size limits (body-parse-after-auth). `authenticated` is the
  // cap for bodies parsed AFTER a credential is verified (the former app-wide 10mb);
  // `public` is the much smaller cap for the few routes that must parse a body with NO
  // credential (login), so an anonymous caller can never make the server buffer megabytes.
  bodyLimits: {
    authenticated: process.env.BODY_LIMIT_AUTHENTICATED || '10mb',
    public: process.env.BODY_LIMIT_PUBLIC || '16kb',
  },

  // CORS configuration
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001').split(','),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-Project-ID'],
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dbLogLevel: process.env.DB_LOG_LEVEL || 'warn',
    enableConsole: process.env.NODE_ENV === 'development',
    enableFileRotation: (process.env.ENABLE_LOG_ROTATION || 'true') !== 'false',
    maxFileSize: process.env.LOG_MAX_FILE_SIZE || '20m',
    maxFiles: process.env.LOG_MAX_FILES || '30d'
  },

  // Application info
  app: {
    name: 'Mandrel Command Backend',
    version: process.env.npm_package_version || '1.0.0',
    description: 'REST API server for Mandrel database administration',
  },

  // Activity (work) score weights — the single, named home for the scoring formula
  // so the numbers are NOT hardcoded inline in the SQL/service logic (configs-not-
  // hardcoded). This is a "work/activity" score that GROWS with effort: it reflects
  // how much work a session did (contexts written, decisions recorded, tasks
  // completed, time spent, tokens used). It is intentionally UNbounded on the high
  // end — there is no /100 ceiling; a busier session simply scores higher.
  //
  // Substance is unchanged from the original formula (do not invent a new one):
  //   contexts*2 + decisions*3 + tasksCompleted*4 + min(hours,8)*1.5 + min(tokens/1k,10)*0.5
  // Overridable via env for tuning without a code change; defaults preserve the
  // historical formula exactly.
  activityScore: {
    perContext: parseFloat(process.env.SCORE_PER_CONTEXT || '2.0'),
    perDecision: parseFloat(process.env.SCORE_PER_DECISION || '3.0'),
    perTaskCompleted: parseFloat(process.env.SCORE_PER_TASK_COMPLETED || '4.0'),
    perHour: parseFloat(process.env.SCORE_PER_HOUR || '1.5'),
    maxHours: parseFloat(process.env.SCORE_MAX_HOURS || '8'),
    perThousandTokens: parseFloat(process.env.SCORE_PER_1K_TOKENS || '0.5'),
    maxThousandTokens: parseFloat(process.env.SCORE_MAX_1K_TOKENS || '10'),
  },

  // Health check (/healthz) tuning — named home for the memory-pressure threshold
  // so it is NOT hardcoded inline in the route (configs-not-hardcoded). The memory
  // check compares heapUsed against V8's REAL max-old-space ceiling
  // (v8.getHeapStatistics().heap_size_limit), NOT the lazily-grown heapTotal, so a
  // freshly-restarted small-heap process is correctly reported healthy. The default
  // 0.9 means "flag as down only when within 10% of the actual OOM ceiling".
  healthz: {
    heapUtilThreshold: parseFloat(process.env.HEALTHZ_HEAP_UTIL_THRESHOLD || '0.9'),
  }
};

export default config;
