/**
 * AIDIS Enhanced Error Handling and Logging
 * 
 * Comprehensive error handling with:
 * - Structured error logging with full context
 * - Stack trace capture and analysis
 * - Error classification and severity assessment
 * - Automatic error recovery suggestions
 * - Integration with correlation ID tracking
 * - Performance impact monitoring
 * 
 * Features:
 * - Captures full error context including request state
 * - Provides error fingerprinting for tracking recurring issues
 * - Automatic error severity classification
 * - Integration with monitoring and alerting systems
 * - Preserves original error types and messages
 */

import { logger, CorrelationIdManager } from './logger.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ErrorContext {
  correlationId?: string;
  sessionId?: string;
  projectId?: string;
  operation?: string;
  component?: string;
  userId?: string;
  requestArgs?: any;
  systemState?: {
    memoryUsage?: NodeJS.MemoryUsage;
    cpuUsage?: NodeJS.CpuUsage;
    uptime?: number;
  };
  additionalContext?: Record<string, any>;
}

export interface ErrorDetails {
  fingerprint: string;
  severity: ErrorSeverity;
  category: string;
  isRetryable: boolean;
  suggestedAction?: string;
  relatedErrors?: string[];
  impactArea: string[];
}

/**
 * Enhanced error handler with comprehensive logging and analysis
 */
export class ErrorHandler {
  private static errorCounts = new Map<string, number>();
  private static lastErrorTimes = new Map<string, number>();

  /**
   * Handle and log errors with full context
   */
  static handleError(
    error: Error,
    context: ErrorContext = {},
    operation?: string
  ): never {
    const enhancedContext = {
      ...context,
      correlationId: context.correlationId || CorrelationIdManager.get(),
      operation: operation || context.operation || 'unknown',
      systemState: this.captureSystemState()
    };

    const errorDetails = this.analyzeError(error, enhancedContext);
    
    // Log the error with full context
    this.logError(error, enhancedContext, errorDetails);
    
    // Track error patterns
    this.trackErrorPattern(errorDetails.fingerprint);
    
    // Check for error storms or frequent errors
    this.checkErrorFrequency(errorDetails.fingerprint, errorDetails.severity);
    
    // Rethrow the original error to preserve behavior
    throw error;
  }

