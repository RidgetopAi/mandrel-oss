import { Request, Response } from 'express';
import { checkDatabaseHealth, getDatabaseStats } from '../database/connection';
import { asyncHandler } from '../middleware/errorHandler';
import config from '../config/environment';

/*
 * DELETED 2026-08-25: `getHealth`.
 *
 * It served `process.memoryUsage()` and `config.nodeEnv` to anyone, on prod and all 7
 * tenants, from the one route the container healthcheck REQUIRES to stay unauthenticated.
 * The reduced public handler now lives inline in routes/health.ts, where the reason it is
 * public sits next to the reason it is small.
 *
 * Removed rather than left unused: an exported controller that leaks metadata and is
 * mounted nowhere is a loaded gun for whoever wires it up next.
 */

/**
 * Database connection status
 */
export const getDatabaseStatus = asyncHandler(async (_req: Request, res: Response) => {
  const healthCheck = await checkDatabaseHealth();
  const stats = healthCheck.connected ? await getDatabaseStats() : null;

  res.json({
    success: true,
    data: {
      database: {
        ...healthCheck,
        ...(stats && { stats })
      }
    }
  });
});

/**
 * Application version and info
 */
export const getVersion = asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      name: config.app.name,
      version: config.app.version,
      description: config.app.description,
      node_version: process.version,
      environment: config.nodeEnv,
      timestamp: new Date().toISOString()
    }
  });
});
