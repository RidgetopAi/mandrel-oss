import { Request, Response, NextFunction } from 'express';
import { logger, securityLogger } from '../config/logger';
import { getCorrelationId } from './correlationId';

export interface AppError extends Error {
  statusCode: number;
  isOperational: boolean;
}

/**
 * Global error handler middleware
 */
export const errorHandler = (
  error: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const { statusCode = 500, message, stack } = error;
  const isDevelopment = process.env.NODE_ENV === 'development';
  const correlationId = getCorrelationId(req);

  // Structured error logging with context
  const errorContext = {
    correlationId,
    method: req.method,
    path: req.path,
    url: req.originalUrl,
    statusCode,
    message,
    stack,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress,
    userId: (req as any).user?.id || 'anonymous',
    timestamp: new Date().toISOString(),
    query: req.query,
    body: sanitizeErrorBody(req.body),
    isOperational: error.isOperational || false
  };

  // Log to appropriate logger based on severity
  if (statusCode >= 500) {
    logger.error('Server error occurred', errorContext);
  } else if (statusCode >= 400) {
    logger.warn('Client error occurred', errorContext);
  } else {
    logger.info('Error handled', errorContext);
  }

  // Log security-relevant errors
  if (statusCode === 401 || statusCode === 403) {
    securityLogger.warn('Security-related error', {
      ...errorContext,
      event: statusCode === 401 ? 'authentication_error' : 'authorization_error',
      severity: 'medium'
    });
  }

  // Create safe error response (hide sensitive information in production)
  const errorResponse: any = {
    success: false,
    error: {
      message: isDevelopment ? message : getGenericErrorMessage(statusCode),
      statusCode,
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method,
      correlationId
    }
  };

  // Only include stack trace in development
  if (isDevelopment) {
    errorResponse.error.stack = stack;
    errorResponse.error.originalMessage = message; // Keep original for dev
  }

  res.status(statusCode).json(errorResponse);
};

/**
 * Get generic error message for production to avoid information disclosure
 */
const getGenericErrorMessage = (statusCode: number): string => {
  switch (statusCode) {
    case 400:
      return 'Bad request';
    case 401:
      return 'Authentication required';
    case 403:
      return 'Access forbidden';
    case 404:
      return 'Resource not found';
    case 429:
      return 'Too many requests';
    case 500:
    default:
      return 'Internal server error';
  }
};

/**
 * Create operational error
 */
export const createError = (message: string, statusCode: number = 500): AppError => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
};

/**
 * Async error wrapper for route handlers
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Sanitize request body for error logging
 */
const sanitizeErrorBody = (body: any): any => {
  if (!body || typeof body !== 'object') return body;

  const sanitized = { ...body };
  const sensitiveFields = [
    'password', 'token', 'secret', 'key', 'auth', 'authorization',
    'cookie', 'session', 'csrf', 'api_key', 'apikey'
  ];

  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  }

  return sanitized;
};

/**
 * 404 handler - should be last middleware before error handler
 */
export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  const correlationId = getCorrelationId(req);
  logger.warn('Route not found', {
    correlationId,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString(),
    event: 'route_not_found'
  });

  const error = createError(`Route ${req.originalUrl} not found`, 404);
  next(error);
};
