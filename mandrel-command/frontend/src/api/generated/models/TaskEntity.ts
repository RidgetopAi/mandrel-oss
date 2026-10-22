/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseEntity } from './BaseEntity';
export type TaskEntity = (BaseEntity & {
    /**
     * Associated project ID
     */
    project_id: string;
    /**
     * Task title
     */
    title: string;
    /**
     * Task description
     */
    description?: string;
    /**
     * Task type
     */
    type: 'general' | 'feature' | 'bug' | 'refactor' | 'test' | 'docs' | 'devops';
    /**
     * Task status
     */
    status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
    /**
     * The Punch List lane (migration 101). SOURCE OF TRUTH over `status`, which is derived from it automatically. Null on a cancelled task or a legacy row.
     */
    stage?: 'draft' | 'ready' | 'claimed' | 'verifying' | 'evidence' | 'merged' | 'deployed' | null;
    /**
     * Task priority
     */
    priority: 'low' | 'medium' | 'high' | 'urgent';
    /**
     * Assignee
     */
    assigned_to?: string;
    /**
     * Task tags
     */
    tags?: Array<string>;
    /**
     * Task due date
     */
    due_date?: string;
    /**
     * Estimated hours to complete
     */
    estimated_hours?: number;
    /**
     * Actual hours spent
     */
    actual_hours?: number;
});

