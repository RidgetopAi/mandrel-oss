/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CreateDecisionRequest = {
    title: string;
    problem: string;
    decision: string;
    rationale?: string;
    alternatives?: Array<string>;
    status?: 'active' | 'under_review' | 'superseded' | 'deprecated';
    tags?: Array<string>;
};

