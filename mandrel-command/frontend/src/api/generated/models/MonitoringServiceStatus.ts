/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type MonitoringServiceStatus = {
    name: string;
    port: number;
    status: 'healthy' | 'degraded' | 'down';
    responseTime: number;
    lastCheck: string;
    url: string;
    slaTarget: number;
    uptime?: number;
    error?: string;
};

