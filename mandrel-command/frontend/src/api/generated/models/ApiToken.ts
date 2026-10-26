/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ApiToken = {
    id: string;
    name: string;
    /**
     * Non-secret display prefix, e.g. mdl_AbCd1234
     */
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
};

