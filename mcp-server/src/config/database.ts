import { Pool, PoolConfig } from 'pg';
import dotenvSafe from 'dotenv-safe';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { guardPool } from '../utils/datastoreError.js';
import { activeEmbedder } from './embeddingConfig.js';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables with validation
const envExamplePath = path.resolve(__dirname, '../../.env.example');

// Check if files exist before loading
import fs from 'fs';
if (!fs.existsSync(envExamplePath)) {
  logger.warn(`⚠️  .env.example not found at ${envExamplePath}`);
}

// Load environment variables from centralized config hierarchy
const nodeEnv = process.env.NODE_ENV || 'development';
const configRoot = path.resolve(__dirname, '../../../config');

const envPaths = [
  path.join(configRoot, 'environments', `.env.${nodeEnv}`),
  path.resolve(__dirname, '../../.env')
];

logger.info(`🔧 [MCP] Loading configuration for environment: ${nodeEnv}`);

// Load hierarchical configuration
for (const configPath of envPaths) {
  if (fs.existsSync(configPath)) {
    logger.info(`📄 [MCP] Loading config from: ${configPath}`);
    // Read and parse the .env file manually for ES modules
    try {
      const envContent = fs.readFileSync(configPath, 'utf8');
      const envLines = envContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
      for (const line of envLines) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=').trim();
        if (key && value && !process.env[key]) { // env-read: dynamic(copies arbitrary keys parsed from the loaded .env file into process.env — documented module-load mutation)
          process.env[key] = value; // env-read: dynamic(same .env-file key copy — write side of the documented mutation)
        }
      }
    } catch {
      logger.warn(`⚠️ [MCP] Failed to load config from: ${configPath}`);
    }
  }
}

// Validate required variables
try {
  dotenvSafe.config({
    example: envExamplePath,
    allowEmptyValues: true,
    path: false as any // Don't load any .env file, just validate current process.env
  });
  logger.info('✅ [MCP] Environment variable validation passed');
} catch (error) {
  logger.error('❌ [MCP] Environment variable validation failed', error as Error);
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  } else {
    logger.warn('⚠️  [MCP] Continuing in development mode despite validation errors');
  }
}

/**
 * Database Configuration for Mandrel
 *
 * This sets up our PostgreSQL connection pool with proper error handling
 * and reconnection logic. The pool manages multiple database connections
 * efficiently, which is crucial for a high-performance MCP server.
 */

/**
 * POOL TUNABLES — named + env-overridable (standing rule: NO HARDCODED VARIABLES).
 *
 * These were literals (20 / 30000 / 2000) until an earlier task. Defaults are
 * UNCHANGED, so prod behaviour is byte-identical; what changes is that a caller can now
 * BOUND the pool's footprint.
 *
 * WHY THIS MATTERS (the root cause). A Postgres server's client-connection
 * slots (`max_connections` minus `superuser_reserved_connections`) are a BOX-WIDE shared
 * resource — every database and every process on the host draws from the same pool of
 * slots. The mcp-server test suite runs all ~170 files in ONE process (vitest
 * `singleFork`), and each file re-evaluates THIS module, creating a NEW `Pool` that is
 * never `end()`ed. Each abandoned pool keeps its connections open for
 * `idleTimeoutMillis` (30s by default) — long enough that ~40 files' worth of pools
 * overlap. Measured footprint on an unmodified suite: a plateau of ~77-84 concurrent
 * connections and a peak of 81, against 97 usable slots. The suite was therefore running
 * at ~84% of the entire host's connection capacity and periodically exhausting it, which
 * surfaces as SQLSTATE 53300 ("remaining connection slots are reserved for roles with
 * the SUPERUSER attribute") on whichever query happens to be unlucky.
 *
 * `idleTimeoutMillis` is the dominant term (it sets how long a dead pool squats on its
 * connections), not `max` — the suite is sequential, so each pool only ever opens a
 * couple. CI pins both down.
 */
/** Max connections a single pool may open. Default 20 (unchanged). */
const POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || '20', 10);
/** How long an idle connection is kept before the pool closes it. Default 30000ms (unchanged). */
const POOL_IDLE_TIMEOUT_MS = parseInt(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS || '30000', 10);
/** How long to wait to acquire a connection before erroring. Default 2000ms (unchanged). */
const POOL_CONNECTION_TIMEOUT_MS = parseInt(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS || '2000', 10);

