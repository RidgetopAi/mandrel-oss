/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseEntity } from './BaseEntity';
export type ContextEntity = (BaseEntity & {
    /**
     * Context body content
     */
    content: string;
    /**
     * Context classification
     */
    type: 'code' | 'decision' | 'research' | 'issue' | 'note' | 'error' | 'test';
    /**
     * Associated tags
     */
    tags?: Array<string>;
    /**
     * Arbitrary metadata payload
     */
    metadata?: Record<string, any>;
    /**
     * Linked session identifier
     */
    session_id?: string;
    /**
     * Associated project identifier
     */
    project_id?: string;
    /**
     * Semantic similarity score when applicable
     */
    relevance_score?: number;
});

