/**
 * Request Monitoring Middleware
 * Records API request metrics for system monitoring dashboard
 */

import { Request, Response, NextFunction } from 'express';
import { monitoringService } from '../services/monitoring';

/**
 * Middleware to record API requests in the monitoring service
 */
export const requestMonitoringMiddleware = (_req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  
  // Hook into response finish event
  const originalEnd = res.end.bind(res);
  
  res.end = function(chunk?: any, encoding?: any, cb?: any) {
    const responseTime = Date.now() - startTime;
    const isError = res.statusCode >= 400;
    
    // Record the request in monitoring service
    monitoringService.recordRequest(responseTime, isError);
    
    // Call original end method
    return originalEnd(chunk, encoding, cb);
  } as any;
  
  next();
};

export default requestMonitoringMiddleware;
