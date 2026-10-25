import { Pool, PoolConfig, PoolClient } from 'pg';
import { config } from '../config/environment';
import { dbLogger } from '../config/logger';

/**
 * TR008-4: Optimized Database Pool Manager for Backend Service
 *
 * Features:
 * - Singleton pattern to prevent multiple pools
 * - Connection health monitoring
 * - Pool statistics and metrics
 * - Automatic retry with exponential backoff
 * - Graceful shutdown handling
 */

interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeQueries: number;
  poolUtilization: number;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy';
}

class BackendPoolManager {
  private static instance: BackendPoolManager;
  /** Handle for the pool-health interval, so close() can clear it. See startMonitoring(). */
  private monitoringTimer: NodeJS.Timeout | null = null;
  private pool: Pool | null = null;
  private isInitialized = false;
  private connectionErrors = 0;

  private constructor() {}

  static getInstance(): BackendPoolManager {
    if (!BackendPoolManager.instance) {
      BackendPoolManager.instance = new BackendPoolManager();
    }
    return BackendPoolManager.instance;
  }

  /**
   * Initialize the database pool with optimized settings for backend service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      dbLogger.info('Database pool already initialized');
      return;
    }

    const poolConfig: PoolConfig = {
      user: config.database.user,
      host: config.database.host,
      database: config.database.database,
      password: config.database.password,
      port: config.database.port,

      // Optimized pool settings for backend service
      max: 15, // Backend needs fewer connections than MCP server
      min: 3, // Maintain minimum connections
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      maxUses: 7500, // Recycle connections after 7500 uses

      // allowExitOnIdle — AN IDLE POOL MUST NEVER BE THE REASON A PROCESS STAYS ALIVE.
      //
      // The sibling `.unref()` on the monitoring timer below fixed the
      // TIMER half of this and left the CLIENT half open, so the gate went on hanging.
      // MEASURED on ref 797f00d: with the full backend suite finished and reported
      // (1524 passed), `process.getActiveResourcesInfo()` in the still-running jest
      // process returned exactly ONE entry — ["TCPSocketWrap"] — and its creation stack
      // was BackendPoolManager.initialize -> getConnection -> query -> healthCheck via
      // src/routes/health.ts. All 63 live intervals in that same dump reported
      // hasRef=false, i.e. no interval was holding the loop.
      //
      // WHY THAT SOCKET NEVER DRAINED: pg-pool arms the idleTimeoutMillis reaper only
      // while `_isAboveMin()` (pg-pool/index.js:116, :371), and `min: 3` above means the
      // last clients are never above min. So they idle FOREVER, ref'd, with no timer to
      // close them — a permanent event-loop hold that no test teardown can reach,
      // because the test never owned the singleton.
      //
      // allowExitOnIdle calls `client.unref()` on a client the moment it goes idle
      // (pg-pool/index.js:386) and `client.ref()` again when it is re-acquired
      // (pg-pool/index.js:153). So an in-flight query still holds the loop open, the
      // connection is NOT closed, and the long-running server is unaffected — its
      // event loop is held by app.listen, exactly as with the unref'd timer.
      allowExitOnIdle: true,

      // Enable statement timeout
      statement_timeout: 30000,
      query_timeout: 30000,

      // SSL is env-controlled (default OFF). Honor DATABASE_SSL / DB_SSL so the
      // internal no-SSL container postgres connects, while prod can still enable it.
      ssl: ((process.env.DATABASE_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'true')
        ? { rejectUnauthorized: false }
        : false,
    };

    this.pool = new Pool(poolConfig);

    // Set up error handling
    this.pool.on('error', (err) => {
      dbLogger.error('Database pool error', { error: err.message });
      this.connectionErrors++;
    });

    this.pool.on('connect', () => {
      dbLogger.debug('New client connected to pool');
    });

    // Test the connection
    try {
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW() as current_time');
      client.release();

      dbLogger.info('Database pool initialized successfully', {
        database: poolConfig.database,
        host: `${poolConfig.host}:${poolConfig.port}`,
        poolSize: `${poolConfig.min}-${poolConfig.max}`,
        time: result.rows[0].current_time
      });

      this.isInitialized = true;
      this.startMonitoring();
    } catch (error) {
      dbLogger.error('Failed to initialize database pool', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Get a connection from the pool with retry logic
   */
  async getConnection(retries = 3): Promise<PoolClient> {
    if (!this.pool || !this.isInitialized) {
      await this.initialize();
    }

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const client = await this.pool!.connect();

        // Reset error counter on successful connection
        if (this.connectionErrors > 0) {
          this.connectionErrors = 0;
        }

        return client;
      } catch (error) {
        lastError = error as Error;
        dbLogger.warn(`Connection attempt ${attempt}/${retries} failed`, {
          error: lastError.message
        });

        if (attempt < retries) {
          // Exponential backoff
          const delay = 1000 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    this.connectionErrors++;
    throw new Error(`Failed to get connection after ${retries} attempts: ${lastError?.message}`);
  }

  /**
   * Execute a query with automatic connection management
   */
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const client = await this.getConnection();
    try {
      const result = await client.query(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Execute a transaction with automatic rollback
   */
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getConnection();

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
   * Get pool statistics
   */
  getStats(): PoolStats {
    if (!this.pool) {
      return {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        activeQueries: 0,
        poolUtilization: 0,
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
      healthStatus,
    };
  }

  /**
   * Start monitoring the pool health
   */
  private startMonitoring(): void {
    // .unref() — A MONITORING TIMER MUST NEVER BE THE REASON A PROCESS STAYS ALIVE.
    //
    // This interval was never stored and never cleared, so it pinned the Node event loop
    // for the life of the process. `backendPool` is a LAZY singleton whose only reachable
    // constructor on the read path is `GET /api/healthz` (server.ts:9 has the direct import
    // commented out), so any process that served one healthz could not exit.
    //
    // MEASURED, by bisecting a 79-route sweep down to a single route: with `--runInBand
    // --ci` (the invocation the CI gate:2141 uses, WITHOUT --forceExit) one request to
    // /api/healthz left jest hanging; /api/livez next to it exited cleanly. The clean gate
    // hung 3h42m on exactly this, holding its lock and producing no verdict.
    //
    // The handle is now both unref'd (it cannot hold the loop open on its own) and stored
    // so close() can clear it (it does not survive a deliberate shutdown either). Both,
    // because unref alone would leave a timer running against a closed pool.
    this.monitoringTimer = setInterval(() => {
      const stats = this.getStats();

      // Log pool stats periodically
      dbLogger.debug('Pool statistics', {
        total: stats.totalCount,
        idle: stats.idleCount,
        active: stats.activeQueries,
        waiting: stats.waitingCount,
        utilization: `${stats.poolUtilization.toFixed(1)}%`,
        health: stats.healthStatus
      });

      // Alert on unhealthy state
      if (stats.healthStatus === 'unhealthy') {
        dbLogger.error('Database pool unhealthy', stats);
      } else if (stats.healthStatus === 'degraded') {
        dbLogger.warn('Database pool degraded', stats);
      }
    }, 60000); // Check every minute
    this.monitoringTimer.unref();
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
      return {
        healthy: false,
        details: this.getStats(),
      };
    }
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }
    if (!this.pool) return;

    try {
      await this.pool.end();
      dbLogger.info('Database pool closed');
      this.isInitialized = false;
      this.pool = null;
    } catch (error) {
      dbLogger.error('Error closing database pool', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
}

// Export singleton instance
export const backendPool = BackendPoolManager.getInstance();

// Export convenience functions
export const getConnection = () => backendPool.getConnection();
export const query = <T = any>(sql: string, params?: any[]) => backendPool.query<T>(sql, params);
export const transaction = <T>(callback: (client: PoolClient) => Promise<T>) =>
  backendPool.transaction(callback);
export const getPoolStats = () => backendPool.getStats();
export const poolHealthCheck = () => backendPool.healthCheck();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await backendPool.close();
});

process.on('SIGTERM', async () => {
  await backendPool.close();
});