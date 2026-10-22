/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EmbeddingClusterResult } from '../models/EmbeddingClusterResult';
import type { EmbeddingDataset } from '../models/EmbeddingDataset';
import type { EmbeddingKnowledgeGaps } from '../models/EmbeddingKnowledgeGaps';
import type { EmbeddingProjection } from '../models/EmbeddingProjection';
import type { EmbeddingProjectRelationships } from '../models/EmbeddingProjectRelationships';
import type { EmbeddingQualityMetrics } from '../models/EmbeddingQualityMetrics';
import type { EmbeddingSimilarityMatrix } from '../models/EmbeddingSimilarityMatrix';
import type { EmbeddingUsagePatterns } from '../models/EmbeddingUsagePatterns';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class EmbeddingsService {
    /**
     * Retrieve available embedding datasets
     * @returns EmbeddingDataset Dataset list returned
     * @throws ApiError
     */
    public static getEmbeddingList({
        xProjectId,
    }: {
        /**
         * Optional project context (UUID), authorized per-caller.
         */
        xProjectId?: string,
    }): CancelablePromise<Array<EmbeddingDataset>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/list',
            headers: {
                'X-Project-ID': xProjectId,
            },
        });
    }
    /**
     * Retrieve similarity matrix for an embedding dataset
     * @returns EmbeddingSimilarityMatrix Similarity matrix returned
     * @throws ApiError
     */
    public static getEmbeddingSimilarity({
        xProjectId,
        id,
        rows = 100,
        cols = 100,
    }: {
        /**
         * Project context (UUID), authorized per-caller.
         */
        xProjectId: string,
        id: string,
        rows?: number,
        cols?: number,
    }): CancelablePromise<EmbeddingSimilarityMatrix> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/similarity',
            headers: {
                'X-Project-ID': xProjectId,
            },
            query: {
                'id': id,
                'rows': rows,
                'cols': cols,
            },
        });
    }
    /**
     * Retrieve 2D/3D projection of embeddings
     * @returns EmbeddingProjection Projection data returned
     * @throws ApiError
     */
    public static getEmbeddingProjection({
        xProjectId,
        id,
        algo = 'pca',
        n = 1000,
    }: {
        /**
         * Project context (UUID), authorized per-caller.
         */
        xProjectId: string,
        id: string,
        algo?: string,
        n?: number,
    }): CancelablePromise<EmbeddingProjection> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/projection',
            headers: {
                'X-Project-ID': xProjectId,
            },
            query: {
                'id': id,
                'algo': algo,
                'n': n,
            },
        });
    }
    /**
     * Retrieve clustering results for an embedding dataset
     * @returns EmbeddingClusterResult Clustering data returned
     * @throws ApiError
     */
    public static getEmbeddingCluster({
        xProjectId,
        id,
        k = 8,
    }: {
        /**
         * Project context (UUID), authorized per-caller.
         */
        xProjectId: string,
        id: string,
        k?: number,
    }): CancelablePromise<EmbeddingClusterResult> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/cluster',
            headers: {
                'X-Project-ID': xProjectId,
            },
            query: {
                'id': id,
                'k': k,
            },
        });
    }
    /**
     * Retrieve embedding quality metrics
     * @returns EmbeddingQualityMetrics Quality metrics returned
     * @throws ApiError
     */
    public static getEmbeddingMetrics({
        xProjectId,
        id,
    }: {
        /**
         * Project context (UUID), authorized per-caller.
         */
        xProjectId: string,
        id: string,
    }): CancelablePromise<EmbeddingQualityMetrics> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/metrics',
            headers: {
                'X-Project-ID': xProjectId,
            },
            query: {
                'id': id,
            },
        });
    }
    /**
     * Retrieve project relationship network for the active project
     * @returns EmbeddingProjectRelationships Project relationship network returned
     * @throws ApiError
     */
    public static getEmbeddingRelationships({
        xProjectId,
    }: {
        /**
         * Project context (UUID), authorized per-caller.
         */
        xProjectId: string,
    }): CancelablePromise<EmbeddingProjectRelationships> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/relationships',
            headers: {
                'X-Project-ID': xProjectId,
            },
        });
    }
    /**
     * Retrieve knowledge gap analytics for the active project
     * @returns EmbeddingKnowledgeGaps Knowledge gap metrics returned
     * @throws ApiError
     */
    public static getEmbeddingKnowledgeGaps({
        xProjectId,
    }: {
        /**
         * Project context (UUID), authorized per-caller.
         */
        xProjectId: string,
    }): CancelablePromise<EmbeddingKnowledgeGaps> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/knowledge-gaps',
            headers: {
                'X-Project-ID': xProjectId,
            },
        });
    }
    /**
     * Retrieve usage pattern analytics for the active project
     * @returns EmbeddingUsagePatterns Usage pattern metrics returned
     * @throws ApiError
     */
    public static getEmbeddingUsage({
        xProjectId,
    }: {
        /**
         * Project context (UUID), authorized per-caller.
         */
        xProjectId: string,
    }): CancelablePromise<EmbeddingUsagePatterns> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/embedding/usage',
            headers: {
                'X-Project-ID': xProjectId,
            },
        });
    }
}
