import {
  MonitoringService,
  type ApiSuccessResponse,
  type MonitoringAlert,
  type MonitoringHealth,
  type MonitoringMetrics,
  type MonitoringServiceStatus,
  type MonitoringStats,
  type MonitoringTrends,
} from './generated';

const ensureSuccess = <T extends ApiSuccessResponse>(response: T, failureMessage: string): T => {
  if (!response.success) {
    throw new Error(failureMessage);
  }
  return response;
};

export const monitoringClient = {
  async getHealth(): Promise<MonitoringHealth> {
    const response = ensureSuccess(
      await MonitoringService.getMonitoringHealth(),
      'Failed to fetch system health'
    );

    return response.data as MonitoringHealth;
  },

  async getMetrics(): Promise<MonitoringMetrics> {
    const response = ensureSuccess(
      await MonitoringService.getMonitoringMetrics(),
      'Failed to fetch system metrics'
    );

    return response.data as MonitoringMetrics;
  },

  async getTrends(minutes = 5): Promise<MonitoringTrends> {
    const response = ensureSuccess(
      await MonitoringService.getMonitoringTrends({ minutes }),
      'Failed to fetch performance trends'
    );

    return response.data as MonitoringTrends;
  },

  async getServices(): Promise<MonitoringServiceStatus[]> {
    const response = ensureSuccess(
      await MonitoringService.getMonitoringServices(),
      'Failed to load monitored services'
    );

    return (response.data ?? []) as MonitoringServiceStatus[];
  },

  async getService(serviceName: string): Promise<MonitoringServiceStatus> {
    const response = ensureSuccess(
      await MonitoringService.getMonitoringServices1({ serviceName }),
      'Failed to load service status'
    );

    if (!response.data) {
      throw new Error('Service status payload missing in response');
    }

    return response.data as MonitoringServiceStatus;
  },

  async getStats(): Promise<MonitoringStats> {
    const response = ensureSuccess(
      await MonitoringService.getMonitoringStats(),
      'Failed to fetch monitoring statistics'
    );

    return (response.data ?? {}) as MonitoringStats;
  },

  async getAlerts(limit = 50): Promise<MonitoringAlert[]> {
    const response = ensureSuccess(
      await MonitoringService.getMonitoringAlerts({ limit }),
      'Failed to fetch monitoring alerts'
    );

    return (response.data ?? []) as MonitoringAlert[];
  },

  async recordUiError(payload: Record<string, unknown>): Promise<void> {
    await MonitoringService.postMonitoringErrors({ requestBody: payload });
  },
};

export type { MonitoringHealth, MonitoringMetrics, MonitoringTrends, MonitoringServiceStatus, MonitoringStats, MonitoringAlert };

export default monitoringClient;
