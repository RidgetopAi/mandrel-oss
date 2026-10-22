/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type MonitoringTrends = {
    timestamp: number;
    windowMinutes: number;
    trends: {
        responseTime?: Array<number>;
        errorRate?: number;
        requestVolume?: number;
    };
};

