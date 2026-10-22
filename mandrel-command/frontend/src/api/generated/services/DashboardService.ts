/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class DashboardService {
    /**
     * Get dashboard statistics
     * Returns aggregated statistics for the dashboard including contexts, tasks, and projects
     * @returns any Dashboard statistics retrieved successfully
     * @throws ApiError
     */
    public static getDashboardStats(): CancelablePromise<{
        success?: boolean;
        data?: {
            /**
             * Total number of contexts
             */
            contexts?: number;
            /**
             * Number of active tasks
             */
            activeTasks?: number;
            /**
             * Total number of tasks
             */
            totalTasks?: number;
            /**
             * Total number of projects
             */
            projects?: number;
            recentActivity?: {
                /**
                 * Number of contexts created this week
                 */
                contextsThisWeek?: number;
                /**
                 * Number of tasks completed this week
                 */
                tasksCompletedThisWeek?: number;
            };
        };
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/dashboard/stats',
            errors: {
                401: `Unauthorized`,
                500: `Internal server error`,
            },
        });
    }
}
