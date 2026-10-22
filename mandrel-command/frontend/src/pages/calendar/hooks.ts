/**
 * Calendar data hooks — every read rides the UNIFIED client (`api.<domain>.*`)
 * through react-query. NO axios/generated clients here, mirroring the Dashboard /
 * Sessions reference wiring.
 *
 *   • useMomentumSeries → GET /api/momentum-series?from=&to=  (per-day momentum + counts)
 *   • useCalendarTasks  → GET /api/tasks                      (scheduled-by-due-date cards)
 *
 * The momentum-series query fetches EXACTLY the visible range `[from..to]` (each view
 * passes its own span — a single day, the 7 week days, or the 42-cell month grid); the
 * backend efficiently derives every cell's baseline from one query. It carries the viewer's
 * IANA tz so each day buckets in local time and the RAW project filter
 * ('all' or a uuid) so the Calendar's own scope is authoritative.
 *
 * ── THE RAW `'all'` IS THE CONTRACT, NOT AN ACCIDENT (epic 41293984 §E) ───────────────
 * Both reads send the page's selection VERBATIM — the literal string `'all'` included.
 * The backend accepts `'all'` from a QUERY source (and only from a query source) as
 * EXPLICITLY UNSCOPED, and that beats the `X-Project-ID` header by precedence
 * (backend/src/services/projectScopeResolver.ts). Rewriting `'all'` to "omit the param"
 * would look equivalent and is not: it demotes the request from "the user chose every
 * project" to "scope me by whatever the header says", which after this change set is the
 * user's DEFAULT project. Pinned by `pages/Calendar.allContract.test.tsx` and
 * `backend/src/__tests__/calendarUnscopedContract.db.test.ts`.
 *
 * `scope()` (from `usePageProject`) pins `X-Project-ID` per request; it throws rather than
 * falling back, so both queries are gated on the page's `ready`.
 */
import { useQuery } from '@tanstack/react-query';
import type { AxiosRequestConfig } from 'axios';
import { api } from '../../api';
import type { MomentumSeriesPoint } from '../../api/domains/momentumSeries';
import type { TaskEntity } from '../../api/generated/models/TaskEntity';
import { CALENDAR_CONFIG } from './config';

/**
 * Per-day momentum (score + delta) and headline counts for the visible range
 * `[fromKey..toKey]` (both LOCAL `YYYY-MM-DD` keys). ONE request paints every cell in the
 * active view — replacing the old separate `/api/sessions/trends` density fetch. `project`
 * is the raw filter ('all' or a uuid); `tz` is the viewer's zone (omitted → backend UTC).
 */
export function useMomentumSeries(args: {
  fromKey: string;
  toKey: string;
  /** The page's selection, RAW: a project uuid or the literal `'all'`. */
  project: string | undefined;
  scope: () => AxiosRequestConfig;
  enabled: boolean;
  tz?: string;
}) {
  const { fromKey, toKey, project, scope, enabled, tz } = args;
  return useQuery<MomentumSeriesPoint[]>({
    queryKey: ['calendar', 'momentum', fromKey, toKey, project ?? null, tz ?? null],
    enabled,
    queryFn: () =>
      api.momentumSeries.get({ from: fromKey, to: toKey, project: project as string, tz }, scope()),
    staleTime: CALENDAR_CONFIG.staleTimeMs,
  });
}

/** Every task (newest first) — grouped onto its due-date day at the callsite. */
export function useCalendarTasks(args: {
  /** The page's selection, RAW: a project uuid or the literal `'all'`. */
  projectId: string | undefined;
  scope: () => AxiosRequestConfig;
  enabled: boolean;
}) {
  const { projectId, scope, enabled } = args;
  return useQuery<TaskEntity[]>({
    queryKey: ['calendar', 'tasks', CALENDAR_CONFIG.taskListLimit, projectId ?? null],
    enabled,
    queryFn: async () => {
      const res = await api.tasks.list(
        {
          limit: CALENDAR_CONFIG.taskListLimit,
          // RAW, `'all'` included — same contract as the momentum series above. This used
          // to drop the param for 'all', which is a header-scoped request wearing an
          // unscoped request's clothes.
          ...(projectId ? { project_id: projectId } : {}),
        },
        scope()
      );
      return res.tasks;
    },
    staleTime: CALENDAR_CONFIG.staleTimeMs,
  });
}
