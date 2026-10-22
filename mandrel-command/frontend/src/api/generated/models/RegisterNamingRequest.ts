/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RegisterNamingRequest = {
    name: string;
    type: 'variable' | 'function' | 'component' | 'class' | 'interface' | 'module' | 'file';
    context?: string;
    project_id?: string;
};

