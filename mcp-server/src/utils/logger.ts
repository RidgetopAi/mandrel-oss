/**
 * AIDIS Comprehensive Logging System
 * 
 * Provides structured JSON logging with:
 * - Request/response correlation tracking with unique IDs
 * - Performance monitoring with timing and metrics
 * - Error handling with stack traces and context
 * - Log rotation with size and age limits
 * - Environment-based log level configuration
 * - MCP-specific logging optimizations
 * 
 * Architecture:
 * - Uses correlation IDs to trace requests across services
 * - Supports multiple log levels (error, warn, info, debug, trace)
 * - JSON structured format for easy parsing and analysis
 * - Automatic log rotation to prevent disk space issues
 * - Performance monitoring for slow operations and bottlenecks
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  sessionId?: string;
  projectId?: string;
  component?: string;
  operation?: string;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string | number;
  };
  request?: {
    method: string;
    tool: string;
    args?: any;
    userId?: string;
  };
  response?: {
    success: boolean;
    responseTime: number;
    size?: number;
  };
  performance?: {
    cpuUsage?: NodeJS.CpuUsage;
    memoryUsage?: NodeJS.MemoryUsage;
    startTime?: number;
    endTime?: number;
  };
  metadata?: Record<string, any>;
}

export interface LoggerConfig {
  level: LogLevel;
  logDir: string;
  maxFileSize: number; // in bytes
  maxFiles: number;
  enableConsole: boolean;
  enableFile: boolean;
  enablePerformanceLogging: boolean;
  enableRequestLogging: boolean;
  correlationIdHeader?: string;
}

/**
 * Correlation ID management for request tracing
 */
export class CorrelationIdManager {
  private static currentCorrelationId: string | null = null;

  static generate(): string {
    const id = randomUUID();
    this.currentCorrelationId = id;
    return id;
  }

  static get(): string {
    return this.currentCorrelationId || this.generate();
  }

  static set(id: string): void {
    this.currentCorrelationId = id;
  }

  static clear(): void {
    this.currentCorrelationId = null;
  }
}

/**
 * Performance monitoring utilities
 */
export class PerformanceMonitor {
  private static operations = new Map<string, {
    startTime: number;
    cpuStart: NodeJS.CpuUsage;
  }>();

  static start(operationId: string): void {
    this.operations.set(operationId, {
      startTime: Number(process.hrtime.bigint()),
      cpuStart: process.cpuUsage()
    });
  }

  static end(operationId: string): {
    duration: number;
    cpuUsage: NodeJS.CpuUsage;
    memoryUsage: NodeJS.MemoryUsage;
  } | null {
    const start = this.operations.get(operationId);
    if (!start) return null;

    const endTime = Number(process.hrtime.bigint());
    const duration = (endTime - start.startTime) / 1000000; // Convert to milliseconds
    const cpuUsage = process.cpuUsage(start.cpuStart);
    const memoryUsage = process.memoryUsage();

    this.operations.delete(operationId);

    return {
      duration,
      cpuUsage,
      memoryUsage
    };
  }
}

/**
 * Log rotation utilities
 */
class LogRotator {
  private static shouldRotate(filePath: string, maxSize: number): boolean {
    try {
      const stats = fs.statSync(filePath);
      return stats.size >= maxSize;
    } catch {
      return false;
    }
  }

  static rotateFile(filePath: string, maxFiles: number): void {
    if (!fs.existsSync(filePath)) return;

    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    // Rotate existing files
    for (let i = maxFiles - 1; i > 0; i--) {
      const oldFile = path.join(dir, `${baseName}.${i}${ext}`);
      const newFile = path.join(dir, `${baseName}.${i + 1}${ext}`);
      
      if (fs.existsSync(oldFile)) {
        if (i === maxFiles - 1) {
          fs.unlinkSync(oldFile); // Delete the oldest
        } else {
          fs.renameSync(oldFile, newFile);
        }
      }
    }

    // Rotate the current file
    const rotatedFile = path.join(dir, `${baseName}.1${ext}`);
    fs.renameSync(filePath, rotatedFile);
  }

  static checkAndRotate(filePath: string, maxSize: number, maxFiles: number): void {
    if (this.shouldRotate(filePath, maxSize)) {
      this.rotateFile(filePath, maxFiles);
    }
  }
}

/**
 * Main Logger class
 */
