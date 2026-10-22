/**
 * TR002-5: Enhanced Runtime Schema Validation at MCP Ingress Points
 * Comprehensive validation layer preventing malformed data entry
 */

import { logger } from '../utils/logger.js';
import { isValidUuid } from '../utils/uuid.js';

// Enhanced ingress validation options
export interface IngressValidationOptions {
  enableSanitization?: boolean;
  enableRateLimiting?: boolean;
  enableAuditLogging?: boolean;
  maxRequestSize?: number;
  allowedContentTypes?: string[];
}

// Request validation context
export interface ValidationContext {
  toolName: string;
  requestId: string;
  clientId?: string;
  timestamp: Date;
  source: 'http' | 'stdio' | 'websocket';
}

// Validation result with detailed feedback
export interface ValidationResult {
  success: boolean;
  data?: any;
  errors?: string[];
  warnings?: string[];
  sanitizedFields?: string[];
  blocked?: boolean;
  reason?: string;
}

/**
 * Enhanced MCP Ingress Validation Middleware
 * Provides comprehensive validation at all entry points
 */
export class IngressValidator {
  private static readonly DEFAULT_OPTIONS: IngressValidationOptions = {
    enableSanitization: true,
    enableRateLimiting: false,
    enableAuditLogging: true,
    maxRequestSize: 1024 * 1024, // 1MB
    allowedContentTypes: ['application/json', 'text/plain']
  };

