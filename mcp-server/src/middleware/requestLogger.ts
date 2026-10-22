/**
 * AIDIS Request/Response Logging Middleware
 * 
 * Comprehensive MCP request/response logging with:
 * - Correlation ID generation and propagation
 * - Request timing and performance monitoring
 * - Error context capture and stack trace logging
 * - Request/response size tracking
 * - Slow operation detection and alerting
 * - Integration with structured logger
 * 
 * Features:
 * - Wraps all MCP tool calls with logging
 * - Captures full request context including arguments
 * - Tracks response success/failure with timing
 * - Provides performance alerts for slow operations
 * - Preserves existing error handling behavior
 * - Sanitizes sensitive data from logs
 */

import { logger, CorrelationIdManager, PerformanceMonitor } from '../utils/logger.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

export interface RequestContext {
  correlationId: string;
  startTime: number;
  tool: string;
  args: any;
  sessionId?: string;
  projectId?: string;
  userId?: string;
}

/**
 * Request/Response logging middleware for MCP operations
 */
export class RequestLogger {
  private static slowOperationThreshold = (() => {
    const threshold = parseInt(process.env.MANDREL_SLOW_OP_THRESHOLD || process.env.AIDIS_SLOW_OP_THRESHOLD || '1000');
    if (process.env.AIDIS_SLOW_OP_THRESHOLD && !process.env.MANDREL_SLOW_OP_THRESHOLD) {
      logger.warn('⚠️  AIDIS_SLOW_OP_THRESHOLD is deprecated. Use MANDREL_SLOW_OP_THRESHOLD instead.');
    }
    return threshold;
  })();
  
  private static enableDetailedLogging = (() => {
    const enabled = (process.env.MANDREL_DETAILED_LOGGING || process.env.AIDIS_DETAILED_LOGGING || 'false') === 'true';
    if (process.env.AIDIS_DETAILED_LOGGING && !process.env.MANDREL_DETAILED_LOGGING) {
      logger.warn('⚠️  AIDIS_DETAILED_LOGGING is deprecated. Use MANDREL_DETAILED_LOGGING instead.');
    }
    return enabled;
  })();

  /**
   * Wrap an MCP operation with comprehensive logging
   */
  static async wrapOperation<T>(
    tool: string,
    args: any,
    operation: () => Promise<T>,
    context: Partial<RequestContext> = {}
  ): Promise<T> {
    const correlationId = CorrelationIdManager.generate();
    const operationId = `${tool}_${correlationId.substring(0, 8)}`;
    
    const requestContext: RequestContext = {
      correlationId,
      startTime: Date.now(),
      tool,
      args,
      ...context
    };

    // Start performance monitoring
    PerformanceMonitor.start(operationId);
    
    // Log the request
    this.logRequest(requestContext);

    let result: T;
    let error: Error | null = null;
    let success = false;

    try {
      result = await operation();
      success = true;
      
      // Log successful response
      this.logResponse(requestContext, true, result);
      
      return result;
    } catch (err) {
      error = err as Error;
      success = false;
      
      // Log error response
      this.logResponse(requestContext, false, null, err as Error);
      
      throw err; // Re-throw to preserve error handling
    } finally {
      // Always log performance data
      this.logPerformance(operationId, requestContext, success, error);
    }
  }

  /**
   * Log incoming MCP request
   */
  private static logRequest(context: RequestContext): void {
    const metadata = {
      correlationId: context.correlationId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      component: 'MCP',
      operation: context.tool,
      metadata: {
        argsSize: this.calculateSize(context.args),
        hasArgs: Object.keys(context.args || {}).length > 0,
        ...(this.enableDetailedLogging ? { args: this.sanitizeArgs(context.args) } : {})
      }
    };

    logger.logRequest(context.tool, context.args, metadata);
  }

  /**
   * Log MCP response (success or failure)
   */
  private static logResponse(
    context: RequestContext,
    success: boolean,
    result: any,
    error?: Error
  ): void {
    const responseTime = Date.now() - context.startTime;
    const resultSize = success ? this.calculateSize(result) : 0;

    const metadata = {
      correlationId: context.correlationId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      component: 'MCP',
      operation: context.tool,
      metadata: {
        resultSize,
        responseTime
      }
    };

    if (error) {
      logger.error(`MCP Operation Failed: ${context.tool}`, error, {
        ...metadata,
        metadata: {
          ...metadata.metadata,
          errorType: error.constructor.name,
          errorCode: (error as any).code,
          isMcpError: error instanceof McpError
        }
      });
    } else {
      logger.logResponse(context.tool, success, responseTime, resultSize, metadata);
    }
  }

