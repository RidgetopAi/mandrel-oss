/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiSuccessResponse } from '../models/ApiSuccessResponse';
import type { CreateProjectRequest } from '../models/CreateProjectRequest';
import type { ProjectDetailResponse } from '../models/ProjectDetailResponse';
import type { ProjectListResponse } from '../models/ProjectListResponse';
import type { ProjectSessionsResponse } from '../models/ProjectSessionsResponse';
import type { ProjectStats } from '../models/ProjectStats';
import type { UpdateProjectRequest } from '../models/UpdateProjectRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class ProjectsService {
    /**
     * Get projects with root_directory for mandrel-watcher
     * Returns projects that have a local path configured. Used by the mandrel-watcher daemon, which must authenticate: the response carries project names and absolute host filesystem paths.
     *
     * @returns any Watchable projects retrieved successfully
     * @throws ApiError
     */
    public static getProjectsWatchable(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/projects/watchable',
            errors: {
                401: `Authentication required`,
            },
        });
    }
    /**
     * Get all projects
     * @returns any Projects retrieved successfully
     * @throws ApiError
     */
    public static getProjects({
        page = 1,
        limit = 20,
        sortBy,
        sortOrder = 'asc',
    }: {
        /**
         * Page number
         */
        page?: number,
        /**
         * Items per page
         */
        limit?: number,
        /**
         * Field to sort by
         */
        sortBy?: string,
        /**
         * Sort order
         */
        sortOrder?: 'asc' | 'desc',
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ProjectListResponse;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/projects',
            query: {
                'page': page,
                'limit': limit,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
            },
            errors: {
                400: `Invalid query parameters`,
            },
        });
    }
    /**
     * Create a new project
     * @returns any Project created successfully
     * @throws ApiError
     */
    public static postProjects({
        requestBody,
    }: {
        requestBody: CreateProjectRequest,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ProjectDetailResponse;
    })> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/projects',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid project data`,
            },
        });
    }
    /**
     * Get project statistics
     * @returns any Project statistics retrieved successfully
     * @throws ApiError
     */
    public static getProjectsStats(): CancelablePromise<(ApiSuccessResponse & {
        data?: ProjectStats;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/projects/stats',
        });
    }
    /**
     * Get all sessions across projects
     * @returns any Sessions retrieved successfully
     * @throws ApiError
     */
    public static getProjectsSessionsAll({
        projectId,
        limit,
    }: {
        /**
         * Filter sessions to a single project (UUID). Ignored if not a valid UUID.
         */
        projectId?: string,
        /**
         * Maximum number of sessions to return (most recent first).
         */
        limit?: number,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ProjectSessionsResponse;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/projects/sessions/all',
            query: {
                'project_id': projectId,
                'limit': limit,
            },
        });
    }
    /**
     * Set project as primary/default
     * @returns ApiSuccessResponse Project set as primary successfully
     * @throws ApiError
     */
    public static postProjectsSetPrimary({
        id,
    }: {
        /**
         * Project ID
         */
        id: string,
    }): CancelablePromise<ApiSuccessResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/projects/{id}/set-primary',
            path: {
                'id': id,
            },
            errors: {
                404: `Project not found`,
            },
        });
    }
    /**
     * Clear the primary/default flag from all projects
     * @returns ApiSuccessResponse Primary flag cleared successfully
     * @throws ApiError
     */
    public static postProjectsClearPrimary(): CancelablePromise<ApiSuccessResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/projects/clear-primary',
        });
    }
    /**
     * Get project by ID
     * @returns any Project retrieved successfully
     * @throws ApiError
     */
    public static getProjects1({
        id,
    }: {
        /**
         * Project ID
         */
        id: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ProjectDetailResponse;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/projects/{id}',
            path: {
                'id': id,
            },
            errors: {
                404: `Project not found`,
            },
        });
    }
    /**
     * Update project
     * @returns any Project updated successfully
     * @throws ApiError
     */
    public static putProjects({
        id,
        requestBody,
    }: {
        /**
         * Project ID
         */
        id: string,
        requestBody: UpdateProjectRequest,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ProjectDetailResponse;
    })> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/projects/{id}',
            path: {
                'id': id,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid project data`,
                404: `Project not found`,
            },
        });
    }
    /**
     * Delete project (irreversible — cascades into every project-owned table)
     * Gated by the mcp-server `project_delete` safety survey. Without `confirm=true` a project with owned rows — or one whose blast radius cannot be measured — is REFUSED with 409 and the impact counts, and nothing is destroyed.
     *
     * @returns any Project deleted successfully
     * @throws ApiError
     */
    public static deleteProjects({
        id,
        confirm,
    }: {
        /**
         * Project ID
         */
        id: string,
        /**
         * Explicit confirmation. Only the exact string `true` confirms; anything else (absent, `false`, empty) leaves the delete gated.
         *
         */
        confirm?: 'true',
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ProjectSessionsResponse;
    })> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/projects/{id}',
            path: {
                'id': id,
            },
            query: {
                'confirm': confirm,
            },
            errors: {
                404: `Project not found`,
                409: `Refused — confirmation required. Nothing was deleted. \`error\` carries the gate's blast-radius sentence; \`data.impact\` carries the measured counts (\`byTable\`, \`total\`, \`unmeasurable\`) and \`data.requiresConfirmation\` is true.
                `,
            },
        });
    }
    /**
     * Get project insights
     * @returns ApiSuccessResponse Project insights retrieved successfully
     * @throws ApiError
     */
    public static getProjectsInsights({
        id,
    }: {
        /**
         * Project ID
         */
        id: string,
    }): CancelablePromise<ApiSuccessResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/projects/{id}/insights',
            path: {
                'id': id,
            },
        });
    }
    /**
     * Get project sessions
     * @returns ApiSuccessResponse Project sessions retrieved successfully
     * @throws ApiError
     */
    public static getProjectsSessions({
        id,
    }: {
        /**
         * Project ID
         */
        id: string,
    }): CancelablePromise<ApiSuccessResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/projects/{id}/sessions',
            path: {
                'id': id,
            },
        });
    }
}
