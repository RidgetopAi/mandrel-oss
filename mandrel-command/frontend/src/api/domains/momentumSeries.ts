/**
 * momentumSeries domain — the Calendar per-cell momentum heatmap read
 * (`GET /api/momentum-series`, Command backend). One
 * typed batch call returns the day's Momentum score + delta AND its headline counts for
 * every day in `[from..to]`, so the Day/Week/Month grids paint a momentum ring on each
 * cell in ONE request — replacing the grid's separate `/api/sessions/trends` density fetch.
 *
 * SCOPE PRECEDENCE (load-bearing, mirrors day-summary): the endpoint treats the `project`
 * QUERY param ('all' or a uuid) as AUTHORITATIVE over the auto-attached `X-Project-ID`
 * header, so the Calendar's own filter always wins — `project=all` means unscoped even
 * while a global project is header-selected. The backend spells that contract out in
 * services/projectScopeResolver.ts ("THE `all` SENTINEL"), and it is pinned end-to-end by
 * `__tests__/calendarUnscopedContract.db.test.ts` on the backend and
 * `pages/Calendar.allContract.test.tsx` on the frontend.
 *
 * `project` is therefore sent RAW — the literal string `'all'` included. Converting `'all'`
 * into "omit the param" would silently change its meaning from EXPLICITLY UNSCOPED to
 * "scoped by whatever the header happens to say", which is a different request.
 *
 * ── THE `config` PARAMETER IS REQUIRED, ON PURPOSE (an earlier epic §A1) ────────────────
 * This method used to hand-roll `X-Project-ID` from the `project` argument. That is now
 * the shared primitive's job: the caller passes `usePageProject().scope()`, which pins the
 * header for a uuid and BLANKS it for `'all'` (so an All-projects view is not silently
 * re-narrowed by the ambient default). Making it a required parameter rather than an
 * optional one means a call site that forgets to scope itself is a COMPILE error, not a
 * silently mis-scoped request — the two call sites are the Calendar grid and nothing else.
 */
import type { AxiosRequestConfig } from 'axios';
import { http, unwrapData, type ApiEnvelope } from '../request';
import { withParams } from './scopeConfig';

/** One per-day cell of the momentum series. */
export interface MomentumSeriesPoint {
  date: string;
  momentum: { score: number; delta: number };
  sessions: number;
  contexts: number;
  /** Tasks COMPLETED that day. */
  tasks: number;
  /** False when the day had zero recorded activity → the cell renders blank (no ring). */
  hasData: boolean;
}

export interface MomentumSeriesParams {
  /** Inclusive range start as a LOCAL `YYYY-MM-DD` key (never a UTC-shifted toISOString). */
  from: string;
  /** Inclusive range end as a LOCAL `YYYY-MM-DD` key. */
  to: string;
  /** RAW project filter passed straight through: the literal 'all' or a project uuid. */
  project: string;
  /** Viewer IANA timezone; omitted when undefined so the backend defaults to UTC. */
  tz?: string;
}

export const momentumSeriesApi = {
  /** GET /api/momentum-series?from=&to=&tz=&project= */
  async get(
    { from, to, project, tz }: MomentumSeriesParams,
    config: AxiosRequestConfig
  ): Promise<MomentumSeriesPoint[]> {
    const body = await http.get<ApiEnvelope<MomentumSeriesPoint[]>>(
      '/momentum-series',
      // `project` goes out verbatim — 'all' included. See the header.
      withParams(config, { from, to, project, ...(tz ? { tz } : {}) })
    );
    return (unwrapData(body, 'Failed to load momentum series') ?? []) as MomentumSeriesPoint[];
  },
};

export type MomentumSeriesApi = typeof momentumSeriesApi;
