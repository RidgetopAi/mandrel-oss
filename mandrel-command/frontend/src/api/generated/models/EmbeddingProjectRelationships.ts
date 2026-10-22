/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EmbeddingProjectEdge } from './EmbeddingProjectEdge';
import type { EmbeddingProjectNode } from './EmbeddingProjectNode';
import type { EmbeddingProjectSummary } from './EmbeddingProjectSummary';
export type EmbeddingProjectRelationships = {
    focusProject: EmbeddingProjectNode;
    relatedProjects: Array<EmbeddingProjectNode>;
    edges: Array<EmbeddingProjectEdge>;
    summary: EmbeddingProjectSummary;
};

