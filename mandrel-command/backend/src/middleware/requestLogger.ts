import { Request, Response, NextFunction } from 'express';
import { requestLogger, securityLogger } from '../config/logger';
import { getCorrelationId } from './correlationId';

/**
 * Enhanced request logging middleware with timing and security events
 */
export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const startTime = Date.now();
  const correlationId = getCorrelationId(req);

  // Extract request metadata
  const requestMetadata = {
    correlationId,
    method: req.method,
    url: req.originalUrl,
    path: req.path,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress,
    headers: {
      contentType: req.get('Content-Type'),
      contentLength: req.get('Content-Length'),
      authorization: req.get('Authorization') ? '[REDACTED]' : undefined,
      referer: req.get('Referer')
    },
    query: req.query,
    body: sanitizeBody(req.body),
    timestamp: new Date().toISOString()
  };

  // Log incoming request
  requestLogger.info('Incoming request', {
    ...requestMetadata,
    method: requestMetadata.method,
    url: requestMetadata.url
  });

  // Capture response data
  const originalSend = res.send;
  const originalJson = res.json;

  // Override res.send to capture response
  res.send = function(body: any) {
    logResponse(res, body, startTime, correlationId);
    return originalSend.call(this, body);
  };

  // Override res.json to capture JSON responses
  res.json = function(body: any) {
    logResponse(res, body, startTime, correlationId);
    return originalJson.call(this, body);
  };

  // Handle response end for cases without explicit send/json
  res.on('finish', () => {
    if (!res.locals.logged) {
      logResponse(res, null, startTime, correlationId);
    }
  });

  next();
};

/**
 * Log response details with timing
 */
function logResponse(
  res: Response,
  body: any,
  startTime: number,
  correlationId: string
): void {
  if (res.locals.logged) return; // Prevent double logging
  res.locals.logged = true;

  const responseTime = Date.now() - startTime;
  const responseMetadata = {
    correlationId,
    statusCode: res.statusCode,
    responseTime,
    contentLength: res.get('Content-Length'),
    responseBody: sanitizeResponseBody(body, res.statusCode),
    timestamp: new Date().toISOString()
  };

  // Get request details from res object
  const req = res.req as any;
  const method = req?.method;
  const url = req?.originalUrl || req?.url;

  // Log response
  if (res.statusCode >= 500) {
    requestLogger.error('Server error response', {
      ...responseMetadata,
      method,
      url,
      statusCode: responseMetadata.statusCode,
      responseTime: responseMetadata.responseTime
    });
  } else if (res.statusCode >= 400) {
    requestLogger.warn('Client error response', {
      ...responseMetadata,
      method,
      url,
      statusCode: responseMetadata.statusCode,
      responseTime: responseMetadata.responseTime
    });
  } else {
    requestLogger.info('Request completed', {
      ...responseMetadata,
      method,
      url,
      statusCode: responseMetadata.statusCode,
      responseTime: responseMetadata.responseTime
    });
  }

  // Log security events
  logSecurityEvents(res.statusCode, correlationId, responseTime);
}

/**
 * Log security-relevant events
 */
function logSecurityEvents(
  statusCode: number,
  correlationId: string,
  responseTime: number
): void {
  const securityMetadata = {
    correlationId,
    statusCode,
    responseTime,
    timestamp: new Date().toISOString()
  };

  if (statusCode === 401) {
    securityLogger.warn('Authentication failure', {
      ...securityMetadata,
      event: 'auth_failure',
      severity: 'medium'
    });
  } else if (statusCode === 403) {
    securityLogger.warn('Authorization failure', {
      ...securityMetadata,
      event: 'authz_failure',
      severity: 'medium'
    });
  } else if (statusCode === 429) {
    securityLogger.warn('Rate limit exceeded', {
      ...securityMetadata,
      event: 'rate_limit',
      severity: 'low'
    });
  } else if (responseTime > 5000) {
    securityLogger.info('Slow response detected', {
      ...securityMetadata,
      event: 'slow_response',
      severity: 'low'
    });
  }
}

/**
 * Sanitize request body to remove sensitive information
 */
function sanitizeBody(body: any): any {
  if (!body || typeof body !== 'object') return body;

  const sanitized = { ...body };
  
  // Remove or redact sensitive fields
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
}

/**
 * Sanitize response body for logging
 */
function sanitizeResponseBody(body: any, statusCode: number): any {
  // Don't log response body for successful requests (reduce log size)
  if (statusCode >= 200 && statusCode < 300) {
    return undefined;
  }

  // Log error responses but sanitize sensitive data
  if (body && typeof body === 'object') {
    const sanitized = { ...body };
    if (sanitized.token) sanitized.token = '[REDACTED]';
    if (sanitized.password) sanitized.password = '[REDACTED]';
    return sanitized;
  }

  return body;
}
