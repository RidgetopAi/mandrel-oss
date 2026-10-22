import { Pool, PoolClient, QueryResult } from 'pg';
import { dbLogger } from '../config/logger';

/**
 * Database query logging wrapper
 */
export class DatabaseLogger {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    this.setupPoolLogging();
  }

  /**
   * Setup pool event logging
   */
  private setupPoolLogging(): void {
    this.pool.on('connect', () => {
      dbLogger.info('Database connection established', {
        event: 'connection_established',
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount,
        timestamp: new Date().toISOString()
      });
    });

    this.pool.on('acquire', () => {
      dbLogger.debug('Database client acquired from pool', {
        event: 'client_acquired',
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount
      });
    });

    this.pool.on('release', (err: Error | undefined) => {
      if (err) {
        dbLogger.error('Database client released with error', {
          event: 'client_release_error',
          error: err.message,
          stack: err.stack,
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount
        });
      } else {
        dbLogger.debug('Database client released to pool', {
          event: 'client_released',
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount
        });
      }
    });

    this.pool.on('remove', () => {
      dbLogger.warn('Database client removed from pool', {
        event: 'client_removed',
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        timestamp: new Date().toISOString()
      });
    });

    this.pool.on('error', (err: Error) => {
      dbLogger.error('Database pool error', {
        event: 'pool_error',
        error: err.message,
        stack: err.stack,
        totalCount: this.pool.totalCount,
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * Execute query with logging
   */
  async query(
    text: string,
    params?: any[],
    correlationId?: string
  ): Promise<QueryResult> {
    const startTime = Date.now();
    const queryMetadata = {
      correlationId,
      query: this.sanitizeQuery(text),
      paramCount: params ? params.length : 0,
      timestamp: new Date().toISOString()
    };

    try {
      dbLogger.debug('Executing database query', queryMetadata);
      
      const result = await this.pool.query(text, params);
      const duration = Date.now() - startTime;
      
      const resultMetadata = {
        ...queryMetadata,
        duration,
        rowCount: result.rowCount,
        fieldCount: result.fields?.length || 0,
        success: true
      };

      // Log slow queries as warnings
      if (duration > 1000) {
        dbLogger.warn('Slow database query detected', {
          ...resultMetadata,
          event: 'slow_query',
          severity: duration > 5000 ? 'high' : 'medium'
        });
      } else {
        dbLogger.debug('Database query completed', resultMetadata);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMetadata = {
        ...queryMetadata,
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        success: false,
        event: 'query_error'
      };

      dbLogger.error('Database query failed', errorMetadata);
      throw error;
    }
  }

  /**
   * Get a client with logging
   */
  async connect(): Promise<PoolClient> {
    const startTime = Date.now();
    
    try {
      const client = await this.pool.connect();
      const duration = Date.now() - startTime;
      
      dbLogger.debug('Database client acquired', {
        duration,
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount,
        event: 'client_connect'
      });

      // Wrap client query method for logging
      const originalQuery = client.query.bind(client);
      (client as any).query = async (text: string, params?: any[]) => {
        return this.logClientQuery(originalQuery, text, params);
      };

      return client;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      dbLogger.error('Failed to acquire database client', {
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        totalCount: this.pool.totalCount,
        waitingCount: this.pool.waitingCount,
        event: 'client_connect_error'
      });

      throw error;
    }
  }

  /**
   * Log individual client queries
   */
  private async logClientQuery(
    originalQuery: Function,
    text: string,
    params?: any[]
  ): Promise<QueryResult> {
    const startTime = Date.now();
    
    try {
      const result = await originalQuery(text, params);
      const duration = Date.now() - startTime;
      
      if (duration > 500) {
        dbLogger.warn('Slow client query', {
          query: this.sanitizeQuery(text),
          duration,
          rowCount: result.rowCount,
          event: 'slow_client_query'
        });
      }

      return result;
    } catch (error) {
      dbLogger.error('Client query error', {
        query: this.sanitizeQuery(text),
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        event: 'client_query_error'
      });
      throw error;
    }
  }

  /**
   * Sanitize query for logging (remove sensitive data)
   */
  private sanitizeQuery(query: string): string {
    // Remove potential passwords, tokens, etc. from queries
    return query
      .replace(/password\s*=\s*'[^']*'/gi, "password = '[REDACTED]'")
      .replace(/token\s*=\s*'[^']*'/gi, "token = '[REDACTED]'")
      .replace(/secret\s*=\s*'[^']*'/gi, "secret = '[REDACTED]'")
      .replace(/\$\d+/g, '$?') // Replace parameter placeholders
      .trim();
  }

  /**
   * Get connection pool stats
   */
  getPoolStats(): {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  } {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount
    };
  }

  /**
   * Log pool statistics
   */
  logPoolStats(): void {
    const stats = this.getPoolStats();
    dbLogger.info('Database pool statistics', {
      ...stats,
      event: 'pool_stats',
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Create database logger instance
 */
export const createDatabaseLogger = (pool: Pool): DatabaseLogger => {
  return new DatabaseLogger(pool);
};
