/**
 * TR005-6: Generated Type Definitions
 * Auto-generated TypeScript types for end-to-end type safety
 * Generated: 2025-09-21T18:55:00.000Z
 *
 * DO NOT EDIT MANUALLY - This file is auto-generated
 */

import { z } from 'zod';
import React from 'react';

// Schema imports for type inference
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  CreateContextSchema,
  UpdateSessionSchema,
  CreateDecisionSchema,
  RegisterNamingSchema
} from '../validation/schemas';

// TR005-6: Standardized API Response Types

export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  correlationId?: string;
  metadata?: {
    timestamp: string;
    version?: string;
    [key: string]: any;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    type: 'validation' | 'authentication' | 'authorization' | 'not_found' | 'internal' | 'business';
    message: string;
    details?: any;
    code?: string;
  };
  correlationId?: string;
  metadata?: {
    timestamp: string;
    [key: string]: any;
  };
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

// Pagination types
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginatedResponse<T = any> {
  items: T[];
  pagination: PaginationMeta;
}

// List response types
export interface ListResponse<T = any> {
  items: T[];
  count: number;
  filters?: Record<string, any>;
  sorting?: {
    field: string;
    direction: 'asc' | 'desc';
  };
}

// TR005-6: Database Entity Types

export interface BaseEntity {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectEntity extends BaseEntity {
  name: string;
  description?: string;
  status: 'active' | 'inactive' | 'archived';
  git_repo_url?: string;
  root_directory?: string;
  metadata?: Record<string, any>;
}

export interface TaskEntity extends BaseEntity {
  project_id: string;
  title: string;
  description?: string;
  type: 'general' | 'feature' | 'bug' | 'refactor' | 'test' | 'docs' | 'devops';
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigned_to?: string;
  tags?: string[];
  due_date?: string;
  estimated_hours?: number;
  actual_hours?: number;
}

export interface ContextEntity extends BaseEntity {
  content: string;
  type: 'code' | 'decision' | 'research' | 'issue' | 'note' | 'error' | 'test';
  tags?: string[];
  metadata?: Record<string, any>;
  session_id?: string;
  project_id?: string;
}

export interface SessionEntity extends BaseEntity {
  title?: string;
  description?: string;
  project_id?: string;
  user_agent?: string;
  started_at: string;
  ended_at?: string;
  duration?: number;
  status: 'active' | 'completed' | 'abandoned';
}

export interface DecisionEntity extends BaseEntity {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  tags?: string[];
  project_id?: string;
  session_id?: string;
}

// TR005-6: Validation and Error Types

export interface ValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface ValidationResult<T = any> {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
}

export interface FormFieldError {
  field: string;
  message: string;
  code?: string;
}

export interface FormValidationState<T = any> {
  data: Partial<T>;
  errors: Record<string, string>;
  isValidating: boolean;
  isSubmitting: boolean;
  isValid: boolean;
  hasBeenModified: boolean;
  serverErrors: Record<string, string>;
}

export interface ErrorHandlerState {
  hasError: boolean;
  error: Error | null;
  errorType: 'api' | 'component' | 'network' | 'validation' | 'unknown';
  retryCount: number;
  lastErrorTime: Date | null;
  isRecovering: boolean;
}

// Schema-derived types (using z.infer for accuracy)
export type CreateProjectType = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectType = z.infer<typeof UpdateProjectSchema>;
export type CreateTaskType = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskType = z.infer<typeof UpdateTaskSchema>;
export type CreateContextType = z.infer<typeof CreateContextSchema>;
export type UpdateSessionType = z.infer<typeof UpdateSessionSchema>;
export type CreateDecisionType = z.infer<typeof CreateDecisionSchema>;
export type RegisterNamingType = z.infer<typeof RegisterNamingSchema>;

// Type guards for runtime type checking
export const isApiSuccessResponse = <T = any>(response: any): response is ApiSuccessResponse<T> => {
  return response && typeof response === 'object' && response.success === true;
};

export const isApiErrorResponse = (response: any): response is ApiErrorResponse => {
  return response && typeof response === 'object' && response.success === false;
};

export const isValidationError = (error: any): error is ValidationError => {
  return error && typeof error === 'object' &&
         typeof error.field === 'string' &&
         typeof error.message === 'string';
};

// Utility types for common patterns
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type Required<T, K extends keyof T> = T & { [P in K]-?: T[P] };
export type Nullable<T> = T | null;
export type ID = string;
export type Timestamp = string;

// AIDIS-specific utility types
export type ProjectID = ID;
export type TaskID = ID;
export type SessionID = ID;
export type ContextID = ID;
export type DecisionID = ID;

// Status enums
export const ProjectStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ARCHIVED: 'archived'
} as const;

