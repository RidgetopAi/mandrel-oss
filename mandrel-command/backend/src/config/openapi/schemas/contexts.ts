/**
 * Context OpenAPI Schemas
 */

export const contextSchemas = {
  ContextEntity: {
    allOf: [
      { $ref: '#/components/schemas/BaseEntity' },
      {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Context body content'
          },
          type: {
            type: 'string',
            enum: ['code', 'decision', 'research', 'issue', 'note', 'error', 'test'],
            description: 'Context classification'
          },
          tags: {
            type: 'array',
            items: {
              type: 'string'
            },
            description: 'Associated tags'
          },
          metadata: {
            type: 'object',
            additionalProperties: true,
            description: 'Arbitrary metadata payload'
          },
          session_id: {
            type: 'string',
            format: 'uuid',
            description: 'Linked session identifier'
          },
          project_id: {
            type: 'string',
            format: 'uuid',
            description: 'Associated project identifier'
          },
          relevance_score: {
            type: 'number',
            description: 'Semantic similarity score when applicable'
          }
        },
        required: ['content', 'type']
      }
    ]
  },

  UpdateContext: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        minLength: 1,
        maxLength: 10000,
        description: 'Updated context content'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated tag list'
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description: 'Updated metadata payload'
      },
      relevance_score: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Updated relevance score'
      }
    }
  },

  ContextSearchResponse: {
    type: 'object',
    properties: {
      contexts: {
        type: 'array',
        items: {
          $ref: '#/components/schemas/ContextEntity'
        }
      },
      total: {
        type: 'integer'
      },
      limit: {
        type: 'integer'
      },
      offset: {
        type: 'integer'
      }
    },
    required: ['contexts', 'total']
  },

  ContextStats: {
    type: 'object',
    properties: {
      total_contexts: { type: 'integer' },
      contexts_last_24h: { type: 'integer' },
      contexts_by_type: {
        type: 'object',
        additionalProperties: { type: 'integer' }
      }
    }
  },

  ContextBulkDelete: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        },
        minItems: 1
      }
    },
    required: ['ids']
  },

  ContextBulkUpdate: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        },
        minItems: 1,
        description: 'Context IDs to update'
      },
      updates: {
        type: 'object',
        description: 'Fields to apply to every matched context (at least one required)',
        properties: {
          project_id: {
            type: 'string',
            format: 'uuid',
            description: 'Reassign contexts to this project'
          },
          tags: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 50
            },
            maxItems: 10,
            description: 'Replacement tag list (max 10 tags)'
          },
          relevance_score: {
            type: 'number',
            minimum: 0,
            maximum: 10,
            description: 'Updated relevance score'
          }
        }
      }
    },
    required: ['ids', 'updates']
  }
};
