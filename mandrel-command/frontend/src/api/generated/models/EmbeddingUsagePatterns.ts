/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type EmbeddingUsagePatterns = {
    dailyActivity: Array<{
        date: string;
        contexts: number;
    }>;
    contextsByType: Array<{
        type: string;
        count: number;
        percentage: number;
    }>;
    topTags: Array<{
        tag: string;
        count: number;
    }>;
    hourlyDistribution: Array<{
        hour: number;
        contexts: number;
    }>;
    summary: {
        contextsLast7Days: number;
        contextsLast30Days: number;
        uniqueTags: number;
        totalContexts: number;
        lastContextAt?: string | null;
    };
};

