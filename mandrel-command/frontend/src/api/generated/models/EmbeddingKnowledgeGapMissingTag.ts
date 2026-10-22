/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type EmbeddingKnowledgeGapMissingTag = {
    tag: string;
    totalCount: number;
    projectCount: number;
    lastUsed?: string;
    topProjects: Array<{
        projectId?: string | null;
        projectName: string;
        count: number;
    }>;
};

