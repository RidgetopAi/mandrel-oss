/**
 * TR015-4: Enhanced Service Monitoring and Alerting
 * Oracle Refactor Phase 4 - Comprehensive Service Health Monitoring
 * Extends existing monitoring with service-specific boundaries from TR014-4
 */

import { db } from '../database/connection';
import os from 'os';
import axios from 'axios';
import { logger } from '../config/logger';

interface SystemMetrics {
  timestamp: number;
  system: {
    uptime: number;
    memory: {
      used: number;
      free: number;
      total: number;
      percentage: number;
    };
    cpu: {
      usage: number;
    };
    process: {
      pid: number;
      uptime: number;
      memoryUsage: {
        rss: number;
        heapUsed: number;
        heapTotal: number;
        external: number;
      };
    };
  };
  database: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    responseTime: number;
    activeConnections: number;
  };
  api: {
    requestCount: number;
    errorRate: number;
    averageResponseTime: number;
  };
}

interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  responseTime?: number;
  timestamp: number;
}

interface UiErrorReport {
  name?: string;
  message: string;
  stack?: string;
  componentStack?: string;
  section?: string;
  severity?: 'low' | 'medium' | 'high';
  metadata?: Record<string, unknown>;
  timestamp: string;
}

// TR015-4: Service-specific monitoring interfaces
interface ServiceStatus {
  name: string;
  port: number;
  status: 'healthy' | 'degraded' | 'down';
  responseTime: number;
  lastCheck: Date;
  url: string;
  slaTarget: number;
  uptime?: number;
  error?: string;
}

interface AlertRule {
  id: string;
  service: string;
  metric: string;
  threshold: number;
  operator: 'gt' | 'lt' | 'eq';
  severity: 'critical' | 'warning' | 'info';
  enabled: boolean;
  cooldown: number;
  lastTriggered?: Date;
}

interface MonitoringStats {
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  averageResponseTime: number;
  slaCompliance: number;
  lastUpdate: Date;
}

class MonitoringService {
  private healthChecks: Map<string, HealthCheck> = new Map();
  private requestCount = 0;
  private errorCount = 0;
  private responseTimes: number[] = [];
  private readonly maxHistorySize = 100;
  private uiErrors: UiErrorReport[] = [];

  // TR015-4: Service-specific monitoring
  private services: Map<string, ServiceStatus> = new Map();
  private alertRules: Map<string, AlertRule> = new Map();
  private alertHistory: Array<{ rule: AlertRule; timestamp: Date; value: number }> = [];
  private monitoringInterval: NodeJS.Timeout | null = null;
  private isServiceMonitoringActive = false;

  constructor() {
    this.initializeServices();
    this.initializeAlertRules();
    // Auto-start service monitoring on boot
    this.startServiceMonitoring();
  }

  // TR015-4: Service initialization based on TR014-4 boundaries
  private initializeServices() {
    const coreServices = [
      {
        name: 'Frontend Dev Server',
        port: 3000,
        url: 'http://localhost:3000',
        slaTarget: 100 // 100ms per TR014-4
      },
      {
        name: 'Command Backend API',
        port: 5000,
        url: 'http://localhost:5000/api/health',
        slaTarget: 200 // 200ms per TR014-4
      },
      {
        name: 'AIDIS MCP Server',
        port: 8080,
        url: 'http://localhost:8080/health',
        slaTarget: 500 // 500ms per TR014-4
      }
    ];

    coreServices.forEach(service => {
      this.services.set(service.name, {
        name: service.name,
        port: service.port,
        status: 'down',
        responseTime: 0,
        lastCheck: new Date(),
        url: service.url,
        slaTarget: service.slaTarget
      });
    });
  }

  private initializeAlertRules() {
    const rules: AlertRule[] = [
      // Critical alerts per TR014-4 SLA definitions
      {
        id: 'frontend-down',
        service: 'Frontend Dev Server',
        metric: 'availability',
        threshold: 0,
        operator: 'eq',
        severity: 'critical',
        enabled: true,
        cooldown: 60000 // 1 minute
      },
      {
        id: 'backend-down',
        service: 'Command Backend API',
        metric: 'availability',
        threshold: 0,
        operator: 'eq',
        severity: 'critical',
        enabled: true,
        cooldown: 60000
      },
      {
        id: 'mcp-down',
        service: 'AIDIS MCP Server',
        metric: 'availability',
        threshold: 0,
        operator: 'eq',
        severity: 'critical',
        enabled: true,
        cooldown: 60000
      },
      // Performance alerts based on SLA thresholds
      {
        id: 'frontend-slow',
        service: 'Frontend Dev Server',
        metric: 'responseTime',
        threshold: 100,
        operator: 'gt',
        severity: 'warning',
        enabled: true,
        cooldown: 300000 // 5 minutes
      },
      {
        id: 'backend-slow',
        service: 'Command Backend API',
        metric: 'responseTime',
        threshold: 200,
        operator: 'gt',
        severity: 'warning',
        enabled: true,
        cooldown: 300000
      },
      {
        id: 'mcp-slow',
        service: 'AIDIS MCP Server',
        metric: 'responseTime',
        threshold: 500,
        operator: 'gt',
        severity: 'critical',
        enabled: true,
        cooldown: 300000
      }
    ];

    rules.forEach(rule => {
      this.alertRules.set(rule.id, rule);
    });
  }

