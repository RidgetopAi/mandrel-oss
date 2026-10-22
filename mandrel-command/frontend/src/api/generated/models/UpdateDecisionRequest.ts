/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UpdateDecisionRequest = {
    title?: string;
    problem?: string;
    decision?: string;
    rationale?: string;
    alternatives?: Array<string>;
    status?: 'active' | 'under_review' | 'superseded' | 'deprecated';
    outcomeStatus?: 'unknown' | 'successful' | 'failed' | 'mixed' | 'too_early';
    outcomeNotes?: string;
    lessonsLearned?: string;
    supersededReason?: string;
    tags?: Array<string>;
};

