import { Request, Response } from 'express';
import { monitoringService } from '../services/monitoring';
import { logger } from '../config/logger';

export class MonitoringController {
  /**
   * GET /api/monitoring/health - System health check
   */
  static async getSystemHealth(_req: Request, res: Response): Promise<void> {
    try {
      const health = await monitoringService.getHealthSummary();
      
      res.json({
        success: true,
        data: health
      });
    } catch (error) {
      logger.error('Get system health error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get system health'
      });
    }
  }

  /**
   * GET /api/monitoring/metrics - System metrics
   */
  static async getSystemMetrics(_req: Request, res: Response): Promise<void> {
    try {
      const metrics = await monitoringService.getSystemMetrics();
      
      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      logger.error('Get system metrics error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get system metrics'
      });
    }
  }

  /**
   * GET /api/monitoring/trends - Performance trends
   */
  static async getPerformanceTrends(req: Request, res: Response): Promise<void> {
    try {
      const minutes = parseInt(req.query.minutes as string) || 5;
      const trends = monitoringService.getPerformanceTrends(minutes);
      
      res.json({
        success: true,
        data: trends
      });
    } catch (error) {
      logger.error('Get performance trends error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get performance trends'
      });
    }
  }

  /**
   * POST /api/monitoring/errors - Record UI error report
   */
  static async recordUiError(req: Request, res: Response): Promise<void> {
    try {
      monitoringService.recordUiError(req.body);
      res.json({ success: true });
    } catch (error) {
      logger.error('Record UI error failed', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to record UI error'
      });
    }
  }
}
