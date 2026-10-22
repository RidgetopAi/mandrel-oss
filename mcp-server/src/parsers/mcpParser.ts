/**
 * TR001-5: Robust MCP Response Parser using TypeScript
 * Eliminates brittle JSON parsing with structured parsing and validation
 */

import { z } from 'zod';

// Comprehensive MCP response schemas
const McpContentSchema = z.object({
  type: z.enum(['text', 'resource', 'image']),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  resource: z.object({
    // uri is optional at the schema level so the content-specific check below
    // produces the friendly "missing resource.uri" message (consistent with
    // the text/image cases) instead of a generic Zod path error.
    uri: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
});

const McpToolResponseSchema = z.object({
  content: z.array(McpContentSchema),
  additionalFields: z.record(z.any()).optional(),
});

const McpSuccessResponseSchema = z.object({
  success: z.literal(true),
  data: z.any(),
  additionalFields: z.record(z.any()).optional(),
});

const McpErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  additionalFields: z.record(z.any()).optional(),
});

const McpResponseSchema = z.union([
  McpToolResponseSchema,
  McpSuccessResponseSchema,
  McpErrorResponseSchema,
]);

export type McpContent = z.infer<typeof McpContentSchema>;
export type McpToolResponse = z.infer<typeof McpToolResponseSchema>;
export type McpSuccessResponse = z.infer<typeof McpSuccessResponseSchema>;
export type McpErrorResponse = z.infer<typeof McpErrorResponseSchema>;
export type McpResponse = z.infer<typeof McpResponseSchema>;

/**
 * Grammar-based MCP Response Parser
 * Provides structured parsing with comprehensive error handling
 */
export class McpParser {
  private static readonly MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB limit
  private static readonly MAX_CONTENT_ITEMS = 100;
  private static readonly MAX_NESTING_DEPTH = 10;

  /**
   * Parse MCP response with comprehensive validation
   */
  static parseResponse(responseText: string): { success: true; data: McpResponse } | { success: false; error: string } {
    try {
      // Size validation
      if (responseText.length > this.MAX_RESPONSE_SIZE) {
        return {
          success: false,
          error: `Response too large: ${responseText.length} bytes exceeds ${this.MAX_RESPONSE_SIZE} byte limit`
        };
      }

      // Empty response check
      if (!responseText.trim()) {
        return {
          success: false,
          error: 'Empty response received'
        };
      }

      // Parse JSON with error handling
      let jsonData: any;
      try {
        jsonData = JSON.parse(responseText);
      } catch (parseError) {
        const err = parseError as Error;
        return {
          success: false,
          error: `JSON parsing failed: ${err.message}`
        };
      }

      // Validate nesting depth
      if (this.getObjectDepth(jsonData) > this.MAX_NESTING_DEPTH) {
        return {
          success: false,
          error: `Response nesting too deep: exceeds ${this.MAX_NESTING_DEPTH} levels`
        };
      }

      // Schema validation
      const validationResult = McpResponseSchema.safeParse(jsonData);
      if (!validationResult.success) {
        return {
          success: false,
          error: `Schema validation failed: ${this.formatZodError(validationResult.error)}`
        };
      }

      // Content array size validation
      if ('content' in validationResult.data && Array.isArray(validationResult.data.content)) {
        if (validationResult.data.content.length > this.MAX_CONTENT_ITEMS) {
          return {
            success: false,
            error: `Too many content items: ${validationResult.data.content.length} exceeds ${this.MAX_CONTENT_ITEMS} limit`
          };
        }
      }

      return {
        success: true,
        data: validationResult.data
      };

    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Parser error: ${err.message}`
      };
    }
  }

  /**
   * Parse MCP tool response specifically
   */
  static parseToolResponse(responseText: string): { success: true; data: McpToolResponse } | { success: false; error: string } {
    const parseResult = this.parseResponse(responseText);

    if (!parseResult.success) {
      return parseResult;
    }

    // Verify it's a tool response
    if (!('content' in parseResult.data)) {
      return {
        success: false,
        error: 'Not a valid tool response: missing content array'
      };
    }

    return {
      success: true,
      data: parseResult.data as McpToolResponse
    };
  }

  /**
   * Parse MCP success response specifically
   */
  static parseSuccessResponse(responseText: string): { success: true; data: McpSuccessResponse } | { success: false; error: string } {
    const parseResult = this.parseResponse(responseText);

    if (!parseResult.success) {
      return parseResult;
    }

    // Verify it's a success response
    if (!('success' in parseResult.data) || parseResult.data.success !== true) {
      return {
        success: false,
        error: 'Not a valid success response'
      };
    }

    return {
      success: true,
      data: parseResult.data as McpSuccessResponse
    };
  }

  /**
   * Parse MCP error response specifically
   */
  static parseErrorResponse(responseText: string): { success: true; data: McpErrorResponse } | { success: false; error: string } {
    const parseResult = this.parseResponse(responseText);

    if (!parseResult.success) {
      return parseResult;
    }

    // Verify it's an error response
    if (!('success' in parseResult.data) || parseResult.data.success !== false) {
      return {
        success: false,
        error: 'Not a valid error response'
      };
    }

    return {
      success: true,
      data: parseResult.data as McpErrorResponse
    };
  }

  /**
   * Validate MCP content structure
   */
  static validateContent(content: any[]): { valid: true } | { valid: false; error: string } {
    try {
      const validationResult = z.array(McpContentSchema).safeParse(content);

      if (!validationResult.success) {
        return {
          valid: false,
          error: `Content validation failed: ${this.formatZodError(validationResult.error)}`
        };
      }

      // Additional content-specific validations
      for (const item of validationResult.data) {
        if (item.type === 'text' && !item.text) {
          return {
            valid: false,
            error: 'Text content item missing text field'
          };
        }

        if (item.type === 'image' && (!item.data || !item.mimeType)) {
          return {
            valid: false,
            error: 'Image content item missing data or mimeType'
          };
        }

        if (item.type === 'resource' && !item.resource?.uri) {
          return {
            valid: false,
            error: 'Resource content item missing resource.uri'
          };
        }
      }

      return { valid: true };

    } catch (error) {
      const err = error as Error;
      return {
        valid: false,
        error: `Content validation error: ${err.message}`
      };
    }
  }

  /**
   * Extract text content from MCP response
   */
  static extractTextContent(response: McpResponse): string[] {
    if (!('content' in response)) {
      return [];
    }

    return response.content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text!);
  }

  /**
   * Extract all content from MCP response with type information
   */
  static extractAllContent(response: McpResponse): Array<{ type: string; content: any }> {
    if (!('content' in response)) {
      return [];
    }

    return response.content.map(item => ({
      type: item.type,
      content: item.type === 'text' ? item.text :
               item.type === 'image' ? { data: item.data, mimeType: item.mimeType } :
               item.type === 'resource' ? item.resource :
               item
    }));
  }

  /**
   * Calculate object nesting depth
   */
  private static getObjectDepth(obj: any, depth = 0): number {
    if (depth > this.MAX_NESTING_DEPTH) {
      return depth;
    }

    if (typeof obj !== 'object' || obj === null) {
      return depth;
    }

    if (Array.isArray(obj)) {
      return Math.max(depth, ...obj.map(item => this.getObjectDepth(item, depth + 1)));
    }

    const values = Object.values(obj);
    if (values.length === 0) {
      return depth;
    }

    return Math.max(depth, ...values.map(value => this.getObjectDepth(value, depth + 1)));
  }

  /**
   * Format Zod validation errors for readability
   */
  private static formatZodError(error: z.ZodError): string {
    return error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
  }
}

export default McpParser;