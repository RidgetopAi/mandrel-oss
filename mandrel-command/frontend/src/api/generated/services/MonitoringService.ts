/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiSuccessResponse } from '../models/ApiSuccessResponse';
import type { MonitoringAlert } from '../models/MonitoringAlert';
import type { MonitoringHealth } from '../models/MonitoringHealth';
import type { MonitoringMetrics } from '../models/MonitoringMetrics';
import type { MonitoringServiceStatus } from '../models/MonitoringServiceStatus';
import type { MonitoringStats } from '../models/MonitoringStats';
import type { MonitoringTrends } from '../models/MonitoringTrends';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class MonitoringService {
    /**
     * THROWAWAY FIXTURE — proves STAGE 5o catches undocumented drift
     * @returns any pong
     * @throws ApiError
     */
    public static getMonitoringDriftFixturePing(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/drift-fixture-ping',
        });
    }
    /**
     * Retrieve system health snapshot
     * @returns any Health payload returned
     * @throws ApiError
     */
    public static getMonitoringHealth(): CancelablePromise<(ApiSuccessResponse & {
        data?: MonitoringHealth;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/health',
        });
    }
    /**
     * Retrieve system metrics snapshot
     * @returns any Metrics payload returned
     * @throws ApiError
     */
    public static getMonitoringMetrics(): CancelablePromise<(ApiSuccessResponse & {
        data?: MonitoringMetrics;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/metrics',
        });
    }
    /**
     * Retrieve performance trends
     * @returns any Trend data returned
     * @throws ApiError
     */
    public static getMonitoringTrends({
        minutes = 5,
    }: {
        /**
         * Size of the sliding window (in minutes)
         */
        minutes?: number,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: MonitoringTrends;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/trends',
            query: {
                'minutes': minutes,
            },
        });
    }
    /**
     * Record UI error event
     * @returns any Error captured
     * @throws ApiError
     */
    public static postMonitoringErrors({
        requestBody,
    }: {
        requestBody: Record<string, any>,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/monitoring/errors',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Retrieve status for all monitored services
     * @returns any Service status list
     * @throws ApiError
     */
    public static getMonitoringServices(): CancelablePromise<(ApiSuccessResponse & {
        data?: Array<MonitoringServiceStatus>;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/services',
        });
    }
    /**
     * Retrieve status for a specific service
     * @returns any Service health returned
     * @throws ApiError
     */
    public static getMonitoringServices1({
        serviceName,
    }: {
        serviceName: string,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: MonitoringServiceStatus;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/services/{serviceName}',
            path: {
                'serviceName': serviceName,
            },
            errors: {
                404: `Service not found`,
            },
        });
    }
    /**
     * Retrieve monitoring statistics and SLA compliance
     * @returns any Monitoring statistics returned
     * @throws ApiError
     */
    public static getMonitoringStats(): CancelablePromise<(ApiSuccessResponse & {
        data?: MonitoringStats;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/stats',
        });
    }
    /**
     * Retrieve recent monitoring alerts
     * @returns any Alerts returned
     * @throws ApiError
     */
    public static getMonitoringAlerts({
        limit = 50,
    }: {
        limit?: number,
    }): CancelablePromise<(ApiSuccessResponse & {
        data?: Array<MonitoringAlert>;
    })> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/monitoring/alerts',
            query: {
                'limit': limit,
            },
        });
    }
}
