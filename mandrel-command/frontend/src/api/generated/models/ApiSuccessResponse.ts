/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ApiSuccessResponse = {
    success: boolean;
    /**
     * Response data payload
     */
    data: Record<string, any>;
    /**
     * Request correlation ID for tracking
     */
    correlationId?: string;
    metadata?: {
        timestamp?: string;
        version?: string;
    };
};

