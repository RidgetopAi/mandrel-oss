/**
 * Projects data hooks — every read rides the UNIFIED client (`api.projects.*`) through
 * react-query, mirroring the Contexts/Tasks/Decisions reference. The list feeds the grid
 * (context/session counts + last activity come straight off the list), and each card
 * lazy-loads its own insights (task + decision counts + the in-progress "active work"
 * signal) so a card owns its own loading/error. Create writes through the same client. NO
 * axios/generated clients here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { ProjectEntity, CreateProjectRequest } from '../../api/generated';
import { PROJECTS_CONFIG } from './config';

/**
 * The slice of `/api/projects/:id/insights` this screen reads. The endpoint serves more
 * (git activity, per-status task breakdown); we type only the fields the cards surface so
 * the mapping stays honest + explicit.
 */
export interface ProjectInsightsData {
  project_id?: string;
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
  generated_at?: string;
}

/** GET /api/projects — the portfolio list (real per-project vital signs). */
export function useProjectList() {
  return useQuery<ProjectEntity[]>({
    queryKey: ['projects', 'list'],
    queryFn: () => api.projects.list(),
    staleTime: PROJECTS_CONFIG.listStaleMs,
  });
}

/**
 * GET /api/projects/:id/insights — the task + decision counts a card needs beyond the
 * list (lazy per card, only when an id is present).
 */
export function useProjectInsights(id: string | null | undefined) {
  return useQuery<ProjectInsightsData>({
    queryKey: ['projects', 'insights', id],
    queryFn: () => api.projects.insights(id as string) as Promise<ProjectInsightsData>,
    enabled: Boolean(id),
    staleTime: PROJECTS_CONFIG.insightsStaleMs,
  });
}

/** POST /api/projects — create a project, then refresh the portfolio list. */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProjectRequest) => api.projects.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects', 'list'] });
    },
  });
}
