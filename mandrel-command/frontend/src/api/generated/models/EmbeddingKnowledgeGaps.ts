/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EmbeddingKnowledgeGapMissingTag } from './EmbeddingKnowledgeGapMissingTag';
import type { EmbeddingKnowledgeGapStaleTag } from './EmbeddingKnowledgeGapStaleTag';
import type { EmbeddingKnowledgeGapSummary } from './EmbeddingKnowledgeGapSummary';
import type { EmbeddingKnowledgeGapTypeInsight } from './EmbeddingKnowledgeGapTypeInsight';
export type EmbeddingKnowledgeGaps = {
    missingTags: Array<EmbeddingKnowledgeGapMissingTag>;
    staleTags: Array<EmbeddingKnowledgeGapStaleTag>;
    underrepresentedTypes: Array<EmbeddingKnowledgeGapTypeInsight>;
    summary: EmbeddingKnowledgeGapSummary;
};

