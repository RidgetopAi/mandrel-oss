/**
 * resolve domain — bare-id → navigation-record resolution (`/api/resolve/:id`,
 * Command backend). The implementation already rides the shared axios `apiClient`
 * (never throws; maps every outcome to a fail-closed union), so the unified facade
 * simply re-exports it under `api.resolve`.
 */
import { resolveNavRecord } from '../resolveClient';

export const resolveApi = {
  /** GET /api/resolve/:id → discriminated ResolveResult (unique/ambiguous/invalid/notfound). */
  record: resolveNavRecord,
};

export type ResolveApi = typeof resolveApi;
