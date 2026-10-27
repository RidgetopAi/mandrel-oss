import { Pool, PoolConfig, PoolClient } from 'pg';
import { logger } from '../utils/logger.js';
import { unrefTimer } from '../utils/unrefTimer.js';
import { guardPool } from '../utils/datastoreError.js';
import { ConnectionLeakTracker, DEFAULT_CONNECTION_LEAK_THRESHOLD_MS } from './connectionLeakTracker.js';

/**
 * TR008-4: Optimized Database Connection Pool Manager
 *
 * Features:
 * - Singleton pool instance to prevent multiple pool creations
 * - Automatic connection health checks
 * - Connection retry logic with exponential backoff
 * - Pool statistics and monitoring
 * - Graceful shutdown handling
 * - Connection leak detection
 */

interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeQueries: number;
  poolUtilization: number;
  connectionErrors: number;
  lastError?: string;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy';
}

interface ConnectionOptions {
  retries?: number;
  retryDelay?: number;
  priority?: 'high' | 'normal' | 'low';
  timeout?: number;
}

class DatabasePoolManager {
  private static instance: DatabasePoolManager;
  private pool: Pool | null = null;
  private isInitialized = false;
  private connectionErrors = 0;
  private lastError: string | undefined;
  private activeConnections = new ConnectionLeakTracker(
    parseInt(process.env.MANDREL_DB_CONNECTION_LEAK_THRESHOLD_MS || '', 10) ||
      DEFAULT_CONNECTION_LEAK_THRESHOLD_MS
  );
  /**
   * Handle for the pool-health poller. It used to be discarded at the call site, which meant
   * that once initialize() ran there was no way to stop it for the life of the process —
   * a strictly worse defect than the ref'd-timer one, because unref cannot fix it.
   * close() clears it now.
   */
  private poolHealthTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): DatabasePoolManager {
    if (!DatabasePoolManager.instance) {
      DatabasePoolManager.instance = new DatabasePoolManager();
    }
    return DatabasePoolManager.instance;
  }

  /**
   * Initialize the database pool with optimized settings
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('📦 Database pool already initialized');
      return;
    }

    const dbUser = process.env.DATABASE_USER || 'mandrel';
    const dbHost = process.env.DATABASE_HOST || 'localhost';
    const dbName = process.env.DATABASE_NAME || 'mandrel';
    const dbPassword = process.env.DATABASE_PASSWORD || '';
    const dbPort = parseInt(process.env.DATABASE_PORT || '5432');

    const poolConfig: PoolConfig = {
      user: dbUser,
      host: dbHost,
      database: dbName,
      password: dbPassword,
      port: dbPort,

      // Optimized pool settings for Phase 4
      max: 30, // Increased from 20 for service mesh architecture
      min: 5, // Maintain minimum connections for fast response
      idleTimeoutMillis: 30000, // Keep idle connections for 30s
      connectionTimeoutMillis: 5000, // Increased timeout for container environment
      maxUses: 7500, // Recycle connections after 7500 uses

      // Enable statement timeout to prevent long-running queries
      statement_timeout: 30000, // 30 seconds
      query_timeout: 30000,

      // SSL is env-controlled (default OFF). Honor DATABASE_SSL / DB_SSL so the
      // internal no-SSL container postgres connects, while prod can still enable it.
      ssl: ((process.env.DATABASE_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'true')
        ? { rejectUnauthorized: false }
        : false,
    };

    // DATASTORE ERROR BOUNDARY — the SECOND pg Pool in the process.
    // `healthServer.ts` calls poolHealthCheck() on it and the exported `query`/`transaction`
    // helpers are callable from anywhere, so a driver error escaping here could reach a
    // caller-visible surface exactly as one from `config/database.ts` could. Guarded at the
    // same construction-site grain, for the same reason: one pool, one doorway.
    this.pool = guardPool(new Pool(poolConfig));

    // Set up error handling.
    //
    // THIS LISTENER MUST NOT THROW (the P0 that killed prod). It runs inside
    // pool.emit('error', …). A throw here escapes emit() as an uncaughtException and reaches
    // processLock's handler, which calls process.exit(1) — i.e. it re-creates the exact bug
    // guardPool() was just hardened against, one layer over. `err` is typed as Error but is
    // whatever the driver emitted, so `err.message` on a non-Error would be that throw.
    // guardPool()'s own onPoolError is degenerate-value hardened; this second listener is the
    // OTHER path, and C5 says fix one, then show the others.
    this.pool.on('error', (err) => {
      logger.error('❌ Unexpected database pool error', err as Error);
      this.connectionErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
    });

    this.pool.on('connect', (_client) => {
      logger.info('✅ New database client connected to pool');
    });

    // Checked-out tracking: set on acquire, forgotten on release/remove (keyed by client).
    this.activeConnections.attach(this.pool);

    // Test the connection
    try {
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW() as current_time, version() as version');
      logger.info('✅ Database pool initialized successfully');
      logger.info(`📊 Database: ${poolConfig.database}`);
      logger.info(`🏠 Host: ${poolConfig.host}:${poolConfig.port}`);
      logger.info(`📦 Pool Size: ${poolConfig.min}-${poolConfig.max} connections`);
      logger.info(`⏰ Current Time: ${result.rows[0].current_time}`);
      client.release();

      this.isInitialized = true;
      this.startPoolHealthMonitoring();
    } catch (error) {
      logger.error('❌ Failed to initialize database pool', error as Error);
      throw error;
    }
  }

  /**
   * Get a connection from the pool with retry logic
   */
  async getConnection(options: ConnectionOptions = {}): Promise<PoolClient> {
    const { retries = 3, retryDelay = 1000, timeout = 5000 } = options;

    if (!this.pool || !this.isInitialized) {
      await this.initialize();
    }

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const client = await Promise.race([
          this.pool!.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), timeout)
          ),
        ]);

        // Reset error counter on successful connection
        if (this.connectionErrors > 0) {
          this.connectionErrors = 0;
        }

        return client;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`⚠️  Database connection attempt ${attempt}/${retries} failed`, { metadata: { error: lastError.message } });

        if (attempt < retries) {
          // Exponential backoff
          const delay = retryDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    this.connectionErrors++;
    this.lastError = lastError?.message;
    throw new Error(`Failed to get database connection after ${retries} attempts: ${lastError?.message}`);
  }

  /**
   * Execute a query with automatic connection management
   */
  async query<T = any>(sql: string, params: any[] = [], options: ConnectionOptions = {}): Promise<T[]> {
    const client = await this.getConnection(options);
    try {
      const result = await client.query(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Execute a transaction with automatic rollback on error
   */
  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
    options: ConnectionOptions = {}
  ): Promise<T> {
    const client = await this.getConnection(options);

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get pool statistics for monitoring
   */
  getStats(): PoolStats {
    if (!this.pool) {
      return {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        activeQueries: 0,
        poolUtilization: 0,
        connectionErrors: this.connectionErrors,
        lastError: this.lastError,
        healthStatus: 'unhealthy',
      };
    }

    const totalCount = this.pool.totalCount;
    const idleCount = this.pool.idleCount;
    const waitingCount = this.pool.waitingCount;
    const activeQueries = totalCount - idleCount;
    const poolUtilization = totalCount > 0 ? (activeQueries / totalCount) * 100 : 0;

    let healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (this.connectionErrors > 5 || poolUtilization > 90) {
      healthStatus = 'unhealthy';
    } else if (this.connectionErrors > 0 || poolUtilization > 70) {
      healthStatus = 'degraded';
    }

    return {
      totalCount,
      idleCount,
      waitingCount,
      activeQueries,
      poolUtilization,
      connectionErrors: this.connectionErrors,
      lastError: this.lastError,
      healthStatus,
    };
  }

  /**
   * Check for connection leaks
   */
  private checkForLeaks(): void {
    const leaks = this.activeConnections.findLeaks();

    if (leaks.length > 0) {
      logger.warn('⚠️  Potential connection leaks detected', { metadata: { leaks } });
    }
  }

  /**
   * Start monitoring the pool health.
   *
   * NOT the same thing as `startMonitoring()` in utils/monitoring.ts, which collects process
   * metrics — this one polls THIS pool. The names collided; this one is renamed so a reader
   * cannot conflate them.
   *
   * The handle is retained and unref'd: retained so stopPoolHealthMonitoring()
   * has something to clear, unref'd so a short-lived process that called initialize() can
   * still exit. Guarded against a double start so a second initialize() cannot orphan a timer.
   */
  private startPoolHealthMonitoring(): void {
    if (this.poolHealthTimer) return;

    // Check pool health every 30 seconds
    this.poolHealthTimer = unrefTimer(setInterval(() => {
      const stats = this.getStats();

      if (stats.healthStatus === 'unhealthy') {
        logger.error('🚨 Database pool health check failed', undefined, { metadata: { stats } });
      } else if (stats.healthStatus === 'degraded') {
        logger.warn('⚠️  Database pool health degraded', { metadata: { stats } });
      }

      // Check for connection leaks
      this.checkForLeaks();

      // Log stats in development
      if (process.env.NODE_ENV === 'development') {
        logger.info('📊 Database Pool Stats', {
          metadata: {
            ...stats,
            activeConnections: this.activeConnections.size,
          },
        });
      }
    }, 30000));
  }

  /**
   * Stop the pool-health poller. Idempotent; safe to call when it was never started.
   * UNGUARDED: no automated test covers this stop path; proving it needs a live pool.
   */
  private stopPoolHealthMonitoring(): void {
    if (this.poolHealthTimer) {
      clearInterval(this.poolHealthTimer);
      this.poolHealthTimer = null;
    }
  }

  /**
   * Health check for the database connection
   */
  async healthCheck(): Promise<{ healthy: boolean; details: PoolStats }> {
    try {
      await this.query('SELECT 1');
      const stats = this.getStats();
      return {
        healthy: stats.healthStatus !== 'unhealthy',
        details: stats,
      };
    } catch (error) {
      // NEVER swallow this silently. `healthy: false` is what
      // /readyz publishes and what the test-harness readiness wait polls — so when the
      // host is out of Postgres client slots, this catch is where the ONLY statement of
      // the reason (SQLSTATE 53300) existed, and a bare `catch {}` deleted it. The
      // downstream symptom is a readiness TIMEOUT in a setup hook, i.e. a vitest FAILURE
      // reported as a code RED, with no trace of the infrastructure fault anywhere in the
      // gate's app logs. Log the SQLSTATE explicitly: the gate's connection-exhaustion
      // invalidator reads it, and a human reading the
      // log needs it more.
      const err = error as Error & { code?: string };
      logger.warn('⚠️  Database pool health check FAILED', {
        metadata: { error: err?.message, code: err?.code },
      });
      return {
        healthy: false,
        details: this.getStats(),
      };
    }
  }

  /**
   * Gracefully close all connections
   */
  async close(): Promise<void> {
    if (!this.pool) return;

    try {
      // Before the pool goes away, so a closed pool cannot be polled by a surviving timer.
      this.stopPoolHealthMonitoring();
      await this.pool.end();
      logger.info('✅ Database pool connections closed gracefully');
      this.isInitialized = false;
      this.pool = null;
      this.activeConnections.clear();
    } catch (error) {
      logger.error('❌ Error closing database pool', error as Error);
      throw error;
    }
  }
}

// Export singleton instance
export const dbPool = DatabasePoolManager.getInstance();

// Export convenience functions
export const getConnection = (options?: ConnectionOptions) => dbPool.getConnection(options);
export const query = <T = any>(sql: string, params?: any[], options?: ConnectionOptions) =>
  dbPool.query<T>(sql, params, options);
export const transaction = <T>(
  callback: (client: PoolClient) => Promise<T>,
  options?: ConnectionOptions
) => dbPool.transaction(callback, options);
export const getPoolStats = () => dbPool.getStats();
export const poolHealthCheck = () => dbPool.healthCheck();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('\n🛑 Received SIGINT, closing database pool...');
  await dbPool.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('\n🛑 Received SIGTERM, closing database pool...');
  await dbPool.close();
  process.exit(0);
});