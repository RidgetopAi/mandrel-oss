/**
 * Project-detail data hooks — every read rides the UNIFIED client (`api.projects.*` /
 * `api.decisions.*`) through react-query, mirroring the Contexts/Tasks/Decisions/Projects
 * reference. Each section owns its own query so it owns its own loading/empty/error. The
 * update mutation writes through the same client. NO axios / generated / old useProjects
 * hooks here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { ProjectEntity, CreateProjectRequest } from '../../api/generated';
import type { Decision } from '../../types/decision';
import { PROJECT_DETAIL_CONFIG } from './config';

/**
 * The slice of `/api/projects/:id/insights` this screen reads. The endpoint serves the
 * real task breakdown, context/decision totals, and git_activity; we type only the
 * fields the dashboard surfaces so the mapping stays honest + explicit.
 */
export interface ProjectDetailInsights {
  project_id?: string;
  project_name?: string;
  tasks?: {
    total?: number;
    completed?: number;
    in_progress?: number;
    todo?: number;
    blocked?: number;
    cancelled?: number;
    completion_percentage?: number;
  };
  contexts?: { total?: number };
  decisions?: { total?: number };
  git_activity?: {
    total_commits?: number;
    total_insertions?: number;
    total_deletions?: number;
    files_changed?: number;
    latest_commit_date?: string | null;
    latest_commit_message?: string | null;
  };
  generated_at?: string;
}

/** The real per-session read model served by `api.projects.sessions` (context-based). */
export interface ProjectSession {
  id: string;
  project_id?: string;
  project_name?: string;
  created_at?: string;
  session_type?: string;
  context_count?: number;
  last_context_at?: string;
}

/** GET /api/projects/:id — the project record (vital signs live on the row). */
export function useProjectRecord(id: string | null | undefined) {
  return useQuery<ProjectEntity>({
    queryKey: ['projects', 'detail', id],
    queryFn: () => api.projects.get(id as string),
    enabled: Boolean(id),
    staleTime: PROJECT_DETAIL_CONFIG.recordStaleMs,
  });
}

/** GET /api/projects/:id/insights — task/decision/context/git breakdown. */
export function useProjectInsights(id: string | null | undefined) {
  return useQuery<ProjectDetailInsights>({
    queryKey: ['projects', 'insights', id],
    queryFn: () => api.projects.insights(id as string) as Promise<ProjectDetailInsights>,
    enabled: Boolean(id),
    staleTime: PROJECT_DETAIL_CONFIG.insightsStaleMs,
  });
}

/** GET /api/projects/:id/sessions — the project's context-based sessions. */
export function useProjectSessions(id: string | null | undefined) {
  return useQuery<ProjectSession[]>({
    queryKey: ['projects', 'sessions', id],
    queryFn: () => api.projects.sessions(id as string) as Promise<ProjectSession[]>,
    enabled: Boolean(id),
    staleTime: PROJECT_DETAIL_CONFIG.sessionsStaleMs,
  });
}

/**
 * GET /api/decisions?project_id=… — the project's recent decisions for the decisions
 * card (an EXISTING endpoint the Decisions screen uses; project_id scopes it server-side).
 */
export function useProjectDecisions(id: string | null | undefined) {
  return useQuery<Decision[]>({
    queryKey: ['projects', 'decisions', id],
    queryFn: async () => {
      const res = await api.decisions.search({
        project_id: id as string,
        limit: PROJECT_DETAIL_CONFIG.decisionsShown,
        offset: 0,
      });
      return res.decisions ?? [];
    },
    enabled: Boolean(id),
    staleTime: PROJECT_DETAIL_CONFIG.decisionsStaleMs,
  });
}

/** PUT /api/projects/:id — edit the project, then refresh the detail + list reads. */
export function useUpdateProject(id: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Partial<CreateProjectRequest>) =>
      api.projects.update(id as string, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects', 'detail', id] });
      qc.invalidateQueries({ queryKey: ['projects', 'list'] });
      qc.invalidateQueries({ queryKey: ['projects', 'insights', id] });
    },
  });
}
