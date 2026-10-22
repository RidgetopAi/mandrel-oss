/**
 * TR009-4: Standardized Health Check System
 *
 * Provides comprehensive health monitoring for all AIDIS services
 * with standardized endpoints and response formats
 */

import { dbPool, getPoolStats } from './databasePool.js';
import { getQueueManager } from './queueManager.js';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { logger } from '../utils/logger.js';

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: {
    [key: string]: ComponentHealth;
  };
  version?: string;
  environment?: string;
}

export interface ComponentHealth {
  status: 'up' | 'down' | 'degraded';
  message?: string;
  responseTime?: number;
  metadata?: Record<string, any>;
}

export class HealthCheckService {
  private static instance: HealthCheckService;
  private startTime: number;
  private healthChecks: Map<string, () => Promise<ComponentHealth>>;

  private constructor() {
    this.startTime = Date.now();
    this.healthChecks = new Map();
    this.registerDefaultChecks();
  }

  static getInstance(): HealthCheckService {
    if (!HealthCheckService.instance) {
      HealthCheckService.instance = new HealthCheckService();
    }
    return HealthCheckService.instance;
  }

  /**
   * Register default health checks for core components
   */
  private registerDefaultChecks(): void {
    // Database health check
    this.registerCheck('database', async () => {
      const startTime = Date.now();
      try {
        const health = await dbPool.healthCheck();
        const stats = getPoolStats();

        return {
          status: health.healthy ? 'up' : 'down',
          responseTime: Date.now() - startTime,
          metadata: {
            pool: {
              total: stats.totalCount,
              active: stats.activeQueries,
              idle: stats.idleCount,
              waiting: stats.waitingCount,
              utilization: `${stats.poolUtilization.toFixed(1)}%`,
              health: stats.healthStatus
            }
          }
        };
      } catch (error) {
        return {
          status: 'down',
          message: error instanceof Error ? error.message : 'Unknown error',
          responseTime: Date.now() - startTime
        };
      }
    });

    // Redis/Queue health check
    this.registerCheck('queue', async () => {
      const startTime = Date.now();
      try {
        const queueManager = await getQueueManager();
        const stats = await queueManager.getStats();
        const isHealthy = stats.active !== undefined;

        return {
          status: isHealthy ? 'up' : 'down',
          responseTime: Date.now() - startTime,
          metadata: {
            active: stats.active,
            waiting: stats.waiting,
            completed: stats.completed,
            failed: stats.failed
          }
        };
      } catch (error) {
        return {
          status: 'down',
          message: error instanceof Error ? error.message : 'Queue not initialized',
          responseTime: Date.now() - startTime
        };
      }
    });

    // Memory health check
    this.registerCheck('memory', async () => {
      const startTime = Date.now();
      const memUsage = process.memoryUsage();
      const heapUsed = memUsage.heapUsed / 1024 / 1024; // MB
      const heapTotal = memUsage.heapTotal / 1024 / 1024; // MB
      const rss = memUsage.rss / 1024 / 1024; // MB
      const utilization = (heapUsed / heapTotal) * 100;

      let status: 'up' | 'degraded' | 'down' = 'up';
      if (utilization > 90 || rss > 1024) {
        status = 'down';
      } else if (utilization > 75 || rss > 768) {
        status = 'degraded';
      }

      return {
        status,
        responseTime: Date.now() - startTime,
        metadata: {
          heapUsed: `${heapUsed.toFixed(2)} MB`,
          heapTotal: `${heapTotal.toFixed(2)} MB`,
          rss: `${rss.toFixed(2)} MB`,
          utilization: `${utilization.toFixed(1)}%`
        }
      };
    });

    // File system health check
    this.registerCheck('filesystem', async () => {
      const startTime = Date.now();
      try {
        const fs = await import('fs/promises');
        const testFile = '/tmp/aidis-health-check.txt';

        // Test write
        await fs.writeFile(testFile, 'health check test');

        // Test read
        await fs.readFile(testFile, 'utf-8');

        // Test delete
        await fs.unlink(testFile);

        return {
          status: 'up',
          responseTime: Date.now() - startTime,
          message: 'File system operations successful'
        };
      } catch (error) {
        return {
          status: 'down',
          message: error instanceof Error ? error.message : 'File system error',
          responseTime: Date.now() - startTime
        };
      }
    });
  }

  /**
   * Register a custom health check
   */
  registerCheck(name: string, check: () => Promise<ComponentHealth>): void {
    this.healthChecks.set(name, check);
  }

