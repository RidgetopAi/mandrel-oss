/**
 * monitoring domain — system health/metrics/services/alerts + UI error report
 * (`/api/monitoring/*`, Command backend). Reuses the generated Monitoring* models.
 * NOTE: most of this surface is not rendered by any screen today (recon flagged
 * the dead monitoring components); only `recordUiError` is exercised live (via
 * services/errorReporter.ts). The methods are real+typed so the eventual System panel can
 * adopt them.
 * This claim was FALSE until 2026-07-29 — errorReporter used `navigator.sendBeacon` and a raw
 * `fetch`, neither of which sent `Authorization`, so every report was silently 401'd by
 * `authenticateToken` on the backend route and this method was never called. It is true now
 * because errorReporter routes its default path through `recordUiError` (the authenticated
 * client). Left as a note rather than a silent edit: a comment asserting live exercise is a
 * claim, and this one had been wrong long enough to mislead a reviewer.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type {
  MonitoringHealth,
  MonitoringMetrics,
  MonitoringTrends,
  MonitoringServiceStatus,
  MonitoringStats,
  MonitoringAlert,
} from '../generated';

export const monitoringApi = {
  /** GET /api/monitoring/health */
  async health(): Promise<MonitoringHealth> {
    const body = await http.get<ApiEnvelope<MonitoringHealth>>('/monitoring/health');
    return unwrapData(body, 'Failed to fetch system health');
  },

  /** GET /api/monitoring/metrics */
  async metrics(): Promise<MonitoringMetrics> {
    const body = await http.get<ApiEnvelope<MonitoringMetrics>>('/monitoring/metrics');
    return unwrapData(body, 'Failed to fetch system metrics');
  },

  /** GET /api/monitoring/trends */
  async trends(minutes = 5): Promise<MonitoringTrends> {
    const body = await http.get<ApiEnvelope<MonitoringTrends>>('/monitoring/trends', {
      params: { minutes },
    });
    return unwrapData(body, 'Failed to fetch performance trends');
  },

  /** GET /api/monitoring/services */
  async services(): Promise<MonitoringServiceStatus[]> {
    const body = await http.get<ApiEnvelope<MonitoringServiceStatus[]>>('/monitoring/services');
    return (unwrapData(body, 'Failed to load monitored services') ?? []) as MonitoringServiceStatus[];
  },

  /** GET /api/monitoring/services/:name */
  async service(name: string): Promise<MonitoringServiceStatus> {
    const body = await http.get<ApiEnvelope<MonitoringServiceStatus>>(
      `/monitoring/services/${encodeURIComponent(name)}`
    );
    const status = unwrapData(body, 'Failed to load service status');
    if (!status) {
      throw new Error('Service status payload missing in response');
    }
    return status;
  },

  /** GET /api/monitoring/stats */
  async stats(): Promise<MonitoringStats> {
    const body = await http.get<ApiEnvelope<MonitoringStats>>('/monitoring/stats');
    return (unwrapData(body, 'Failed to fetch monitoring statistics') ?? {}) as MonitoringStats;
  },

  /** GET /api/monitoring/alerts */
  async alerts(limit = 50): Promise<MonitoringAlert[]> {
    const body = await http.get<ApiEnvelope<MonitoringAlert[]>>('/monitoring/alerts', {
      params: { limit },
    });
    return (unwrapData(body, 'Failed to fetch monitoring alerts') ?? []) as MonitoringAlert[];
  },

  /** POST /api/monitoring/errors — report a UI error (also fired by errorReporter). */
  async recordUiError(payload: Record<string, unknown>): Promise<void> {
    await http.post<ApiEnvelope<unknown>>('/monitoring/errors', payload);
  },
};

export type MonitoringApi = typeof monitoringApi;
