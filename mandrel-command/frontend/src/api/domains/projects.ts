/**
 * projects domain — list / CRUD / stats / sessions / insights / primary-toggle.
 * All Command backend (`/api/projects/*`). Reuses generated ProjectEntity /
 * ProjectStats / CreateProjectRequest models.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';
import { withConfig, withParams } from './scopeConfig';
import { globalReadConfig } from '../http/projectScope';
import type { ProjectEntity } from '../generated/models/ProjectEntity';
import type { ProjectStats } from '../generated/models/ProjectStats';
import type { CreateProjectRequest } from '../generated/models/CreateProjectRequest';

export const projectsApi = {
  /**
   * GET /api/projects — EVERY project the caller may see. GLOBAL BY CONSTRUCTION.
   *
   * This endpoint is project-scoped like any other list (`resolveListScope`), so with the
   * ambient header pinned to the user's default it returns ONE row — and this list is what
   * fills every `<ProjectSelect>` on every page. A one-option selector looks perfectly
   * healthy and makes the whole selector rework inert (Reviewer B4).
   *
   * `globalReadConfig` sends the resolver's explicit `project_id=all` sentinel, so the
   * request is EXPLICITLY unscoped rather than accidentally unscoped. It is applied HERE,
   * not at the call sites, because "the project picker's options" is a property of this
   * method, and a caller that forgets it gets a silently-correct-looking one-item list.
   * The `config` passthrough still works — `withConfig` lets a caller add headers, and the
   * sentinel wins on `project_id` because the domain owns this endpoint's contract.
   */
  async list(config?: AxiosRequestConfig): Promise<ProjectEntity[]> {
    const body = await http.get<ApiEnvelope<{ projects?: ProjectEntity[] }>>(
      '/projects',
      withConfig(config, globalReadConfig())
    );
    return (unwrapData(body, 'Failed to list projects')?.projects ?? []) as ProjectEntity[];
  },

  /** GET /api/projects/watchable */
  async watchable(config?: AxiosRequestConfig): Promise<ProjectEntity[]> {
    const body = await http.get<ApiEnvelope<{ projects?: ProjectEntity[] }>>(
      '/projects/watchable',
      config
    );
    return (unwrapData(body, 'Failed to list watchable projects')?.projects ?? []) as ProjectEntity[];
  },

  /** GET /api/projects/:id */
  async get(id: string, config?: AxiosRequestConfig): Promise<ProjectEntity> {
    const body = await http.get<ApiEnvelope<{ project?: ProjectEntity }>>(
      `/projects/${encodeURIComponent(id)}`,
      config
    );
    const project = unwrapData(body, 'Failed to fetch project')?.project;
    if (!project) {
      throw new Error('Project payload missing in response');
    }
    return project;
  },

  /** POST /api/projects */
  async create(
    payload: CreateProjectRequest,
    config?: AxiosRequestConfig
  ): Promise<ProjectEntity> {
    const body = await http.post<ApiEnvelope<{ project?: ProjectEntity }>>(
      '/projects',
      payload,
      config
    );
    const project = unwrapData(body, 'Failed to create project')?.project;
    if (!project) {
      throw new Error('Project create payload missing in response');
    }
    return project;
  },

  /** PUT /api/projects/:id */
  async update(
    id: string,
    updates: Partial<CreateProjectRequest>,
    config?: AxiosRequestConfig
  ): Promise<ProjectEntity> {
    const body = await http.put<ApiEnvelope<{ project?: ProjectEntity }>>(
      `/projects/${encodeURIComponent(id)}`,
      updates,
      config
    );
    const project = unwrapData(body, 'Failed to update project')?.project;
    if (!project) {
      throw new Error('Project update payload missing in response');
    }
    return project;
  },

  /**
   * DELETE /api/projects/:id — irreversible, and SERVER-GATED.
   *
   * The server refuses with 409 + the measured blast radius unless `confirm` is sent, so
   * the caller must have obtained a real confirmation (the Danger Zone modal's typed
   * project name) before passing it. The flag is a relay of that decision, never a
   * default: omit it and the request is a safe no-op that reports what would be lost.
   */
  async remove(
    id: string,
    options?: { confirm?: boolean },
    config?: AxiosRequestConfig
  ): Promise<void> {
    const query = options?.confirm === true ? '?confirm=true' : '';
    const body = await http.del<ApiEnvelope<unknown>>(
      `/projects/${encodeURIComponent(id)}${query}`,
      config
    );
    unwrapData(body, 'Failed to delete project');
  },

  /** GET /api/projects/stats */
  async stats(config?: AxiosRequestConfig): Promise<ProjectStats> {
    const body = await http.get<ApiEnvelope<{ stats?: ProjectStats }>>('/projects/stats', config);
    return (unwrapData(body, 'Failed to fetch project stats')?.stats ?? {}) as ProjectStats;
  },

  /** GET /api/projects/:id/insights */
  async insights(id: string, config?: AxiosRequestConfig): Promise<Record<string, unknown>> {
    const body = await http.get<ApiEnvelope<Record<string, unknown>>>(
      `/projects/${encodeURIComponent(id)}/insights`,
      config
    );
    return (unwrapData(body, 'Failed to fetch project insights') ?? {}) as Record<string, unknown>;
  },

  /** GET /api/projects/:id/sessions */
  async sessions(id: string, config?: AxiosRequestConfig): Promise<unknown[]> {
    const body = await http.get<ApiEnvelope<{ sessions?: unknown[] }>>(
      `/projects/${encodeURIComponent(id)}/sessions`,
      config
    );
    return unwrapData(body, 'Failed to fetch project sessions')?.sessions ?? [];
  },

  /** GET /api/projects/sessions/all — sessions across every project (dashboard). */
  async allSessions(
    params?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<unknown[]> {
    const body = await http.get<ApiEnvelope<{ sessions?: unknown[] }>>(
      '/projects/sessions/all',
      withParams(config, params ?? {})
    );
    return unwrapData(body, 'Failed to fetch all sessions')?.sessions ?? [];
  },

  /** POST /api/projects/:id/set-primary */
  async setPrimary(id: string, config?: AxiosRequestConfig): Promise<void> {
    await http.post<ApiEnvelope<unknown>>(
      `/projects/${encodeURIComponent(id)}/set-primary`,
      undefined,
      config
    );
  },

  /** POST /api/projects/clear-primary */
  async clearPrimary(config?: AxiosRequestConfig): Promise<void> {
    await http.post<ApiEnvelope<unknown>>('/projects/clear-primary', undefined, config);
  },
};

export type ProjectsApi = typeof projectsApi;