  /**
   * Remove a health check
   */
  unregisterCheck(name: string): void {
    this.healthChecks.delete(name);
  }

  /**
   * Run all health checks
   */
  async checkHealth(): Promise<HealthCheckResult> {
    const checks: { [key: string]: ComponentHealth } = {};
    const promises: Promise<void>[] = [];

    // Run all checks in parallel
    for (const [name, check] of this.healthChecks) {
      promises.push(
        check()
          .then(result => {
            checks[name] = result;
          })
          .catch(error => {
            checks[name] = {
              status: 'down',
              message: error instanceof Error ? error.message : 'Check failed'
            };
          })
      );
    }

    await Promise.all(promises);

    // Determine overall status
    const statuses = Object.values(checks).map(c => c.status);
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (statuses.includes('down')) {
      overallStatus = 'unhealthy';
    } else if (statuses.includes('degraded')) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks,
      version: process.env.AIDIS_VERSION || '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    };
  }

  /**
   * Liveness check - simple ping to verify service is running
   */
  async checkLiveness(): Promise<boolean> {
    return true;
  }

  /**
   * Readiness check - verify all critical dependencies are available
   */
  async checkReadiness(): Promise<boolean> {
    const health = await this.checkHealth();
    return health.status !== 'unhealthy';
  }

  /**
   * Check external service health
   */
  async checkExternalService(url: string, timeout: number = 5000): Promise<ComponentHealth> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const request = client.get(url, (res) => {
        const responseTime = Date.now() - startTime;

        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          resolve({
            status: 'up',
            responseTime,
            metadata: { statusCode: res.statusCode }
          });
        } else {
          resolve({
            status: 'down',
            message: `HTTP ${res.statusCode}`,
            responseTime,
            metadata: { statusCode: res.statusCode }
          });
        }
      });

      request.on('error', (error) => {
        resolve({
          status: 'down',
          message: error.message,
          responseTime: Date.now() - startTime
        });
      });

      request.setTimeout(timeout, () => {
        request.destroy();
        resolve({
          status: 'down',
          message: 'Timeout',
          responseTime: timeout
        });
      });
    });
  }
}

// Export singleton instance
export const healthCheckService = HealthCheckService.getInstance();

/**
 * Express/HTTP middleware for health check endpoints
 */
export function createHealthCheckMiddleware() {
  return async (req: any, res: any, next: any) => {
    // Skip if not a health check endpoint
    if (!req.url || (!req.url.startsWith('/health') && !req.url.startsWith('/live') && !req.url.startsWith('/ready'))) {
      return next();
    }

    res.setHeader('Content-Type', 'application/json');

    try {
      // Liveness check - /liveness or /livez
      if (req.url.startsWith('/live')) {
        const isAlive = await healthCheckService.checkLiveness();
        res.statusCode = isAlive ? 200 : 503;
        res.end(JSON.stringify({
          status: isAlive ? 'alive' : 'dead',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // Readiness check - /readiness or /readyz
      if (req.url.startsWith('/ready')) {
        const isReady = await healthCheckService.checkReadiness();
        const health = await healthCheckService.checkHealth();
        res.statusCode = isReady ? 200 : 503;
        res.end(JSON.stringify({
          ready: isReady,
          ...health
        }));
        return;
      }

      // Full health check - /health or /healthz
      const health = await healthCheckService.checkHealth();
      res.statusCode = health.status === 'unhealthy' ? 503 : 200;
      res.end(JSON.stringify(health));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({
        status: 'error',
        message: error instanceof Error ? error.message : 'Health check failed',
        timestamp: new Date().toISOString()
      }));
    }
  };
}

/**
 * Create standalone health check server
 */
export function createHealthCheckServer(port: number = 9090): http.Server {
  const middleware = createHealthCheckMiddleware();

  // Wrap middleware to work with http.createServer (2-param signature)
  const server = http.createServer(async (req, res) => {
    await middleware(req, res, () => {
      // No-op next function for standalone server
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not Found' }));
    });
  });

  server.listen(port, () => {
    logger.info(`🏥 Health check server listening on port ${port}`);
    logger.info(`   📍 Endpoints available:`);
    logger.info(`      - http://localhost:${port}/health   (full health check)`);
    logger.info(`      - http://localhost:${port}/livez    (liveness probe)`);
    logger.info(`      - http://localhost:${port}/readyz   (readiness probe)`);
  });

  return server;
}