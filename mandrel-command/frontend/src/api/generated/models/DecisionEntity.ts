/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseEntity } from './BaseEntity';
export type DecisionEntity = (BaseEntity & {
    title: string;
    problem: string;
    decision: string;
    rationale?: string;
    alternatives?: Array<string>;
    status: 'active' | 'under_review' | 'superseded' | 'deprecated';
    /**
     * Lifecycle outcome assessment
     */
    outcomeStatus?: 'unknown' | 'successful' | 'failed' | 'mixed' | 'too_early';
    outcomeNotes?: string;
    lessonsLearned?: string;
    supersededBy?: string;
    supersededReason?: string;
    outcome?: string;
    lessons?: string;
    tags?: Array<string>;
    project_id?: string;
    project_name?: string;
    created_by?: string;
    updated_by?: string;
});