  /**
   * Record API request metrics
   */
  recordRequest(responseTime: number, isError: boolean = false) {
    this.requestCount++;
    if (isError) {
      this.errorCount++;
    }
    
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > this.maxHistorySize) {
      this.responseTimes.shift();
    }
  }

  /**
   * Get current system metrics
   */
  async getSystemMetrics(): Promise<SystemMetrics> {
    const memUsage = process.memoryUsage();
    const now = Date.now();
    
    // Database health check
    const dbHealth = await this.checkDatabaseHealth();
    
    // Calculate API metrics
    const errorRate = this.requestCount > 0 ? (this.errorCount / this.requestCount) * 100 : 0;
    const avgResponseTime = this.responseTimes.length > 0 
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length 
      : 0;

    // System memory (real system values)
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return {
      timestamp: now,
      system: {
        uptime: process.uptime(),
        memory: {
          used: usedMemory,
          free: freeMemory,
          total: totalMemory,
          percentage: (usedMemory / totalMemory) * 100
        },
        cpu: {
          usage: this.getCpuUsage() // Approximate
        },
        process: {
          pid: process.pid,
          uptime: process.uptime(),
          memoryUsage: {
            rss: memUsage.rss,
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external
          }
        }
      },
      database: dbHealth,
      api: {
        requestCount: this.requestCount,
        errorRate: parseFloat(errorRate.toFixed(2)),
        averageResponseTime: parseFloat(avgResponseTime.toFixed(2))
      }
    };
  }

  /**
   * Get system health summary
   */
  async getHealthSummary() {
    const metrics = await this.getSystemMetrics();
    
    // Overall health determination
    const dbHealthy = metrics.database.status === 'healthy';
    const memoryHealthy = metrics.system.memory.percentage < 80;
    const apiHealthy = metrics.api.errorRate < 5;
    
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    if (!dbHealthy || metrics.system.memory.percentage > 90 || metrics.api.errorRate > 20) {
      overallStatus = 'unhealthy';
    } else if (!memoryHealthy || metrics.api.errorRate > 5) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: Date.now(),
      checks: {
        database: {
          status: metrics.database.status,
          message: `Response time: ${metrics.database.responseTime}ms`,
          responseTime: metrics.database.responseTime
        },
        memory: {
          status: memoryHealthy ? 'healthy' : (metrics.system.memory.percentage > 90 ? 'unhealthy' : 'degraded'),
          message: `Memory usage: ${metrics.system.memory.percentage.toFixed(1)}%`,
          responseTime: 0
        },
        api: {
          status: apiHealthy ? 'healthy' : (metrics.api.errorRate > 20 ? 'unhealthy' : 'degraded'),
          message: `Error rate: ${metrics.api.errorRate}% (${this.requestCount} requests)`,
          responseTime: metrics.api.averageResponseTime
        },
        process: {
          status: 'healthy',
          message: `Uptime: ${Math.round(metrics.system.process.uptime)}s`,
          responseTime: 0
        }
      },
      summary: {
        totalChecks: 4,
        healthyChecks: Object.values({
          database: dbHealthy,
          memory: memoryHealthy,
          api: apiHealthy,
          process: true
        }).filter(Boolean).length
      }
    };
  }

  /**
   * Check database health
   */
  private async checkDatabaseHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    responseTime: number;
    activeConnections: number;
  }> {
    const startTime = Date.now();
    
    try {
      // Simple health check query
      await db.query('SELECT 1');
      const responseTime = Date.now() - startTime;
      
      // Get connection info (approximate)
      const connInfo = db.totalCount || 0;
      
      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (responseTime > 1000) {
        status = 'unhealthy';
      } else if (responseTime > 500) {
        status = 'degraded';
      }
      
      return {
        status,
        responseTime,
        activeConnections: connInfo
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        activeConnections: 0
      };
    }
  }

  /**
   * Get approximate CPU usage
   */
  private getCpuUsage(): number {
    // Simple approximation based on process usage
    // In a real implementation, you'd use more sophisticated CPU monitoring
    const usage = process.cpuUsage();
    const total = usage.user + usage.system;
    
    // Convert to approximate percentage (this is a rough estimate)
    return Math.min(100, (total / 1000000) * 10); // Very rough approximation
  }

  /**
   * Get performance trends (last N data points)
   */
  getPerformanceTrends(minutes: number = 5) {
    const now = Date.now();
    
    return {
      timestamp: now,
      windowMinutes: minutes,
      trends: {
        responseTime: this.responseTimes.slice(-20), // Last 20 requests
        errorRate: this.errorCount > 0 ? (this.errorCount / this.requestCount) * 100 : 0,
        requestVolume: this.requestCount
      }
    };
  }

  /**
   * Reset metrics (for testing or periodic cleanup)
   */
  resetMetrics() {
    this.requestCount = 0;
    this.errorCount = 0;
    this.responseTimes = [];
    this.healthChecks.clear();
  }

  recordUiError(report: Partial<UiErrorReport>) {
    const normalized: UiErrorReport = {
      message: report.message || 'Unknown UI error',
      severity: report.severity || 'medium',
      timestamp: report.timestamp || new Date().toISOString()
    };

    if (report.name !== undefined) {
      normalized.name = report.name;
    }

    if (report.stack !== undefined) {
      normalized.stack = report.stack;
    }

    if (report.componentStack !== undefined) {
      normalized.componentStack = report.componentStack;
    }

    if (report.section !== undefined) {
      normalized.section = report.section;
    }

    if (report.metadata !== undefined) {
      normalized.metadata = report.metadata;
    }

    this.uiErrors.unshift(normalized);
    if (this.uiErrors.length > 50) {
      this.uiErrors.pop();
    }

    logger.error('🔴 UI Error Reported', { normalized });
  }

  // TR015-4: Service-specific health checking
  async checkServiceHealth(serviceName: string): Promise<ServiceStatus> {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service ${serviceName} not found`);
    }

    const startTime = Date.now();
    let status: ServiceStatus['status'] = 'down';
    let error: string | undefined;

    try {
      const response = await axios.get(service.url, {
        timeout: 5000,
        validateStatus: (status) => status < 500
      });

      const responseTime = Date.now() - startTime;

      if (response.status === 200) {
        if (responseTime <= service.slaTarget) {
          status = 'healthy';
        } else {
          status = 'degraded';
        }
      } else {
        status = 'degraded';
        error = `HTTP ${response.status}`;
      }

      const updatedService: ServiceStatus = {
        ...service,
        status,
        responseTime,
        lastCheck: new Date(),
        ...(error && { error })
      };

      this.services.set(serviceName, updatedService);
      return updatedService;

    } catch (err) {
      const responseTime = Date.now() - startTime;
      error = err instanceof Error ? err.message : 'Unknown error';

      const updatedService: ServiceStatus = {
        ...service,
        status: 'down',
        responseTime,
        lastCheck: new Date(),
        error
      };

      this.services.set(serviceName, updatedService);
      return updatedService;
    }
  }

  async checkAllServices(): Promise<ServiceStatus[]> {
    const checks = Array.from(this.services.keys()).map(serviceName =>
      this.checkServiceHealth(serviceName)
    );

    const results = await Promise.allSettled(checks);
    return results
      .filter(result => result.status === 'fulfilled')
      .map(result => (result as PromiseFulfilledResult<ServiceStatus>).value);
  }

  evaluateAlerts(services: ServiceStatus[]) {
    const now = new Date();

    this.alertRules.forEach(rule => {
      if (!rule.enabled) return;

      // Check cooldown
      if (rule.lastTriggered &&
          (now.getTime() - rule.lastTriggered.getTime()) < rule.cooldown) {
        return;
      }

      const service = services.find(s => s.name === rule.service);
      if (!service) return;

      let value: number;
      let shouldAlert = false;

      switch (rule.metric) {
        case 'availability':
          value = service.status === 'healthy' ? 1 : 0;
          break;
        case 'responseTime':
          value = service.responseTime;
          break;
        default:
          return;
      }

      switch (rule.operator) {
        case 'gt':
          shouldAlert = value > rule.threshold;
          break;
        case 'lt':
          shouldAlert = value < rule.threshold;
          break;
        case 'eq':
          shouldAlert = value === rule.threshold;
          break;
      }

      if (shouldAlert) {
        this.triggerAlert(rule, value);
        rule.lastTriggered = now;
      }
    });
  }

  private triggerAlert(rule: AlertRule, value: number) {
    const alert = {
      id: `${rule.id}-${Date.now()}`,
      rule: rule.id,
      service: rule.service,
      metric: rule.metric,
      severity: rule.severity,
      value,
      threshold: rule.threshold,
      timestamp: new Date(),
      message: this.generateAlertMessage(rule, value)
    };

    // Log alert
    logger.info(`🚨 ALERT [${rule.severity.toUpperCase()}]: ${alert.message}`);

    // Store in history
    this.alertHistory.push({ rule, timestamp: new Date(), value });

    // Keep alert history manageable
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-500);
    }
  }

  private generateAlertMessage(rule: AlertRule, value: number): string {
    switch (rule.metric) {
      case 'availability':
        return `${rule.service} is ${value === 0 ? 'DOWN' : 'UP'}`;
      case 'responseTime':
        return `${rule.service} response time ${value}ms exceeds SLA threshold ${rule.threshold}ms`;
      default:
        return `${rule.service} ${rule.metric} ${rule.operator} ${rule.threshold} (current: ${value})`;
    }
  }

  getServiceMonitoringStats(): MonitoringStats {
    const services = Array.from(this.services.values());
    const totalServices = services.length;
    const healthyServices = services.filter(s => s.status === 'healthy').length;
    const degradedServices = services.filter(s => s.status === 'degraded').length;
    const downServices = services.filter(s => s.status === 'down').length;

    const avgResponseTime = services.length > 0
      ? services.reduce((sum, s) => sum + s.responseTime, 0) / services.length
      : 0;

    const slaCompliance = totalServices > 0
      ? (healthyServices / totalServices) * 100
      : 0;

    return {
      totalServices,
      healthyServices,
      degradedServices,
      downServices,
      averageResponseTime: Math.round(avgResponseTime),
      slaCompliance: Math.round(slaCompliance * 100) / 100,
      lastUpdate: new Date()
    };
  }

  getAllMonitoredServices(): ServiceStatus[] {
    return Array.from(this.services.values());
  }

  getAlertRules(): AlertRule[] {
    return Array.from(this.alertRules.values());
  }

  getRecentAlerts(limit = 50): Array<{ rule: AlertRule; timestamp: Date; value: number }> {
    return this.alertHistory
      .slice(-limit)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  updateAlertRule(ruleId: string, updates: Partial<AlertRule>) {
    const rule = this.alertRules.get(ruleId);
    if (rule) {
      this.alertRules.set(ruleId, { ...rule, ...updates });
    }
  }

  startServiceMonitoring(intervalMs = 30000) {
    if (this.isServiceMonitoringActive) {
      logger.info('Service monitoring already running');
      return;
    }

    logger.info('🔍 Starting service monitoring...');
    this.isServiceMonitoringActive = true;

    // Initial check
    this.runServiceMonitoringCycle();

    // Schedule regular checks
    this.monitoringInterval = setInterval(() => {
      this.runServiceMonitoringCycle();
    }, intervalMs);

    // unref: this timer must never be the reason a process stays alive.
    //
    // The singleton below is constructed at MODULE LOAD, and the constructor calls this
    // method — so merely `import`ing controllers/monitoring.ts (which routes/monitoring.ts
    // does, which the /api aggregator does) armed a 30s timer that held the event loop
    // open forever. `npm test` hid it behind --forceExit; the CI gate STAGE 4 runs jest
    // WITHOUT --forceExit, so a suite that imported the real router did not fail the
    // authoritative gate — it HUNG it, producing no verdict at all for 20+ minutes.
    //
    // unref is the fix rather than a per-suite teardown convention because it makes the
    // bad state unreachable: no test, script, migration or tool can be wedged by this
    // timer, and nobody has to remember anything. In the real server the process is held
    // open by app.listen, so monitoring still runs exactly as before — unref only means
    // "do not keep the process alive ON MY ACCOUNT", never "do not fire".
    this.monitoringInterval.unref?.();
  }

  stopServiceMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isServiceMonitoringActive = false;
    logger.info('Service monitoring stopped');
  }

  private async runServiceMonitoringCycle() {
    try {
      const services = await this.checkAllServices();
      this.evaluateAlerts(services);

    } catch (error) {
      logger.error('Service monitoring cycle error', { error });
    }
  }

  isServiceMonitoringRunning(): boolean {
    return this.isServiceMonitoringActive;
  }
}

// Singleton instance
export const monitoringService = new MonitoringService();

// Export class for testing
export { MonitoringService };