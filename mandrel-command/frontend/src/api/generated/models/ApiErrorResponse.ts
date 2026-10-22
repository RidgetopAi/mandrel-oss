/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ApiErrorResponse = {
    success: boolean;
    error: {
        /**
         * Error type for client handling
         */
        type: 'validation' | 'authentication' | 'authorization' | 'not_found' | 'internal' | 'business';
        /**
         * Human-readable error message
         */
        message: string;
        /**
         * Additional error details (e.g., validation errors)
         */
        details?: Record<string, any>;
        /**
         * Machine-readable error code
         */
        code?: string;
    };
    correlationId?: string;
};

