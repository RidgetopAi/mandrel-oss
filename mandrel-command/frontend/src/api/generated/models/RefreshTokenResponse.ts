/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RefreshTokenResponse = {
    success?: boolean;
    message?: string;
    data?: {
        /**
         * New JWT token
         */
        token?: string;
        /**
         * New token expiration timestamp
         */
        expires_at?: string;
    };
};

