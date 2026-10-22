/**
 * dashboard domain — the KPI bundle (`/api/dashboard/stats`, Command backend).
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';

export interface DashboardStatsData {
  contexts?: number;
  projects?: number;
  activeTasks?: number;
  totalTasks?: number;
  recentActivity?: {
    contextsThisWeek?: number;
    tasksCompletedThisWeek?: number;
    sessionsThisWeek?: number;
  };
}

export const dashboardApi = {
  /** GET /api/dashboard/stats */
  async stats(config?: AxiosRequestConfig): Promise<DashboardStatsData> {
    const body = await http.get<ApiEnvelope<DashboardStatsData>>('/dashboard/stats', config);
    return (unwrapData(body, 'Failed to fetch dashboard stats') ?? {}) as DashboardStatsData;
  },
};

export type DashboardApi = typeof dashboardApi;
