/**
 * Decision OpenAPI Schemas
 */

export const decisionSchemas = {
  DecisionEntity: {
    allOf: [
      { $ref: '#/components/schemas/BaseEntity' },
      {
        type: 'object',
        properties: {
          title: { type: 'string' },
          problem: { type: 'string' },
          decision: { type: 'string' },
          rationale: { type: 'string' },
          alternatives: {
            type: 'array',
            items: { type: 'string' }
          },
          status: {
            type: 'string',
            enum: ['active', 'under_review', 'superseded', 'deprecated']
          },
          outcomeStatus: {
            type: 'string',
            enum: ['unknown', 'successful', 'failed', 'mixed', 'too_early'],
            description: 'Lifecycle outcome assessment'
          },
          outcomeNotes: { type: 'string' },
          lessonsLearned: { type: 'string' },
          supersededBy: { type: 'string' },
          supersededReason: { type: 'string' },
          outcome: { type: 'string' },
          lessons: { type: 'string' },
          tags: {
            type: 'array',
            items: { type: 'string' }
          },
          project_id: {
            type: 'string',
            format: 'uuid'
          },
          project_name: { type: 'string' },
          created_by: { type: 'string' },
          updated_by: { type: 'string' }
        },
        required: ['title', 'problem', 'decision', 'status']
      }
    ]
  },

  DecisionSearchResponse: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        items: { $ref: '#/components/schemas/DecisionEntity' }
      },
      total: { type: 'integer' },
      limit: { type: 'integer' },
      page: { type: 'integer' }
    },
    required: ['decisions', 'total']
  },

  DecisionStats: {
    type: 'object',
    properties: {
      total_decisions: { type: 'integer' },
      by_status: {
        type: 'object',
        additionalProperties: { type: 'integer' }
      },
      by_project: {
        type: 'object',
        additionalProperties: { type: 'integer' }
      },
      recent_decisions: { type: 'integer' },
      total_projects: { type: 'integer' }
    }
  },

  CreateDecisionRequest: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 5, maxLength: 200 },
      problem: { type: 'string', minLength: 10, maxLength: 5000 },
      decision: { type: 'string', minLength: 10, maxLength: 5000 },
      rationale: { type: 'string', maxLength: 5000 },
      alternatives: {
        type: 'array',
        items: { type: 'string' }
      },
      status: {
        type: 'string',
        enum: ['active', 'under_review', 'superseded', 'deprecated'],
        default: 'active'
      },
      tags: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['title', 'problem', 'decision']
  },

  UpdateDecisionRequest: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      problem: { type: 'string' },
      decision: { type: 'string' },
      rationale: { type: 'string' },
      alternatives: {
        type: 'array',
        items: { type: 'string' }
      },
      status: {
        type: 'string',
        enum: ['active', 'under_review', 'superseded', 'deprecated']
      },
      outcomeStatus: {
        type: 'string',
        enum: ['unknown', 'successful', 'failed', 'mixed', 'too_early']
      },
      outcomeNotes: { type: 'string' },
      lessonsLearned: { type: 'string' },
      supersededReason: { type: 'string' },
      tags: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  }
};
