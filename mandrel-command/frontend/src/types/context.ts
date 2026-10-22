import type { ContextEntity, ContextSearchResponse, ContextStats as GeneratedContextStats } from '../api/generated';

export type Context = ContextEntity & {
  project_name?: string;
  session_title?: string;
  session_id?: string;
  session_type?: string;
  summary?: string;
  /**
   * SOFT-DELETE marker. `null`/absent = live; a timestamp = archived.
   * Served ONLY by the by-id read: the list hides archived rows, and the reader is where
   * a user discovers they need to un-delete, so this is what lets the reader offer
   * Restore instead of a dead permalink. Mirrors Task.archived_at.
   */
  archived_at?: string | null;
};

export interface ContextSearchResult extends Omit<ContextSearchResponse, 'contexts'> {
  contexts: Context[];
  limit?: number;
  offset?: number;
  page?: number;
}

export interface ContextStats extends Partial<GeneratedContextStats> {
  total_contexts?: number;
  by_type?: Record<string, number>;
  by_project?: Record<string, number>;
  recent_contexts?: number;
  total_projects?: number;
  most_recent_timestamp?: string;
  /**
   * Count of SOFT-DELETED (archived) contexts in scope. Served ALONGSIDE
   * `total_contexts`, never inside it — the totals count LIVE rows only, so a deleted
   * context leaves the number instead of sitting in it forever.
   */
  archived?: number;
}

/**
 * One typed graph edge touching a context — the TreeWalker "thread box" moat, served
 * by GET /api/contexts/:id/links. A REAL `links`-table row (structure), NOT a semantic
 * `related` result. `direction: 'outgoing'` reads forward from this context; 'incoming'
 * points at it (rendered with the reverse label). `otherKind` is the target's kind for
 * colour/label — a context's `context_type` (milestone/handoff/…), or 'decision'/'task'.
 */
export interface ContextLink {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherType: 'context' | 'decision' | 'task';
  otherTitle: string;
  otherKind: string;
}

export interface ContextSearchParams {
  query?: string;
  project_id?: string;
  session_id?: string;
  type?: string;
  tags?: string[];
  min_similarity?: number;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
  sort_by?: 'created_at' | 'relevance' | 'updated_at';
  sort_order?: 'asc' | 'desc';
}
