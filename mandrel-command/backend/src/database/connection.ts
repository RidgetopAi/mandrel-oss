import { Pool, PoolConfig } from 'pg';
import { createDatabaseLogger } from '../middleware/databaseLogger';
import { dbLogger, logger } from '../config/logger';
import { config } from '../config/environment';

// Environment variables are loaded by ../config/environment.ts
// No need to call dotenv.config() again here

/**
 * Database Configuration for AIDIS Command
 * Uses the same configuration as the main AIDIS MCP server
 */
const dbConfig: PoolConfig = {
  user: config.database.user,
  host: config.database.host,
  database: config.database.database,
  password: config.database.password,
  port: config.database.port,
  
  // Connection pool settings
  max: 10, // Maximum number of connections for admin tool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,

  // allowExitOnIdle — same rule as poolManager.ts (see the long note there).
  // This pool sets no `min`, so its idle clients DO get reaped after
  // idleTimeoutMillis and it is not the permanent holder that poolManager's was.
  // It is fixed here anyway because the rule is "an idle pool never holds the loop",
  // not "the pool we caught doing it" — leaving the second of two product pools
  // un-unref'd is the same defect with a smaller number. The behavioural guard in
  // src/__tests__/idlePoolReleasesEventLoop.db.test.ts covers BOTH pools and asserts
  // that the two are the whole population.
  allowExitOnIdle: true,


  // SSL is env-controlled (default OFF). Honor DATABASE_SSL / DB_SSL so the
  // internal no-SSL container postgres connects, while prod can still enable it.
  ssl: ((process.env.DATABASE_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'true')
    ? { rejectUnauthorized: false }
    : false,
};

// Create the connection pool
export const db = new Pool(dbConfig);

// Create database logger instance
export const dbWithLogging = createDatabaseLogger(db);

/**
 * Initialize database connection and verify connectivity
 */
export async function initializeDatabase(): Promise<void> {
  try {
    dbLogger.info('Initializing database connection...', {
      host: dbConfig.host,
      database: dbConfig.database,
      user: dbConfig.user,
      port: dbConfig.port,
      ssl: !!dbConfig.ssl
    });

    const client = await db.connect();
    dbLogger.info('Database connection established successfully');
    
    // Test basic query using logged query
    const result = await dbWithLogging.query('SELECT NOW() as current_time', [], 'init');
    dbLogger.info('Database query test successful', {
      currentTime: result.rows[0].current_time
    });
    
    client.release();
    
    // Setup periodic pool stats logging.
    // .unref() for the same reason as the pool's allowExitOnIdle above and the
    // monitoring timer in poolManager.ts: a stats logger must never be the reason a
    // process stays alive. Un-unref'd, any short-lived script that called
    // initializeDatabase() could not exit — the same defect this file's pool had, one
    // handle type over. An unref'd interval still fires on schedule; the server's loop
    // is held by app.listen.
    // Exercised by src/__tests__/idlePoolReleasesEventLoop.db.test.ts.
    const poolStatsTimer = setInterval(() => {
      dbWithLogging.logPoolStats();
    }, 60000); // Log every minute
    poolStatsTimer.unref();


  } catch (error) {
    dbLogger.error('Database connection failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      config: {
        host: dbConfig.host,
        database: dbConfig.database,
        port: dbConfig.port
      }
    });
    throw error;
  }
}

/**
 * Check database health
 */
export async function checkDatabaseHealth(): Promise<{
  connected: boolean;
  timestamp: Date;
  version?: string;
  error?: string;
}> {
  try {
    const client = await db.connect();
    const result = await client.query('SELECT version() as version, NOW() as timestamp');
    client.release();
    
    return {
      connected: true,
      timestamp: result.rows[0].timestamp,
      version: result.rows[0].version
    };
  } catch (error) {
    return {
      connected: false,
      timestamp: new Date(),
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get basic database statistics
 */
export async function getDatabaseStats(): Promise<{
  total_connections: number;
  active_connections: number;
  pool_size: number;
  idle_connections: number;
}> {
  const client = await db.connect();
  const result = await client.query(`
    SELECT
      count(*) as total_connections,
      count(*) FILTER (WHERE state = 'active') as active_connections
    FROM pg_stat_activity
    WHERE datname = current_database()
  `);
  client.release();

  return {
    total_connections: parseInt(result.rows[0].total_connections),
    active_connections: parseInt(result.rows[0].active_connections),
    pool_size: db.totalCount,
    idle_connections: db.idleCount
  };
}

/**
 * Gracefully close database connections
 */
export async function closeDatabase(): Promise<void> {
  try {
    await db.end();
    logger.info('✅ Database connections closed');
  } catch (error) {
    logger.error('❌ Error closing database', { error });
  }
}

// Handle graceful shutdown
process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
