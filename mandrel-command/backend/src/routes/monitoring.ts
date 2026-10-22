/**
 * TR015-4: Enhanced Service Monitoring Routes
 * Oracle Refactor Phase 4 - Service Monitoring and Alerting
 */

import { Router, Request, Response } from 'express';
import { MonitoringController } from '../controllers/monitoring';
import { monitoringService } from '../services/monitoring';
import { authenticateToken } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/apiResponse';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';

const router = Router();

// Apply authentication to monitoring routes
router.use(authenticateToken);

// Legacy monitoring routes (maintain backward compatibility)

/**
 * @swagger
 * /monitoring/drift-fixture-ping:
 *   get:
 *     summary: THROWAWAY FIXTURE — proves STAGE 5o catches undocumented drift
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: pong
 */
router.get('/drift-fixture-ping', (_req: Request, res: Response) => {
  res.json({ pong: true });
});

/**
 * @swagger
 * /monitoring/health:
 *   get:
 *     summary: Retrieve system health snapshot
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Health payload returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/MonitoringHealth'
 */
router.get('/health', MonitoringController.getSystemHealth);

/**
 * @swagger
 * /monitoring/metrics:
 *   get:
 *     summary: Retrieve system metrics snapshot
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Metrics payload returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/MonitoringMetrics'
 */
router.get('/metrics', MonitoringController.getSystemMetrics);

/**
 * @swagger
 * /monitoring/trends:
 *   get:
 *     summary: Retrieve performance trends
 *     tags: [Monitoring]
 *     parameters:
 *       - in: query
 *         name: minutes
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Size of the sliding window (in minutes)
 *     responses:
 *       200:
 *         description: Trend data returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/MonitoringTrends'
 */
router.get('/trends', MonitoringController.getPerformanceTrends);

/**
 * @swagger
 * /monitoring/errors:
 *   post:
 *     summary: Record UI error event
 *     tags: [Monitoring]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *     responses:
 *       201:
 *         description: Error captured
 */
router.post(
  '/errors',
  declareAnyAuthenticatedMayWrite('the browser reporting its own UI errors; append-only telemetry'),
  MonitoringController.recordUiError
);

// TR015-4: Service-specific monitoring routes
/**
 * GET /api/monitoring/services
 * Get all monitored services status
 */
/**
 * @swagger
 * /monitoring/services:
 *   get:
 *     summary: Retrieve status for all monitored services
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Service status list
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/MonitoringServiceStatus'
 */
router.get('/services', async (_req: Request, res: Response) => {
  try {
    const services = await monitoringService.checkAllServices();
    sendSuccess(res, services);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * GET /api/monitoring/services/:serviceName
 * Get specific service health status
 */
/**
 * @swagger
 * /monitoring/services/{serviceName}:
 *   get:
 *     summary: Retrieve status for a specific service
 *     tags: [Monitoring]
 *     parameters:
 *       - in: path
 *         name: serviceName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service health returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/MonitoringServiceStatus'
 *       404:
 *         description: Service not found
 */
router.get('/services/:serviceName', async (req: Request, res: Response) => {
  try {
    const { serviceName } = req.params;
    const service = await monitoringService.checkServiceHealth(serviceName);
    sendSuccess(res, service);
  } catch (error: unknown) {
    sendError(res, error, 404, 'Service not found');
  }
});

/**
 * GET /api/monitoring/stats
 * Get monitoring statistics and SLA compliance
 */
/**
 * @swagger
 * /monitoring/stats:
 *   get:
 *     summary: Retrieve monitoring statistics and SLA compliance
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Monitoring statistics returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/MonitoringStats'
 */
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const stats = monitoringService.getServiceMonitoringStats();
    sendSuccess(res, stats);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * GET /api/monitoring/alerts
 * Get recent alerts
 */
/**
 * @swagger
 * /monitoring/alerts:
 *   get:
 *     summary: Retrieve recent monitoring alerts
 *     tags: [Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Alerts returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/MonitoringAlert'
 */
router.get('/alerts', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const alerts = monitoringService.getRecentAlerts(limit);
    sendSuccess(res, alerts, { count: alerts.length });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * GET /api/monitoring/alert-rules
 * Get all alert rules
 */
router.get('/alert-rules', (_req: Request, res: Response) => {
  try {
    const rules = monitoringService.getAlertRules();
    sendSuccess(res, rules, { count: rules.length });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * PUT /api/monitoring/alert-rules/:ruleId
 * Update alert rule configuration
 */
router.put(
  '/alert-rules/:ruleId',
  declareAnyAuthenticatedMayWrite('operational tuning of an alert rule — FLAGGED as a plausible admin-only control, unchanged here'),
  (req: Request, res: Response) => {
  try {
    const { ruleId } = req.params;
    const updates = req.body;

    monitoringService.updateAlertRule(ruleId, updates);

    res.json({
      success: true,
      message: `Alert rule ${ruleId} updated`,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * POST /api/monitoring/start
 * Start service monitoring
 */
router.post(
  '/start',
  declareAnyAuthenticatedMayWrite('starting monitoring — FLAGGED as a plausible admin-only control, unchanged here'),
  (req: Request, res: Response) => {
  try {
    const intervalMs = parseInt(req.body.intervalMs) || 30000;
    monitoringService.startServiceMonitoring(intervalMs);

    res.json({
      success: true,
      message: 'Service monitoring started',
      intervalMs,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * POST /api/monitoring/stop
 * Stop service monitoring
 */
router.post(
  '/stop',
  declareAnyAuthenticatedMayWrite('stopping monitoring — FLAGGED as a plausible admin-only control, unchanged here'),
  (_req: Request, res: Response) => {
  try {
    monitoringService.stopServiceMonitoring();

    res.json({
      success: true,
      message: 'Service monitoring stopped',
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * GET /api/monitoring/status
 * Get monitoring system status
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    const isRunning = monitoringService.isServiceMonitoringRunning();
    const stats = monitoringService.getServiceMonitoringStats();
    const services = monitoringService.getAllMonitoredServices();

    sendSuccess(res, {
      isRunning,
      stats,
      services: services.map(s => ({
        name: s.name,
        status: s.status,
        lastCheck: s.lastCheck,
        responseTime: s.responseTime
      })),
      alertRulesCount: monitoringService.getAlertRules().length,
      recentAlertsCount: monitoringService.getRecentAlerts(10).length
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * GET /api/monitoring/dashboard
 * Get comprehensive monitoring dashboard data
 */
router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    // Get fresh service data
    const services = await monitoringService.checkAllServices();
    const stats = monitoringService.getServiceMonitoringStats();
    const recentAlerts = monitoringService.getRecentAlerts(20);
    const alertRules = monitoringService.getAlertRules();
    const isMonitoringActive = monitoringService.isServiceMonitoringRunning();

    // Get legacy health summary for backward compatibility
    const healthSummary = await monitoringService.getHealthSummary();

    sendSuccess(res, {
      monitoring: {
        isActive: isMonitoringActive,
        stats,
        services,
        alertRules: alertRules.length,
        recentAlerts: recentAlerts.length
      },
      system: healthSummary,
      alerts: recentAlerts.slice(0, 10), // Latest 10 alerts
      slaCompliance: {
        overall: stats.slaCompliance,
        breakdown: services.map(s => ({
          service: s.name,
          status: s.status,
          responseTime: s.responseTime,
          slaTarget: s.slaTarget,
          compliant: s.responseTime <= s.slaTarget
        }))
      }
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export default router;