export const TaskStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled'
} as const;

export const TaskPriority = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent'
} as const;

export const TaskType = {
  GENERAL: 'general',
  FEATURE: 'feature',
  BUG: 'bug',
  REFACTOR: 'refactor',
  TEST: 'test',
  DOCS: 'docs',
  DEVOPS: 'devops'
} as const;

// Frontend-specific type additions
export interface ComponentProps {
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export interface FormProps<T = any> extends ComponentProps {
  initialValues?: Partial<T>;
  onSubmit: (values: T) => Promise<void> | void;
  onCancel?: () => void;
  loading?: boolean;
  disabled?: boolean;
}

export interface TableProps<T = any> extends ComponentProps {
  data: T[];
  columns: Array<{
    key: keyof T;
    title: string;
    render?: (value: any, record: T) => React.ReactNode;
  }>;
  loading?: boolean;
  pagination?: boolean;
}

// Form component types for TR003-6 integration
export interface ValidatedFormConfig<T = any> {
  schema: z.ZodSchema<T>;
  componentName: string;
  enableRealTimeValidation?: boolean;
  debounceMs?: number;
  validateOnChange?: boolean;
  validateOnBlur?: boolean;
  enableServerValidation?: boolean;
  onSubmitSuccess?: (data: T) => void;
  onSubmitError?: (error: any) => void;
  onValidationError?: (errors: FormFieldError[]) => void;
}

export interface ValidatedFormActions<T = any> {
  setFieldValue: (field: keyof T, value: any) => void;
  setFieldsValue: (fields: Partial<T>) => void;
  validateField: (field: keyof T) => Promise<boolean>;
  validateForm: () => Promise<boolean>;
  submitForm: () => Promise<T | undefined>;
  resetForm: () => void;
  clearErrors: () => void;
  clearServerErrors: () => void;
}

// Error boundary types for TR002-6 integration
export interface ErrorBoundaryProps extends ComponentProps {
  componentName: string;
  enableAutoRetry?: boolean;
  maxRetries?: number;
  fallback?: React.ComponentType<any>;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

export interface ErrorFallbackProps {
  error: Error;
  errorType: 'api' | 'network' | 'component' | 'validation' | 'unknown';
  componentName: string;
  onRetry?: () => void;
  onReset?: () => void;
  isRetrying?: boolean;
}

// API client types for TR001-6 integration
export interface ApiClientConfig {
  baseURL: string;
  timeout?: number;
  enableLogging?: boolean;
  enableErrorReporting?: boolean;
}

export interface ApiError extends Error {
  code?: string;
  status?: number;
  requestId?: string;
  details?: any;
}

export interface RequestOptions {
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
}

// AIDIS tool types
export interface AidisToolCall {
  toolName: string;
  arguments: Record<string, any>;
}

export interface AidisToolResponse<T = any> {
  success: boolean;
  result?: T;
  error?: string;
}

// Navigation and routing types
export interface RouteConfig {
  path: string;
  component: React.ComponentType;
  exact?: boolean;
  private?: boolean;
  fallback?: React.ComponentType;
}

export interface NavigationItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  path?: string;
  children?: NavigationItem[];
  permission?: string;
}