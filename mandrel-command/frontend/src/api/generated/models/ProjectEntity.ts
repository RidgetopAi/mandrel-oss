/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseEntity } from './BaseEntity';
export type ProjectEntity = (BaseEntity & {
    /**
     * Project name
     */
    name: string;
    /**
     * Project description
     */
    description?: string;
    /**
     * Project status
     */
    status: 'active' | 'inactive' | 'archived';
    /**
     * Git repository URL
     */
    git_repo_url?: string;
    /**
     * Project root directory path
     */
    root_directory?: string;
    /**
     * Additional project metadata
     */
    metadata?: Record<string, any>;
    /**
     * Number of contexts associated with the project
     */
    context_count?: number;
    /**
     * Number of sessions associated with the project
     */
    session_count?: number;
    /**
     * Timestamp of the last recorded activity
     */
    last_activity?: string;
});

