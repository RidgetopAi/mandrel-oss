/**
 * Base OpenAPI Schemas
 * Common response wrappers, base entity, and pagination schemas
 */

export const baseSchemas = {
  ApiSuccessResponse: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        example: true
      },
      data: {
        type: 'object',
        description: 'Response data payload'
      },
      correlationId: {
        type: 'string',
        format: 'uuid',
        description: 'Request correlation ID for tracking'
      },
      metadata: {
        type: 'object',
        properties: {
          timestamp: {
            type: 'string',
            format: 'date-time'
          },
          version: {
            type: 'string',
            example: '1.0.0'
          }
        }
      }
    },
    required: ['success', 'data']
  },

  ApiErrorResponse: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        example: false
      },
      error: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['validation', 'authentication', 'authorization', 'not_found', 'internal', 'business'],
            description: 'Error type for client handling'
          },
          message: {
            type: 'string',
            description: 'Human-readable error message'
          },
          details: {
            type: 'object',
            description: 'Additional error details (e.g., validation errors)'
          },
          code: {
            type: 'string',
            description: 'Machine-readable error code'
          }
        },
        required: ['type', 'message']
      },
      correlationId: {
        type: 'string',
        format: 'uuid'
      }
    },
    required: ['success', 'error']
  },

  BaseEntity: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: 'Unique identifier'
      },
      created_at: {
        type: 'string',
        format: 'date-time',
        description: 'Creation timestamp'
      },
      updated_at: {
        type: 'string',
        format: 'date-time',
        description: 'Last update timestamp'
      }
    },
    required: ['id', 'created_at', 'updated_at']
  },

  PaginationQuery: {
    type: 'object',
    properties: {
      page: {
        type: 'integer',
        minimum: 1,
        default: 1,
        description: 'Page number'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Items per page'
      },
      sortBy: {
        type: 'string',
        description: 'Field to sort by'
      },
      sortOrder: {
        type: 'string',
        enum: ['asc', 'desc'],
        default: 'asc',
        description: 'Sort order'
      }
    }
  },

  PaginatedResponse: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object'
        },
        description: 'Array of items'
      },
      pagination: {
        type: 'object',
        properties: {
          page: {
            type: 'integer',
            description: 'Current page number'
          },
          limit: {
            type: 'integer',
            description: 'Items per page'
          },
          total: {
            type: 'integer',
            description: 'Total number of items'
          },
          totalPages: {
            type: 'integer',
            description: 'Total number of pages'
          },
          hasNext: {
            type: 'boolean',
            description: 'Whether there is a next page'
          },
          hasPrev: {
            type: 'boolean',
            description: 'Whether there is a previous page'
          }
        },
        required: ['page', 'limit', 'total', 'totalPages', 'hasNext', 'hasPrev']
      }
    },
    required: ['items', 'pagination']
  }
};
