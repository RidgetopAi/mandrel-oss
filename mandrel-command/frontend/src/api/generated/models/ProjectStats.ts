/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ProjectStats = {
    total_projects?: number;
    active_projects?: number;
    total_contexts?: number;
    total_sessions?: number;
    contexts_by_type?: Record<string, number>;
    recent_activity?: {
        contexts_last_week?: number;
        sessions_last_week?: number;
    };
};

