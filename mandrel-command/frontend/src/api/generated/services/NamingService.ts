/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiSuccessResponse } from '../models/ApiSuccessResponse';
import type { NamingAvailabilityResponse } from '../models/NamingAvailabilityResponse';
import type { NamingEntry } from '../models/NamingEntry';
import type { NamingSearchResponse } from '../models/NamingSearchResponse';
import type { NamingStats } from '../models/NamingStats';
import type { NamingSuggestion } from '../models/NamingSuggestion';
import type { RegisterNamingRequest } from '../models/RegisterNamingRequest';
import type { UpdateNamingRequest } from '../models/UpdateNamingRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class NamingService {
    /**
     * Search naming registry entries
     * @returns any Entries retrieved
     * @throws ApiError
     */
    public static getNaming({
        query,
        type,
        status,
        projectId,
        createdBy,
        dateFrom,
        dateTo,
        limit = 20,
        offset,
    }: {
        query?: string,
        type?: 'variable' | 'function' | 'component' | 'class' | 'interface' | 'module' | 'file',
        status?: 'active' | 'deprecated' | 'conflicted' | 'pending',
        projectId?: string,
        createdBy?: string,
        dateFrom?: string,
        dateTo?: string,
        limit?: number,
        offset?: number,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: NamingSearchResponse;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/naming',
            query: {
                'query': query,
                'type': type,
                'status': status,
                'project_id': projectId,
                'created_by': createdBy,
                'date_from': dateFrom,
                'date_to': dateTo,
                'limit': limit,
                'offset': offset,
            },
        });
    }
    /**
     * Retrieve naming registry statistics
     * @returns any Statistics returned
     * @throws ApiError
     */
    public static getNamingStats({
        projectId,
    }: {
        projectId?: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: NamingStats;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/naming/stats',
            query: {
                'project_id': projectId,
            },
        });
    }
    /**
     * Check naming entry availability
     * @returns any Availability result
     * @throws ApiError
     */
    public static getNamingCheck({
        name,
        type,
    }: {
        name: string,
        /**
         * Optional type hint for the suggestion engine
         */
        type?: 'variable' | 'function' | 'component' | 'class' | 'interface' | 'module' | 'file',
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: NamingAvailabilityResponse;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/naming/check/{name}',
            path: {
                'name': name,
            },
            query: {
                'type': type,
            },
        });
    }
    /**
     * Provide naming suggestions
     * @returns any Suggestions returned
     * @throws ApiError
     */
    public static getNamingSuggest({
        name,
    }: {
        name: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: Array<NamingSuggestion>;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/naming/suggest/{name}',
            path: {
                'name': name,
            },
        });
    }
    /**
     * Register a new naming entry
     * @returns any Naming entry registered
     * @throws ApiError
     */
    public static postNamingRegister({
        requestBody,
    }: {
        requestBody: RegisterNamingRequest,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: NamingEntry;
    })> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/naming/register',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Get naming entry by ID
     * @returns any Entry retrieved
     * @throws ApiError
     */
    public static getNaming1({
        id,
    }: {
        id: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: NamingEntry;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/naming/{id}',
            path: {
                'id': id,
            },
        });
    }
    /**
     * Update naming entry
     * @returns any Entry updated
     * @throws ApiError
     */
    public static putNaming({
        id,
        requestBody,
    }: {
        id: string,
        requestBody: UpdateNamingRequest,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/naming/{id}',
            path: {
                'id': id,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Delete naming entry
     * @returns any Entry deleted
     * @throws ApiError
     */
    public static deleteNaming({
        id,
    }: {
        id: string,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/naming/{id}',
            path: {
                'id': id,
            },
        });
    }
}
