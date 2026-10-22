import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import monitoringClient from '../api/monitoringClient';
import type {
  MonitoringAlert,
  MonitoringHealth,
  MonitoringMetrics,
  MonitoringStats,
  MonitoringTrends,
} from '../api/monitoringClient';

export const monitoringQueryKeys = {
  all: ['monitoring'] as const,
  health: () => [...monitoringQueryKeys.all, 'health'] as const,
  metrics: () => [...monitoringQueryKeys.all, 'metrics'] as const,
  trends: (minutes: number) => [...monitoringQueryKeys.all, 'trends', minutes] as const,
  stats: () => [...monitoringQueryKeys.all, 'stats'] as const,
  alerts: (limit: number) => [...monitoringQueryKeys.all, 'alerts', limit] as const,
};

export const useSystemHealthQuery = (
  options?: Partial<UseQueryOptions<MonitoringHealth>>
) => {
  return useQuery({
    queryKey: monitoringQueryKeys.health(),
    queryFn: () => monitoringClient.getHealth(),
    ...options,
  });
};

export const useSystemMetricsQuery = (
  options?: Partial<UseQueryOptions<MonitoringMetrics>>
) => {
  return useQuery({
    queryKey: monitoringQueryKeys.metrics(),
    queryFn: () => monitoringClient.getMetrics(),
    ...options,
  });
};

export const usePerformanceTrendsQuery = (
  minutes = 5,
  options?: Partial<UseQueryOptions<MonitoringTrends>>
) => {
  return useQuery({
    queryKey: monitoringQueryKeys.trends(minutes),
    queryFn: () => monitoringClient.getTrends(minutes),
    ...options,
  });
};

export const useMonitoringStatsQuery = (
  options?: Partial<UseQueryOptions<MonitoringStats>>
) => {
  return useQuery({
    queryKey: monitoringQueryKeys.stats(),
    queryFn: () => monitoringClient.getStats(),
    ...options,
  });
};

export const useMonitoringAlertsQuery = (
  limit = 50,
  options?: Partial<UseQueryOptions<MonitoringAlert[]>>
) => {
  return useQuery({
    queryKey: monitoringQueryKeys.alerts(limit),
    queryFn: () => monitoringClient.getAlerts(limit),
    ...options,
  });
};
