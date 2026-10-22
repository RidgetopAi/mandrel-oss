/**
 * Naming OpenAPI Schemas
 */

export const namingSchemas = {
  NamingEntry: {
    allOf: [
      { $ref: '#/components/schemas/BaseEntity' },
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: {
            type: 'string',
            enum: ['variable', 'function', 'component', 'class', 'interface', 'module', 'file']
          },
          context: { type: 'string' },
          project_id: {
            type: 'string',
            format: 'uuid'
          },
          project_name: { type: 'string' },
          status: {
            type: 'string',
            enum: ['active', 'deprecated', 'conflicted', 'pending']
          },
          compliance_score: { type: 'number' },
          usage_count: { type: 'number' },
          created_by: { type: 'string' },
          updated_by: { type: 'string' }
        },
        required: ['name', 'type', 'status', 'compliance_score', 'usage_count']
      }
    ]
  },

  NamingSearchResponse: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: { $ref: '#/components/schemas/NamingEntry' }
      },
      total: { type: 'integer' },
      limit: { type: 'integer' },
      page: { type: 'integer' }
    },
    required: ['entries', 'total']
  },

  RegisterNamingRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      type: {
        type: 'string',
        enum: ['variable', 'function', 'component', 'class', 'interface', 'module', 'file']
      },
      context: { type: 'string', maxLength: 1000 },
      project_id: {
        type: 'string',
        format: 'uuid'
      }
    },
    required: ['name', 'type']
  },

  UpdateNamingRequest: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'deprecated', 'conflicted', 'pending']
      },
      context: { type: 'string' }
    }
  },

  NamingStats: {
    type: 'object',
    properties: {
      total_names: { type: 'integer' },
      compliance: { type: 'number' },
      deprecated: { type: 'integer' },
      recent_activity: { type: 'integer' },
      by_type: {
        type: 'object',
        additionalProperties: { type: 'integer' }
      },
      by_status: {
        type: 'object',
        additionalProperties: { type: 'integer' }
      },
      by_project: {
        type: 'object',
        additionalProperties: { type: 'integer' }
      },
      total_projects: { type: 'integer' }
    }
  },

  NamingSuggestion: {
    type: 'object',
    properties: {
      suggested_name: { type: 'string' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
      alternatives: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['suggested_name', 'confidence']
  },

  NamingAvailabilityResponse: {
    type: 'object',
    properties: {
      available: { type: 'boolean' },
      message: { type: 'string' },
      conflicts: {
        type: 'array',
        items: { $ref: '#/components/schemas/NamingEntry' }
      }
    },
    required: ['available']
  }
};
