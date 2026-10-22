/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RegisterRequest = {
    /**
     * Unique username
     */
    username: string;
    /**
     * User email address
     */
    email: string;
    /**
     * Password (minimum 6 characters)
     */
    password: string;
    /**
     * User role
     */
    role?: 'admin' | 'user';
};

