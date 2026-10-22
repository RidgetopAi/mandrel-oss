/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UpdateProjectRequest = {
    /**
     * Project name
     */
    name?: string;
    /**
     * Project description
     */
    description?: string;
    /**
     * Project status
     */
    status?: 'active' | 'inactive' | 'archived';
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
};