  /**
   * Log performance metrics and detect slow operations
   */
  private static logPerformance(
    operationId: string,
    context: RequestContext,
    success: boolean,
    error: Error | null
  ): void {
    const perfData = PerformanceMonitor.end(operationId);
    if (!perfData) return;

    const metadata = {
      correlationId: context.correlationId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      metadata: {
        success,
        tool: context.tool,
        hasError: !!error,
        errorType: error?.constructor.name
      }
    };

    // Log performance data
    logger.logPerformance(context.tool, perfData.duration, {
      cpuUsage: perfData.cpuUsage,
      memoryUsage: perfData.memoryUsage,
      startTime: context.startTime,
      endTime: context.startTime + perfData.duration
    }, metadata);

    // Alert on slow operations
    if (perfData.duration > this.slowOperationThreshold) {
      logger.warn(`Slow Operation Detected: ${context.tool}`, {
        ...metadata,
        component: 'PERF',
        operation: 'slow_operation_alert',
        duration: perfData.duration,
        metadata: {
          ...metadata.metadata,
          thresholdMs: this.slowOperationThreshold,
          overThresholdBy: perfData.duration - this.slowOperationThreshold,
          cpuUserMs: perfData.cpuUsage.user / 1000,
          cpuSystemMs: perfData.cpuUsage.system / 1000,
          memoryMB: perfData.memoryUsage.heapUsed / 1024 / 1024
        }
      });
    }
  }

  /**
   * Calculate approximate size of an object in bytes
   */
  private static calculateSize(obj: any): number {
    if (!obj) return 0;
    
    try {
      return Buffer.byteLength(JSON.stringify(obj), 'utf8');
    } catch {
      return 0;
    }
  }

  /**
   * Sanitize arguments to remove sensitive data
   */
  private static sanitizeArgs(args: any): any {
    if (!args || typeof args !== 'object') return args;

    const sensitiveKeys = [
      'password', 'token', 'secret', 'key', 'auth', 'credential',
      'apiKey', 'accessToken', 'refreshToken', 'sessionToken'
    ];
    
    const sanitized = JSON.parse(JSON.stringify(args)); // Deep clone

    const sanitizeObject = (obj: any): any => {
      if (!obj || typeof obj !== 'object') return obj;

      for (const key of Object.keys(obj)) {
        const lowerKey = key.toLowerCase();
        
        if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
          obj[key] = sanitizeObject(obj[key]);
        } else if (typeof obj[key] === 'string' && obj[key].length > 500) {
          // Truncate very long strings to prevent log bloat
          obj[key] = obj[key].substring(0, 500) + '... [TRUNCATED]';
        }
      }

      return obj;
    };

    return sanitizeObject(sanitized);
  }

  /**
   * Create a request context for the current operation
   */
  static createContext(tool: string, args: any, additionalContext: Partial<RequestContext> = {}): RequestContext {
    return {
      correlationId: CorrelationIdManager.generate(),
      startTime: Date.now(),
      tool,
      args,
      ...additionalContext
    };
  }

  /**
   * Log a general operation without wrapping
   */
  static logOperation(
    level: 'info' | 'warn' | 'error',
    operation: string,
    message: string,
    metadata?: any
  ): void {
    const logArgs = {
      correlationId: CorrelationIdManager.get(),
      component: 'AIDIS',
      operation,
      metadata
    };

    if (level === 'error') {
      logger.error(message, undefined, logArgs);
    } else if (level === 'warn') {
      logger.warn(message, logArgs);
    } else {
      logger.info(message, logArgs);
    }
  }

  /**
   * Log system events (startup, shutdown, etc.)
   */
  static logSystemEvent(event: string, metadata?: any): void {
    logger.info(`System Event: ${event}`, {
      component: 'SYSTEM',
      operation: event,
      metadata: {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        uptime: process.uptime(),
        ...metadata
      }
    });
  }

  /**
   * Log database operations
   */
  static logDatabaseOperation(
    operation: string,
    query: string,
    duration?: number,
    error?: Error
  ): void {
    const level = error ? 'error' : duration && duration > 100 ? 'warn' : 'debug';
    const message = error ? `Database Error: ${operation}` : `Database: ${operation}`;

    (logger[level] as any)(message, error, {
      component: 'DB',
      operation,
      duration,
      metadata: {
        query: query.length > 200 ? query.substring(0, 200) + '...' : query,
        hasError: !!error
      }
    });
  }

  /**
   * Log health check operations
   */
  static logHealthCheck(endpoint: string, status: 'healthy' | 'unhealthy', responseTime?: number): void {
    const level = status === 'healthy' ? 'debug' : 'warn';
    
    (logger[level] as any)(`Health Check: ${endpoint} - ${status.toUpperCase()}`, {
      component: 'HEALTH',
      operation: 'health_check',
      duration: responseTime,
      metadata: {
        endpoint,
        status,
        timestamp: new Date().toISOString()
      }
    });
  }
}

// RequestLogger class is already exported above
