/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiSuccessResponse } from '../models/ApiSuccessResponse';
import type { ContextBulkDelete } from '../models/ContextBulkDelete';
import type { ContextBulkUpdate } from '../models/ContextBulkUpdate';
import type { ContextEntity } from '../models/ContextEntity';
import type { ContextSearchResponse } from '../models/ContextSearchResponse';
import type { ContextStats } from '../models/ContextStats';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class ContextsService {
    /**
     * Search contexts with filters
     * @returns any Contexts retrieved successfully
     * @throws ApiError
     */
    public static getContexts({
        query,
        projectId,
        sessionId,
        type,
        tags,
        limit = 20,
        offset,
    }: {
        /**
         * Free-text search query
         */
        query?: string,
        /**
         * Filter by project ID (falls back to X-Project-ID header)
         */
        projectId?: string,
        sessionId?: string,
        type?: 'code' | 'decision' | 'research' | 'issue' | 'note' | 'error' | 'test',
        /**
         * Comma-separated tags filter
         */
        tags?: string,
        limit?: number,
        offset?: number,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ContextSearchResponse;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/contexts',
            query: {
                'query': query,
                'project_id': projectId,
                'session_id': sessionId,
                'type': type,
                'tags': tags,
                'limit': limit,
                'offset': offset,
            },
        });
    }
    /**
     * Create a new context
     * @returns any Context created successfully
     * @throws ApiError
     */
    public static postContexts({
        requestBody,
    }: {
        requestBody: {
            /**
             * The context content
             */
            content: string;
            type?: 'code' | 'decision' | 'error' | 'discussion' | 'planning' | 'completion' | 'milestone' | 'reflections' | 'handoff' | 'lessons' | 'note';
            tags?: Array<string>;
            metadata?: Record<string, any>;
            projectId?: string;
        },
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/contexts',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request body`,
                500: `Server error`,
            },
        });
    }
    /**
     * Retrieve context statistics for the current project
     * @returns any Statistics returned
     * @throws ApiError
     */
    public static getContextsStats(): CancelablePromise<(ApiSuccessResponse & {
        data?: ContextStats;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/contexts/stats',
        });
    }
    /**
     * Get a context by ID
     * @returns any Context retrieved
     * @throws ApiError
     */
    public static getContexts1({
        id,
    }: {
        id: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ContextEntity;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/contexts/{id}',
            path: {
                'id': id,
            },
            errors: {
                404: `Context not found`,
            },
        });
    }
    /**
     * Update an existing context
     * @returns any Context updated
     * @throws ApiError
     */
    public static putContexts({
        id,
        requestBody,
    }: {
        id: string,
        requestBody: Record<string, any>,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: ContextEntity;
    })> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/contexts/{id}',
            path: {
                'id': id,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                404: `Context not found`,
            },
        });
    }
    /**
     * Delete a context
     * @returns any Context deleted successfully
     * @throws ApiError
     */
    public static deleteContexts({
        id,
    }: {
        id: string,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/contexts/{id}',
            path: {
                'id': id,
            },
            errors: {
                404: `Context not found`,
            },
        });
    }
    /**
     * Restore (un-archive) a soft-deleted context
     * @returns any Context restored successfully
     * @throws ApiError
     */
    public static postContextsRestore({
        id,
    }: {
        id: string,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/contexts/{id}/restore',
            path: {
                'id': id,
            },
            errors: {
                404: `Context not found`,
            },
        });
    }
    /**
     * Bulk delete contexts by ID
     * @returns any Contexts deleted successfully
     * @throws ApiError
     */
    public static deleteContextsBulkDelete({
        requestBody,
    }: {
        requestBody: ContextBulkDelete,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/contexts/bulk/delete',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Bulk update contexts by ID
     * @returns any Contexts updated successfully
     * @throws ApiError
     */
    public static postContextsBulkUpdate({
        requestBody,
    }: {
        requestBody: ContextBulkUpdate,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/contexts/bulk/update',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Get contexts related to the supplied context
     * @returns any Related contexts returned
     * @throws ApiError
     */
    public static getContextsRelated({
        id,
    }: {
        id: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: Array<ContextEntity>;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/contexts/{id}/related',
            path: {
                'id': id,
            },
        });
    }
    /**
     * Get the typed graph edges (thread) touching a context
     * @returns any Typed edges returned (both directions), resolved to each target's title/kind
     * @throws ApiError
     */
    public static getContextsLinks({
        id,
    }: {
        id: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: Array<{
            edgeType?: string;
            direction?: 'outgoing' | 'incoming';
            otherId?: string;
            otherType?: 'context' | 'decision' | 'task';
            otherTitle?: string;
            otherKind?: string;
        }>;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/contexts/{id}/links',
            path: {
                'id': id,
            },
        });
    }
}