export class Logger {
  private config: LoggerConfig;
  private logFilePath: string;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: (process.env.AIDIS_LOG_LEVEL || process.env.LOG_LEVEL || 'info') as LogLevel,
      logDir: process.env.AIDIS_LOG_DIR || process.env.LOG_DIR || path.resolve(process.cwd(), 'logs'),
      maxFileSize: parseInt(process.env.AIDIS_LOG_MAX_SIZE || process.env.LOG_MAX_SIZE || '10485760'), // 10MB
      maxFiles: parseInt(process.env.AIDIS_LOG_MAX_FILES || process.env.LOG_MAX_FILES || '10'),
      enableConsole: (process.env.AIDIS_LOG_CONSOLE || process.env.LOG_CONSOLE || 'true') !== 'false',
      enableFile: (process.env.AIDIS_LOG_FILE || process.env.LOG_FILE || 'true') !== 'false',
      enablePerformanceLogging: (process.env.AIDIS_PERFORMANCE_LOGGING || process.env.PERFORMANCE_LOGGING || 'false') === 'true',
      enableRequestLogging: (process.env.AIDIS_REQUEST_LOGGING || process.env.REQUEST_LOGGING || 'true') !== 'false',
      correlationIdHeader: process.env.AIDIS_CORRELATION_ID_HEADER || process.env.CORRELATION_ID_HEADER || 'x-correlation-id',
      ...config
    };

    this.logFilePath = path.join(this.config.logDir, 'aidis-mcp.log');
    this.ensureLogDirectory();
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];
    const currentLevelIndex = levels.indexOf(this.config.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex <= currentLevelIndex;
  }

  private formatLogEntry(entry: LogEntry): string {
    return JSON.stringify(entry) + '\n';
  }

  private writeToFile(entry: LogEntry): void {
    if (!this.config.enableFile) return;

    try {
      // Check and rotate if needed
      LogRotator.checkAndRotate(this.logFilePath, this.config.maxFileSize, this.config.maxFiles);

      const formatted = this.formatLogEntry(entry);
      fs.appendFileSync(this.logFilePath, formatted);
    } catch (error) {
      console.error('Logger: Failed to write to log file:', error);
    }
  }

  private writeToConsole(entry: LogEntry): void {
    if (!this.config.enableConsole) return;

    const timestamp = entry.timestamp;
    const level = entry.level.toUpperCase().padEnd(5);
    const correlationId = entry.correlationId ? ` [${entry.correlationId.substring(0, 8)}]` : '';
    const component = entry.component ? ` ${entry.component}` : '';
    const operation = entry.operation ? `::${entry.operation}` : '';
    
    let message = `${timestamp} ${level}${correlationId}${component}${operation} - ${entry.message}`;
    
    if (entry.duration) {
      message += ` (${entry.duration.toFixed(2)}ms)`;
    }

    // Add performance info for debug level
    if (entry.level === 'debug' && entry.performance) {
      const mem = entry.performance.memoryUsage;
      if (mem) {
        message += ` [mem: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB]`;
      }
    }

    const output = entry.level === 'error' ? console.error : 
                   entry.level === 'warn' ? console.warn : 
                   console.log;

    output(message);

    // Show error details
    if (entry.error && this.config.level === 'debug') {
      console.error('Error details:', {
        name: entry.error.name,
        message: entry.error.message,
        stack: entry.error.stack
      });
    }
  }

  private log(level: LogLevel, message: string, metadata: Partial<LogEntry> = {}): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      correlationId: CorrelationIdManager.get(),
      ...metadata
    };

    this.writeToFile(entry);
    this.writeToConsole(entry);
  }

  error(message: string, error?: Error, metadata: Partial<LogEntry> = {}): void {
    const errorData = error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: (error as any).code
    } : undefined;

    this.log('error', message, {
      ...metadata,
      error: errorData
    });
  }

  warn(message: string, metadata: Partial<LogEntry> = {}): void {
    this.log('warn', message, metadata);
  }

  info(message: string, metadata: Partial<LogEntry> = {}): void {
    this.log('info', message, metadata);
  }

  debug(message: string, metadata: Partial<LogEntry> = {}): void {
    this.log('debug', message, metadata);
  }

  trace(message: string, metadata: Partial<LogEntry> = {}): void {
    this.log('trace', message, metadata);
  }

  // Specialized logging methods for common use cases

  logRequest(tool: string, args: any, metadata: Partial<LogEntry> = {}): void {
    if (!this.config.enableRequestLogging) return;

    this.info(`MCP Request: ${tool}`, {
      ...metadata,
      component: 'MCP',
      operation: 'request',
      request: {
        method: 'call_tool',
        tool,
        args: this.sanitizeArgs(args)
      }
    });
  }

  logResponse(tool: string, success: boolean, responseTime: number, size?: number, metadata: Partial<LogEntry> = {}): void {
    if (!this.config.enableRequestLogging) return;

    this.info(`MCP Response: ${tool} ${success ? 'SUCCESS' : 'FAILED'}`, {
      ...metadata,
      component: 'MCP',
      operation: 'response',
      duration: responseTime,
      response: {
        success,
        responseTime,
        size
      }
    });
  }

  logPerformance(operation: string, duration: number, perfData?: any, metadata: Partial<LogEntry> = {}): void {
    if (!this.config.enablePerformanceLogging) return;

    const level: LogLevel = duration > 1000 ? 'warn' : duration > 500 ? 'info' : 'debug';
    
    this.log(level, `Performance: ${operation}`, {
      ...metadata,
      component: 'PERF',
      operation,
      duration,
      performance: perfData
    });
  }

  // Utility method to sanitize sensitive data from args
  private sanitizeArgs(args: any): any {
    if (!args || typeof args !== 'object') return args;

    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth'];
    const sanitized = { ...args };

    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  // Context methods
  setCorrelationId(id: string): void {
    CorrelationIdManager.set(id);
  }

  getCorrelationId(): string {
    return CorrelationIdManager.get();
  }

  // Performance monitoring
  startOperation(operationId: string): void {
    if (this.config.enablePerformanceLogging) {
      PerformanceMonitor.start(operationId);
    }
  }

  endOperation(operationId: string): void {
    if (this.config.enablePerformanceLogging) {
      const perfData = PerformanceMonitor.end(operationId);
      if (perfData) {
        this.logPerformance(operationId, perfData.duration, {
          cpuUsage: perfData.cpuUsage,
          memoryUsage: perfData.memoryUsage
        });
      }
    }
  }
}

// Create and export default logger instance
export const logger = new Logger();

// Note: CorrelationIdManager and PerformanceMonitor are already exported above
