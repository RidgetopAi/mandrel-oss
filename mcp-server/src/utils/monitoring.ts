/**
 * ORACLE HARDENING: Basic Monitoring & Metrics
 * Lightweight monitoring without external dependencies
 */

import { logger } from './logger.js';
import { unrefTimer } from './unrefTimer.js';

interface Metric {
  name: string;
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

interface HealthCheck {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  message?: string;
  timestamp: number;
  responseTime?: number;
}

class SimpleMonitoring {
  private metrics: Map<string, Metric[]> = new Map();
  private healthChecks: Map<string, HealthCheck> = new Map();
  private readonly maxMetricHistory = 100;
  
  /**
   * Record a metric value
   */
  recordMetric(name: string, value: number, labels?: Record<string, string>) {
    const metric: Metric = {
      name,
      value,
      timestamp: Date.now(),
      labels
    };
    
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    
    const history = this.metrics.get(name)!;
    history.push(metric);
    
    // Keep only recent history
    if (history.length > this.maxMetricHistory) {
      history.shift();
    }
  }

  /**
   * Increment a counter metric
   */
  incrementCounter(name: string, labels?: Record<string, string>) {
    const current = this.getLatestMetric(name)?.value || 0;
    this.recordMetric(name, current + 1, labels);
  }

  /**
   * Record timing metric
   */
  recordTiming(name: string, startTime: number, labels?: Record<string, string>) {
    const duration = Date.now() - startTime;
    this.recordMetric(name, duration, labels);
  }

  /**
   * Record health check result
   */
  recordHealthCheck(name: string, status: 'healthy' | 'unhealthy' | 'degraded', message?: string, responseTime?: number) {
    this.healthChecks.set(name, {
      name,
      status,
      message,
      timestamp: Date.now(),
      responseTime
    });
  }

  /**
   * Get latest metric value
   */
  getLatestMetric(name: string): Metric | undefined {
    const history = this.metrics.get(name);
    return history ? history[history.length - 1] : undefined;
  }

  /**
   * Get metric statistics
   */
  getMetricStats(name: string, windowMs: number = 300000) { // 5 minute window
    const history = this.metrics.get(name);
    if (!history) return null;
    
    const cutoff = Date.now() - windowMs;
    const recent = history.filter(m => m.timestamp >= cutoff);
    
    if (recent.length === 0) return null;
    
    const values = recent.map(m => m.value);
    const sum = values.reduce((a, b) => a + b, 0);
    
    return {
      count: recent.length,
      sum,
      avg: sum / recent.length,
      min: Math.min(...values),
      max: Math.max(...values),
      latest: recent[recent.length - 1]?.value || 0
    };
  }

  /**
   * Get all health checks
   */
  getAllHealthChecks(): HealthCheck[] {
    return Array.from(this.healthChecks.values());
  }

  /**
   * Get overall system health
   */
  getSystemHealth(): { status: string; checks: HealthCheck[]; summary: any } {
    const checks = this.getAllHealthChecks();
    const healthy = checks.filter(c => c.status === 'healthy').length;
    const total = checks.length;
    
    let overallStatus = 'healthy';
    if (healthy === 0) {
      overallStatus = 'unhealthy';
    } else if (healthy < total) {
      overallStatus = 'degraded';
    }
    
    const summary = {
      totalChecks: total,
      healthyChecks: healthy,
      degradedChecks: checks.filter(c => c.status === 'degraded').length,
      unhealthyChecks: checks.filter(c => c.status === 'unhealthy').length,
      overallStatus
    };
    
    return { status: overallStatus, checks, summary };
  }

  /**
   * Get monitoring dashboard data
   */
  getDashboardData() {
    const now = Date.now();
    const fiveMinAgo = now - 300000; // 5 minutes
    
    return {
      timestamp: now,
      systemHealth: this.getSystemHealth(),
      keyMetrics: {
        requestCount: this.getMetricStats('mcp_requests_total'),
        requestDuration: this.getMetricStats('mcp_request_duration_ms'),
        errorCount: this.getMetricStats('mcp_errors_total'),
        dbConnections: this.getLatestMetric('db_connections_active')?.value || 0,
        memoryUsage: this.getLatestMetric('memory_usage_mb')?.value || 0
      },
      recentMetrics: Array.from(this.metrics.entries()).map(([name, history]) => ({
        name,
        recent: history.filter(m => m.timestamp >= fiveMinAgo)
      }))
    };
  }

