import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Extend Request interface to include correlationId
 */
declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

/**
 * Middleware to generate and propagate correlation IDs
 * Used to track requests across services and logs
 */
export const correlationMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Extract correlation ID from headers or generate new one
  const correlationId = 
    req.get('x-correlation-id') || 
    req.get('x-request-id') ||
    req.get('correlation-id') ||
    uuidv4();

  // Attach to request object
  req.correlationId = correlationId;

  // Add to response headers for client tracking
  res.set('x-correlation-id', correlationId);

  next();
};

/**
 * Get correlation ID from request
 */
export const getCorrelationId = (req: Request): string => {
  return req.correlationId || 'unknown';
};
