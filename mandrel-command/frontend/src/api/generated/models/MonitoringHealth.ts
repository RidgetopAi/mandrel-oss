/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type MonitoringHealth = {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: number;
    checks: Record<string, {
        status: 'healthy' | 'degraded' | 'unhealthy';
        message: string;
        responseTime?: number;
    }>;
    summary?: {
        totalChecks?: number;
        healthyChecks?: number;
    };
};

