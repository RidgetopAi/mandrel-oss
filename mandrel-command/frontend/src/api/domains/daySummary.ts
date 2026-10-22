/**
 * daySummary domain — the Calendar click-into-date report (`GET /api/day-summary`,
 * Command backend; endpoint an earlier task). One typed read.
 *
 * SCOPE PRECEDENCE (load-bearing): the endpoint reads the `project` QUERY param
 * ('all' or a uuid) and treats it as AUTHORITATIVE — the controller prefers the
 * query param over the auto-attached `X-Project-ID` header (backend commit 1e8a34f),
 * so the Calendar's own filter always wins over the globally selected project. In
 * particular `project=all` correctly means unscoped even while a global project is
 * header-selected.
 *
 * `project` is sent RAW — the literal `'all'` included. Turning `'all'` into "omit the
 * param" would change its meaning from EXPLICITLY UNSCOPED to "scoped by the header".
 *
 * ── THE `config` PARAMETER IS REQUIRED, ON PURPOSE (epic 41293984 §A1) ────────────────
 * The hand-rolled `X-Project-ID` this used to build is now the shared primitive's job:
 * the Day summary inherits Calendar's selection and is called with that page's
 * `usePageProject().scope()`. Required, not optional, so an unscoped call site cannot
 * compile. See api/domains/momentumSeries.ts for the same note.
 */
import type { AxiosRequestConfig } from 'axios';
import { http, unwrapData, type ApiEnvelope } from '../request';
import { withParams } from './scopeConfig';

/** One KPI: the day's value plus its delta vs the rolling baseline average. */
export interface DaySummaryKpi {
  value: number;
  delta: number;
}

export interface DaySummaryData {
  date: string;
  tz: string;
  project: string; // 'all' or a project uuid (echoed back by the backend)
  headline: string | null;
  momentum: {
    score: number;
    delta: number;
    breakdown: { output: number; followThrough: number; depth: number };
  };
  kpis: {
    sessions: DaySummaryKpi;
    activeMinutes: DaySummaryKpi;
    contexts: DaySummaryKpi;
    decisions: DaySummaryKpi;
    tasksDone: DaySummaryKpi;
    filesTouched: DaySummaryKpi;
  };
  ribbon: Array<{ hour: number; count: number }>;
  highlights: Array<{ type: string; text: string; id: string }>;
  decisions: Array<{ title: string; id: string }>;
  tasksCompleted: { count: number; items: Array<{ title: string; id: string }> };
  byActor: Array<{ actor: string; count: number }>;
}

export interface DaySummaryParams {
  /** The clicked day as a LOCAL `YYYY-MM-DD` key (never a UTC-shifted toISOString). */
  date: string;
  /** RAW project filter passed straight through: the literal 'all' or a project uuid. */
  project: string;
  /** Viewer IANA timezone; omitted when undefined so the backend defaults to UTC. */
  tz?: string;
}

export const daySummaryApi = {
  /** GET /api/day-summary?date=&tz=&project= */
  async get(
    { date, project, tz }: DaySummaryParams,
    config: AxiosRequestConfig
  ): Promise<DaySummaryData> {
    const body = await http.get<ApiEnvelope<DaySummaryData>>(
      '/day-summary',
      withParams(config, { date, project, ...(tz ? { tz } : {}) })
    );
    return unwrapData(body, 'Failed to load day summary') as DaySummaryData;
  },
};

export type DaySummaryApi = typeof daySummaryApi;
