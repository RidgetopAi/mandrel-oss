/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ContextBulkUpdate = {
    /**
     * Context IDs to update
     */
    ids: Array<string>;
    /**
     * Fields to apply to every matched context (at least one required)
     */
    updates: {
        /**
         * Reassign contexts to this project
         */
        project_id?: string;
        /**
         * Replacement tag list (max 10 tags)
         */
        tags?: Array<string>;
        /**
         * Updated relevance score
         */
        relevance_score?: number;
    };
};

