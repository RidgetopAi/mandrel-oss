/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseEntity } from './BaseEntity';
export type NamingEntry = (BaseEntity & {
    name: string;
    type: 'variable' | 'function' | 'component' | 'class' | 'interface' | 'module' | 'file';
    context?: string;
    project_id?: string;
    project_name?: string;
    status: 'active' | 'deprecated' | 'conflicted' | 'pending';
    compliance_score: number;
    usage_count: number;
    created_by?: string;
    updated_by?: string;
});

