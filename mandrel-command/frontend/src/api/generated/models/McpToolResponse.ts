/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type McpToolResponse = {
    /**
     * Whether the tool call succeeded
     */
    success: boolean;
    /**
     * Tool execution result
     */
    result?: Record<string, any>;
    /**
     * Error message if call failed
     */
    error?: string;
};