  /**
   * Wrap operations with automatic error handling
   */
  static async wrapOperation<T>(
    operation: () => Promise<T>,
    context: ErrorContext,
    operationName?: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.handleError(error as Error, context, operationName);
    }
  }

  /**
   * Handle MCP-specific errors
   */
  static handleMcpError(
    error: Error,
    tool: string,
    args: any,
    context: ErrorContext = {}
  ): never {
    const mcpContext = {
      ...context,
      operation: `mcp_${tool}`,
      component: 'MCP',
      requestArgs: this.sanitizeArgs(args),
      additionalContext: {
        tool,
        isMcpError: error instanceof McpError,
        mcpErrorCode: error instanceof McpError ? error.code : null
      }
    };

    this.handleError(error, mcpContext);
  }

  /**
   * Handle database operation errors
   */
  static handleDatabaseError(
    error: Error,
    query: string,
    params?: any[],
    context: ErrorContext = {}
  ): never {
    const dbContext = {
      ...context,
      component: 'DATABASE',
      additionalContext: {
        query: query.length > 500 ? query.substring(0, 500) + '...' : query,
        hasParams: !!params && params.length > 0,
        paramCount: params?.length || 0,
        isDatabaseError: true
      }
    };

    this.handleError(error, dbContext);
  }

  /**
   * Analyze error to determine severity, category, and impact
   */
  private static analyzeError(error: Error, context: ErrorContext): ErrorDetails {
    const fingerprint = this.generateErrorFingerprint(error, context);
    const category = this.categorizeError(error);
    const severity = this.assessSeverity(error, context);
    const isRetryable = this.isRetryableError(error);
    const impactArea = this.assessImpactArea(error, context);
    const suggestedAction = this.generateSuggestedAction(error, category, isRetryable);

    return {
      fingerprint,
      severity,
      category,
      isRetryable,
      suggestedAction,
      impactArea
    };
  }

  /**
   * Generate unique fingerprint for error tracking
   */
  private static generateErrorFingerprint(error: Error, context: ErrorContext): string {
    const components = [
      error.constructor.name,
      error.message.substring(0, 100),
      context.operation || 'unknown',
      context.component || 'unknown'
    ];

    // Create a simple hash
    const fingerprint = components.join('|');
    return Buffer.from(fingerprint).toString('base64').substring(0, 16);
  }

  /**
   * Categorize error by type and context
   */
  private static categorizeError(error: Error): string {
    if (error instanceof McpError) return 'mcp_protocol';
    if (error.name.includes('Database') || error.message.includes('database')) return 'database';
    if (error.name.includes('Network') || error.message.includes('ECONNREFUSED')) return 'network';
    if (error.name.includes('Validation') || error.message.includes('validation')) return 'validation';
    if (error.name.includes('Permission') || error.name.includes('Auth')) return 'authorization';
    if (error.message.includes('timeout')) return 'timeout';
    if (error.message.includes('memory') || error.message.includes('heap')) return 'memory';
    if (error.name === 'SyntaxError') return 'parsing';
    return 'application';
  }

  /**
   * Assess error severity based on type and context
   */
  private static assessSeverity(error: Error, context: ErrorContext): ErrorSeverity {
    // Critical severity
    if (error.message.includes('FATAL') || 
        error.message.includes('out of memory') ||
        error.name === 'DatabaseConnectionError') {
      return 'critical';
    }

    // High severity
    if (error.message.includes('database') ||
        error.message.includes('connection refused') ||
        context.component === 'DATABASE') {
      return 'high';
    }

    // Medium severity
    if (error instanceof McpError ||
        error.message.includes('timeout') ||
        error.message.includes('validation')) {
      return 'medium';
    }

    // Low severity (default)
    return 'low';
  }

  /**
   * Determine if error is retryable
   */
  private static isRetryableError(error: Error): boolean {
    const retryablePatterns = [
      'timeout',
      'connection refused',
      'network error',
      'temporary failure',
      'rate limit',
      'service unavailable'
    ];

    const message = error.message.toLowerCase();
    return retryablePatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Assess impact areas affected by this error
   */
  private static assessImpactArea(error: Error, context: ErrorContext): string[] {
    const areas: string[] = [];

    if (context.component === 'DATABASE' || error.message.includes('database')) {
      areas.push('data_persistence');
    }
    
    if (context.component === 'MCP' || error instanceof McpError) {
      areas.push('client_communication');
    }
    
    if (error.message.includes('memory') || error.message.includes('heap')) {
      areas.push('system_resources');
    }
    
    if (context.sessionId) {
      areas.push('user_session');
    }
    
    if (context.projectId) {
      areas.push('project_data');
    }

    return areas.length > 0 ? areas : ['application'];
  }

  /**
   * Generate suggested action for error resolution
   */
  private static generateSuggestedAction(
    _error: Error,
    category: string,
    isRetryable: boolean
  ): string {
    if (isRetryable) {
      return 'Retry operation with exponential backoff';
    }

    switch (category) {
      case 'database':
        return 'Check database connection and schema integrity';
      case 'network':
        return 'Verify network connectivity and service availability';
      case 'validation':
        return 'Validate input parameters and data format';
      case 'authorization':
        return 'Check permissions and authentication state';
      case 'memory':
        return 'Monitor memory usage and consider optimization';
      case 'mcp_protocol':
        return 'Verify MCP client compatibility and protocol version';
      default:
        return 'Review error context and application state';
    }
  }

  /**
   * Log error with comprehensive details
   */
  private static logError(
    error: Error,
    context: ErrorContext,
    details: ErrorDetails
  ): void {
    const metadata = {
      correlationId: context.correlationId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      component: context.component || 'APPLICATION',
      operation: context.operation || 'unknown',
      metadata: {
        ...details,
        errorName: error.name,
        errorMessage: error.message,
        hasStack: !!error.stack,
        systemState: context.systemState,
        requestArgs: context.requestArgs,
        additionalContext: context.additionalContext,
        timestamp: new Date().toISOString(),
        errorCount: this.errorCounts.get(details.fingerprint) || 1
      }
    };

    // Log at appropriate level based on severity
    const level = details.severity === 'critical' ? 'error' :
                  details.severity === 'high' ? 'error' :
                  details.severity === 'medium' ? 'warn' : 'warn';

    logger[level](`${details.category.toUpperCase()} ERROR: ${error.message}`, error, metadata);

    // Log suggested action separately for visibility
    if (details.suggestedAction) {
      logger.info(`Error Resolution Suggestion: ${details.suggestedAction}`, {
        correlationId: context.correlationId,
        component: 'ERROR_HANDLER',
        operation: 'suggestion',
        metadata: {
          fingerprint: details.fingerprint,
          category: details.category,
          isRetryable: details.isRetryable
        }
      });
    }
  }

  /**
   * Track error patterns for analysis
   */
  private static trackErrorPattern(fingerprint: string): void {
    const currentCount = this.errorCounts.get(fingerprint) || 0;
    this.errorCounts.set(fingerprint, currentCount + 1);
    this.lastErrorTimes.set(fingerprint, Date.now());
  }

  /**
   * Check for error frequency patterns that might indicate problems
   */
  private static checkErrorFrequency(fingerprint: string, severity: ErrorSeverity): void {
    const count = this.errorCounts.get(fingerprint) || 0;
    const lastTime = this.lastErrorTimes.get(fingerprint) || 0;
    const timeSinceFirst = Date.now() - lastTime;

    // Alert on error storms (many errors in short time)
    if (count >= 10 && timeSinceFirst < 60000) { // 10 errors in 1 minute
      logger.warn(`Error Storm Detected: ${fingerprint}`, {
        component: 'ERROR_HANDLER',
        operation: 'error_storm_alert',
        metadata: {
          fingerprint,
          errorCount: count,
          timeWindowMs: timeSinceFirst,
          severity,
          suggestion: 'Investigate root cause and implement circuit breaker'
        }
      });
    }

    // Alert on frequent critical errors
    if (severity === 'critical' && count >= 3) {
      logger.error(`Frequent Critical Error: ${fingerprint}`, undefined, {
        component: 'ERROR_HANDLER',
        operation: 'critical_error_alert',
        metadata: {
          fingerprint,
          errorCount: count,
          severity,
          suggestion: 'Immediate investigation required'
        }
      });
    }
  }

  /**
   * Capture current system state for error context
   */
  private static captureSystemState(): ErrorContext['systemState'] {
    try {
      return {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime()
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Sanitize arguments for logging
   */
  private static sanitizeArgs(args: any): any {
    if (!args || typeof args !== 'object') return args;

    const sensitiveKeys = [
      'password', 'token', 'secret', 'key', 'auth', 'credential'
    ];
    
    const sanitized = { ...args };
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  /**
   * Get error statistics for monitoring
   */
  static getErrorStats(): {
    totalErrors: number;
    uniqueErrors: number;
    topErrors: Array<{ fingerprint: string; count: number }>;
  } {
    const totalErrors = Array.from(this.errorCounts.values()).reduce((sum, count) => sum + count, 0);
    const uniqueErrors = this.errorCounts.size;
    
    const topErrors = Array.from(this.errorCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([fingerprint, count]) => ({ fingerprint, count }));

    return {
      totalErrors,
      uniqueErrors,
      topErrors
    };
  }

  /**
   * Clear error tracking data (useful for testing or periodic cleanup)
   */
  static clearErrorTracking(): void {
    this.errorCounts.clear();
    this.lastErrorTimes.clear();
  }
}

// ErrorHandler class is already exported above
