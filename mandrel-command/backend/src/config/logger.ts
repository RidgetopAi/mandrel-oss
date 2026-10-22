import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

// Log directory is env-overridable (LOG_DIR). Default keeps prior behavior for
// local/dev; the container sets LOG_DIR=/app/logs (a writable, mounted volume)
// to avoid resolving to '/logs' which the non-root container user can't create.
const logsDir = process.env.LOG_DIR || path.join(__dirname, '../../../logs');

/**
 * Log levels configuration
 */
export const LOG_LEVELS = {
  DEBUG: 'debug',
  INFO: 'info', 
  WARN: 'warn',
  ERROR: 'error'
} as const;

/**
 * Custom log format for structured JSON logging
 */
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf((info) => {
    // Ensure consistent structure
    const logEntry: any = {
    timestamp: info.timestamp,
    level: info.level.toUpperCase(),
    message: info.message,
    ...(info as any).metadata,
    ...((info as any).error && { error: (info as any).error }),
    ...((info as any).stack && { stack: (info as any).stack })
    };
    return JSON.stringify(logEntry);
  })
);

/**
 * Console format for development
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf((info) => {
    const { timestamp, level, message, correlationId, method, path: reqPath } = info;
    let output = `${timestamp} [${level}] ${message}`;
    
    if (correlationId) {
      output += ` [${correlationId}]`;
    }
    
    if (method && reqPath) {
      output += ` ${method} ${reqPath}`;
    }
    
    return output;
  })
);

/**
 * Create daily rotate file transport
 */
const createRotateFileTransport = (filename: string, level: string) => {
  return new DailyRotateFile({
    filename: path.join(logsDir, `${filename}-%DATE%.log`),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    level,
    format: jsonFormat
  });
};

/**
 * Main application logger
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels: winston.config.npm.levels,
  defaultMeta: {
    service: 'aidis-command-backend'
  },
  transports: [
    // Console transport (development)
    ...(process.env.NODE_ENV === 'development' ? [
      new winston.transports.Console({
        format: consoleFormat
      })
    ] : []),
    
    // File transports with rotation
    createRotateFileTransport('error', 'error'),
    createRotateFileTransport('combined', 'info'),
    createRotateFileTransport('debug', 'debug')
  ]
});

/**
 * Security logger for authentication and authorization events
 */
export const securityLogger = winston.createLogger({
  level: 'info',
  defaultMeta: {
    service: 'aidis-security',
    category: 'security'
  },
  transports: [
    createRotateFileTransport('security', 'info'),
    ...(process.env.NODE_ENV === 'development' ? [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.colorize(),
          winston.format.printf((info) => 
            `🔒 ${info.timestamp} [SECURITY] ${info.message}`
          )
        )
      })
    ] : [])
  ]
});

/**
 * Database logger for query performance and connection issues
 */
export const dbLogger = winston.createLogger({
  level: process.env.DB_LOG_LEVEL || 'warn',
  defaultMeta: {
    service: 'aidis-database',
    category: 'database'
  },
  transports: [
    createRotateFileTransport('database', 'debug'),
    ...(process.env.NODE_ENV === 'development' ? [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.colorize(),
          winston.format.printf((info) => 
            `🗃️  ${info.timestamp} [DB] ${info.message}`
          )
        )
      })
    ] : [])
  ]
});

/**
 * Request logger for HTTP requests and responses
 */
export const requestLogger = winston.createLogger({
  level: 'info',
  defaultMeta: {
    service: 'aidis-requests',
    category: 'http'
  },
  transports: [
    createRotateFileTransport('requests', 'info'),
    ...(process.env.NODE_ENV === 'development' ? [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.colorize(),
          winston.format.printf((info) => {
            const { method, url, statusCode, responseTime, correlationId } = info;
            return `🌐 ${info.timestamp} [REQ] ${method} ${url} ${statusCode} - ${responseTime}ms [${correlationId}]`;
          })
        )
      })
    ] : [])
  ]
});

/**
 * Utility function to create child logger with metadata
 */
export const createChildLogger = (metadata: Record<string, any>) => {
  return logger.child(metadata);
};

/**
 * Log stream for Morgan middleware
 */
export const morganLogStream = {
  write: (message: string) => {
    // Remove trailing newline from morgan
    logger.info(message.trim(), { category: 'morgan' });
  }
};

export default logger;