const dbConfig: PoolConfig = {
  user: process.env.DATABASE_USER || 'mandrel',
  host: process.env.DATABASE_HOST || 'localhost',
  database: process.env.DATABASE_NAME || (() => {
    throw new Error('DATABASE_NAME environment variable is required!');
  })(),
  password: process.env.DATABASE_PASSWORD || '',
  port: parseInt(process.env.DATABASE_PORT || '5432'),

  // Connection pool settings (see POOL TUNABLES above — named, env-overridable).
  max: POOL_MAX,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,

  // SSL is env-controlled (default OFF). Honor DATABASE_SSL / DB_SSL so the
  // internal no-SSL container postgres connects, while prod can still enable it.
  ssl: ((process.env.DATABASE_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'true')
    ? { rejectUnauthorized: false }
    : false,
};

// Create the connection pool.
//
// DATASTORE ERROR BOUNDARY. `guardPool` wraps this pool's `query` AND the
// `PoolClient.query` handed out by `connect`, converting ANY driver failure into a
// caller-safe `DatastoreError` before a handler can see it — and logging the raw detail
// server-side under a correlation ref. THIS pool is the one every tool reaches: the ~270
// `db.query` / `pool.query` / `client.query` call sites in src/ either import `db` directly
// or take `pool: Pool = db` as a defaulted parameter, and every `client` comes from
// `db.connect()`. Installing it HERE — at the single construction site — is what makes the
// leak unreachable instead of relying on ~104 catch blocks to be careful.
// See utils/datastoreError.ts for the full rationale.
export const db = guardPool(new Pool(dbConfig));

// ivfflat recall fix: pgvector defaults ivfflat.probes = 1, which only
// scans ONE index list → poor recall on the ANN vector search. Set it (config-driven, per
// the active embedder) on EVERY pooled connection at connect time, so both store and
// search queries — whichever connection the pool hands out — use the tuned probe count.
db.on('connect', (client) => {
  const probes = activeEmbedder().indexProbes;
  // Integer from config (never user input) — safe to inline. SET can't be parameterized.
  client.query(`SET ivfflat.probes = ${probes}`).catch((err) => {
    logger.warn(`⚠️  Failed to set ivfflat.probes=${probes} on new connection`, { metadata: { err: (err as Error).message } });
  });
});

// Log database connection details on startup
logger.info(`🗄️  Database Configuration:`);
logger.info(`   📊 Database: ${dbConfig.database}`);
logger.info(`   🏠 Host: ${dbConfig.host}:${dbConfig.port}`);
logger.info(`   👤 User: ${dbConfig.user}`);
logger.info(`   📦 Pool Size: ${dbConfig.max} connections`);

/**
 * Initialize database connection and verify pgvector extension
 */
export async function initializeDatabase(): Promise<void> {
  try {
    // Test the connection
    const client = await db.connect();
    logger.info('✅ Database connection established successfully');
    
    // Only run self-tests in development or when explicitly enabled
    // In production, assume DB is properly configured and skip CREATE EXTENSION/test tables
    const shouldRunSelfTests =
      process.env.NODE_ENV !== 'production' ||
      process.env.MANDREL_DB_SELFTEST === 'true';
    
    if (shouldRunSelfTests) {
      // Check if pgvector extension is installed
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        logger.info('✅ pgvector extension is ready');
      } catch {
        logger.warn('⚠️  pgvector extension not available - vector search will be limited');
        logger.warn('Please install postgresql-pgvector package on your system');
      }
      
      // Verify we can create vector columns (test)
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS vector_test (
            id SERIAL PRIMARY KEY,
            embedding VECTOR(1536)
          )
        `);
        await client.query('DROP TABLE vector_test');
        logger.info('✅ Vector operations confirmed working');
      } catch {
        logger.warn('⚠️  Vector operations not available');
      }
    } else {
      logger.info('⏭️  Skipping DB self-tests (production mode)');
      logger.info('💡 Ensure pgvector extension is installed: CREATE EXTENSION vector;');
    }
    
    client.release();
  } catch (error) {
    logger.error('❌ Database connection failed', error as Error);
    throw error;
  }
}

/**
 * Gracefully close database connections
 */
export async function closeDatabase(): Promise<void> {
  try {
    await db.end();
    logger.info('✅ Database connections closed');
  } catch (error) {
    logger.error('❌ Error closing database', error as Error);
  }
}

// Handle graceful shutdown
process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);