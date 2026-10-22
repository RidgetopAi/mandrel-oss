/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type MonitoringAlertRule = {
    id: string;
    service: string;
    metric: string;
    threshold: number;
    operator: 'gt' | 'lt' | 'eq';
    severity: 'critical' | 'warning' | 'info';
    enabled: boolean;
    cooldown: number;
    lastTriggered?: string;
};

