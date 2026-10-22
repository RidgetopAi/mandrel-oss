/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type EmbeddingQualityMetrics = {
    totalEmbeddings: number;
    averageNorm: number;
    dimensionality: number;
    densityMetrics: {
        avgDistance: number;
        minDistance: number;
        maxDistance: number;
        stdDistance: number;
    };
    distributionStats: {
        mean: Array<number>;
        std: Array<number>;
        min: Array<number>;
        max: Array<number>;
    };
};

