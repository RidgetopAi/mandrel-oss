/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { User } from './User';
export type LoginResponse = {
    user: User;
    /**
     * JWT authentication token
     */
    token: string;
    /**
     * Token expiration timestamp
     */
    expires: string;
};