  /**
   * Start background monitoring tasks.
   *
   * Every interval here is `.unref()`d. An unref'd interval still fires on
   * schedule; it simply stops being a reason for Node to keep the event loop alive. The
   * long-running server is unaffected because its listeners hold the loop open on their own.
   * A short-lived script that transitively imports this graph can now exit on its own instead
   * of hanging forever while the 60s health check keeps re-opening a DB connection.
   */
  startBackgroundMonitoring() {
    // System metrics every 30 seconds
    const systemMetricsInterval = unrefTimer(setInterval(() => {
      this.collectSystemMetrics();
    }, 30000));

    // Health checks every minute
    const healthCheckInterval = unrefTimer(setInterval(() => {
      this.runHealthChecks();
    }, 60000));

    // Cleanup old metrics every 5 minutes
    const cleanupInterval = unrefTimer(setInterval(() => {
      this.cleanupOldMetrics();
    }, 300000));

    // Return cleanup function
    return () => {
      clearInterval(systemMetricsInterval);
      clearInterval(healthCheckInterval);
      clearInterval(cleanupInterval);
    };
  }

  private collectSystemMetrics() {
    // Memory usage
    const memUsage = process.memoryUsage();
    this.recordMetric('memory_usage_mb', Math.round(memUsage.rss / 1024 / 1024));
    this.recordMetric('memory_heap_mb', Math.round(memUsage.heapUsed / 1024 / 1024));
    
    // Process uptime
    this.recordMetric('process_uptime_seconds', process.uptime());
  }

  private async runHealthChecks() {
    const startTime = Date.now();
    
    try {
      // Database health check
      const { db } = await import('../config/database.js');
      await db.query('SELECT 1');
      this.recordHealthCheck('database', 'healthy', 'Database connection OK', Date.now() - startTime);
    } catch (error) {
      const err = error as Error;
      this.recordHealthCheck('database', 'unhealthy', `Database error: ${err.message}`, Date.now() - startTime);
    }

    // Memory health check
    const memUsage = process.memoryUsage();
    const memUsageMB = memUsage.rss / 1024 / 1024;
    if (memUsageMB > 2048) { // 2GB threshold
      this.recordHealthCheck('memory', 'degraded', `High memory usage: ${memUsageMB.toFixed(0)}MB`);
    } else {
      this.recordHealthCheck('memory', 'healthy', `Memory usage OK: ${memUsageMB.toFixed(0)}MB`);
    }

    // Process health check
    this.recordHealthCheck('process', 'healthy', `Process running, uptime: ${Math.round(process.uptime())}s`);
  }

  private cleanupOldMetrics() {
    const cutoff = Date.now() - 3600000; // 1 hour
    
    for (const [name, history] of this.metrics.entries()) {
      const filtered = history.filter(m => m.timestamp >= cutoff);
      this.metrics.set(name, filtered);
    }
  }
}

// Global monitoring instance
export const monitoring = new SimpleMonitoring();

// ─────────────────────────────────────────────────────────────────────────────────────────
// LIFECYCLE — EXPLICIT, NOT AN IMPORT-TIME SIDE EFFECT.
//
// This module used to call startMonitoring() at module scope, so merely importing it — to
// read a type, a constant, or the `monitoring` counter object — started three uncleared
// intervals in EVERY process, including every test process and every one-off script. One of
// them issues `db.query('SELECT 1')` every 60s, which manufactured phantom DB calls against
// registry-wide spies and kept re-opening connections to databases a script had already
// closed. Starting is now the caller's decision: `services/backgroundServices.ts` calls
// startMonitoring() during server boot and stopMonitoring() during shutdown.
// ─────────────────────────────────────────────────────────────────────────────────────────

let backgroundCleanup: (() => void) | null = null;

/**
 * Start the background monitoring timers. Idempotent: a second call while already running
 * is a no-op, so a double-boot cannot double the timers.
 */
export function startMonitoring(): void {
  if (!backgroundCleanup) {
    backgroundCleanup = monitoring.startBackgroundMonitoring();
    logger.info('📊 Background monitoring started');
  }
}

/**
 * Stop the background monitoring timers. Idempotent.
 */
export function stopMonitoring(): void {
  if (backgroundCleanup) {
    backgroundCleanup();
    backgroundCleanup = null;
    logger.info('📊 Background monitoring stopped');
  }
}

/** Whether the background monitoring timers are currently running. */
export function isMonitoringStarted(): boolean {
  return backgroundCleanup !== null;
}