  private static readonly SUSPICIOUS_PATTERNS = [
    /script\s*:/i,
    /javascript\s*:/i,
    /vbscript\s*:/i,
    /data\s*:/i,
    /<script/i,
    /eval\s*\(/i,
    /function\s*\(/i,
    /setTimeout\s*\(/i,
    /setInterval\s*\(/i,
    /document\./i,
    /window\./i,
    /location\./i,
    /\.innerHTML/i,
    /\.outerHTML/i,
  ];

  private static readonly SQL_INJECTION_PATTERNS = [
    /'\s*(or|and)\s*'1'\s*=\s*'1/i,
    /union\s+select/i,
    /drop\s+table/i,
    /truncate\s+table/i,
    /delete\s+from/i,
    /insert\s+into/i,
    /update\s+set/i,
    /--\s/,
    /\/\*.*\*\//
  ];

  /**
   * Validate MCP tool request at ingress point
   */
  static async validateIngressRequest(
    toolName: string,
    args: any,
    context: ValidationContext,
    options: IngressValidationOptions = {}
  ): Promise<ValidationResult> {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };
    const errors: string[] = [];
    const warnings: string[] = [];
    const sanitizedFields: string[] = [];

    try {
      // Request size validation
      const requestSize = JSON.stringify(args || {}).length;
      if (requestSize > opts.maxRequestSize!) {
        return {
          success: false,
          blocked: true,
          reason: 'Request too large',
          errors: [`Request size ${requestSize} bytes exceeds limit ${opts.maxRequestSize} bytes`]
        };
      }

      // Security scanning
      const securityScan = this.scanForSecurityThreats(args, context);
      if (securityScan.blocked) {
        if (opts.enableAuditLogging) {
          logger.warn('Security threat detected in MCP request', {
            toolName,
            requestId: context.requestId,
            clientId: context.clientId,
            threats: securityScan.errors,
            source: context.source
          } as any);
        }
        return securityScan;
      }

      warnings.push(...securityScan.warnings || []);

      // Data sanitization
      let sanitizedArgs = args;
      if (opts.enableSanitization) {
        const sanitizationResult = this.sanitizeInput(args);
        sanitizedArgs = sanitizationResult.data;
        sanitizedFields.push(...sanitizationResult.sanitizedFields);
      }

      // Schema validation using existing validation system
      try {
        // TODO: validateToolArguments function needs to be implemented
        // const validatedArgs = validateToolArguments(toolName, sanitizedArgs);
        const validatedArgs = sanitizedArgs; // Fallback to sanitized args

        // Additional runtime type validation
        const runtimeValidation = this.performRuntimeTypeValidation(toolName, validatedArgs);
        if (!runtimeValidation.success) {
          errors.push(...runtimeValidation.errors!);
        }

        if (errors.length > 0) {
          return {
            success: false,
            errors,
            warnings,
            data: validatedArgs
          };
        }

        // Success with potential warnings
        if (opts.enableAuditLogging && (warnings.length > 0 || sanitizedFields.length > 0)) {
          logger.info('MCP request validated with warnings', {
            toolName,
            requestId: context.requestId,
            warnings,
            sanitizedFields,
            source: context.source
          } as any);
        }

        return {
          success: true,
          data: validatedArgs,
          warnings,
          sanitizedFields
        };

      } catch (validationError) {
        const err = validationError as Error;
        return {
          success: false,
          errors: [`Schema validation failed: ${err.message}`],
          warnings
        };
      }

    } catch (error) {
      const err = error as Error;
      logger.error('Critical error in ingress validation', {
        toolName,
        requestId: context.requestId,
        error: err.message,
        stack: err.stack
      } as any);

      return {
        success: false,
        blocked: true,
        reason: 'Internal validation error',
        errors: ['Internal validation system error']
      };
    }
  }

  /**
   * Scan input for security threats
   */
  private static scanForSecurityThreats(
    input: any,
    _context: ValidationContext
  ): ValidationResult {
    const threats: string[] = [];
    const warnings: string[] = [];

    const scanObject = (obj: any, path: string = ''): void => {
      if (typeof obj === 'string') {
        // Check for XSS patterns
        for (const pattern of this.SUSPICIOUS_PATTERNS) {
          if (pattern.test(obj)) {
            threats.push(`Suspicious pattern in ${path}: ${pattern.source}`);
          }
        }

        // Check for SQL injection patterns
        for (const pattern of this.SQL_INJECTION_PATTERNS) {
          if (pattern.test(obj)) {
            threats.push(`SQL injection pattern in ${path}: ${pattern.source}`);
          }
        }

        // Check for excessive length
        if (obj.length > 100000) {
          warnings.push(`Very long string in ${path}: ${obj.length} characters`);
        }

        // Check for binary data patterns
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(obj)) {
          warnings.push(`Binary/control characters detected in ${path}`);
        }

      } else if (Array.isArray(obj)) {
        if (obj.length > 1000) {
          warnings.push(`Large array in ${path}: ${obj.length} items`);
        }
        obj.forEach((item, index) => scanObject(item, `${path}[${index}]`));

      } else if (typeof obj === 'object' && obj !== null) {
        const keys = Object.keys(obj);
        if (keys.length > 100) {
          warnings.push(`Object with many keys in ${path}: ${keys.length} keys`);
        }
        keys.forEach(key => scanObject(obj[key], path ? `${path}.${key}` : key));
      }
    };

    scanObject(input);

    if (threats.length > 0) {
      return {
        success: false,
        blocked: true,
        reason: 'Security threat detected',
        errors: threats,
        warnings
      };
    }

    return {
      success: true,
      warnings
    };
  }

  /**
   * Sanitize input data
   */
  private static sanitizeInput(input: any): { data: any; sanitizedFields: string[] } {
    const sanitizedFields: string[] = [];

    const sanitizeValue = (value: any, path: string = ''): any => {
      if (typeof value === 'string') {
        let sanitized = value;
        let changed = false;

        // Remove HTML tags
        const htmlCleaned = sanitized.replace(/<[^>]*>/g, '');
        if (htmlCleaned !== sanitized) {
          changed = true;
          sanitized = htmlCleaned;
        }

        // Encode special characters
        const specialCharsCleaned = sanitized
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#x27;');

        if (specialCharsCleaned !== sanitized) {
          changed = true;
          sanitized = specialCharsCleaned;
        }

        // Trim excessive whitespace
        const trimmed = sanitized.trim().replace(/\s+/g, ' ');
        if (trimmed !== sanitized) {
          changed = true;
          sanitized = trimmed;
        }

        if (changed) {
          sanitizedFields.push(path || 'root');
        }

        return sanitized;

      } else if (Array.isArray(value)) {
        return value.map((item, index) =>
          sanitizeValue(item, path ? `${path}[${index}]` : `[${index}]`)
        );

      } else if (typeof value === 'object' && value !== null) {
        const result: any = {};
        Object.keys(value).forEach(key => {
          result[key] = sanitizeValue(value[key], path ? `${path}.${key}` : key);
        });
        return result;

      } else {
        return value;
      }
    };

    return {
      data: sanitizeValue(input),
      sanitizedFields
    };
  }

  /**
   * Perform additional runtime type validation
   */
  private static performRuntimeTypeValidation(
    toolName: string,
    args: any
  ): ValidationResult {
    const errors: string[] = [];

    try {
      // Tool-specific runtime validations
      switch (toolName) {
        case 'context_store':
          if (args.content && typeof args.content === 'string' && args.content.length === 0) {
            errors.push('Content cannot be empty string');
          }
          break;

        case 'project_create':
          if (args.name && args.name.includes('/')) {
            errors.push('Project name cannot contain forward slashes');
          }
          break;

        case 'task_create':
          if (args.title && args.title.toLowerCase() === 'test') {
            errors.push('Task title cannot be just "test"');
          }
          break;

        // Add more tool-specific validations as needed
      }

      // Universal validations
      if (args.projectId && !isValidUuid(args.projectId)) {
        errors.push('Invalid project ID format');
      }

      if (args.sessionId && !isValidUuid(args.sessionId)) {
        errors.push('Invalid session ID format');
      }

      return {
        success: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        errors: [`Runtime validation error: ${err.message}`]
      };
    }
  }

  /**
   * Create validation context from request
   */
  static createValidationContext(
    toolName: string,
    requestId: string,
    source: 'http' | 'stdio' | 'websocket',
    clientId?: string
  ): ValidationContext {
    return {
      toolName,
      requestId,
      clientId,
      timestamp: new Date(),
      source
    };
  }

  /**
   * Quick validation for high-performance scenarios
   */
  static async quickValidate(toolName: string, args: any): Promise<boolean> {
    try {
      // TODO: validateToolArguments function needs to be implemented
      // validateToolArguments(toolName, args);
      // For now, just do basic validation
      if (!toolName || typeof args !== 'object') {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}

export default IngressValidator;