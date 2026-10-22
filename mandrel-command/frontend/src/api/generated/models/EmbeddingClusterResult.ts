/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EmbeddingClusterPoint } from './EmbeddingClusterPoint';
export type EmbeddingClusterResult = {
    points: Array<EmbeddingClusterPoint>;
    centroids: Array<{
        'x': number;
        'y': number;
        cluster: number;
    }>;
    'k': number;
    inertia: number;
};

