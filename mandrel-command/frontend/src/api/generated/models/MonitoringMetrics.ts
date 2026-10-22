/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type MonitoringMetrics = {
    timestamp: number;
    system: {
        uptime?: number;
        memory?: {
            used?: number;
            free?: number;
            total?: number;
            percentage?: number;
        };
        cpu?: {
            usage?: number;
        };
        process?: {
            pid?: number;
            uptime?: number;
            memoryUsage?: {
                rss?: number;
                heapUsed?: number;
                heapTotal?: number;
                external?: number;
            };
        };
    };
    database: {
        status?: 'healthy' | 'degraded' | 'unhealthy';
        responseTime?: number;
        activeConnections?: number;
    };
    api: {
        requestCount?: number;
        errorRate?: number;
        averageResponseTime?: number;
    };
};

