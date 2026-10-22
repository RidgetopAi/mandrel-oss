/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { MonitoringServiceStatus } from './MonitoringServiceStatus';
export type MonitoringServicesHealth = {
    timestamp: string;
    services: Array<MonitoringServiceStatus>;
    summary: {
        total: number;
        healthy: number;
        degraded: number;
        down: number;
    };
};

