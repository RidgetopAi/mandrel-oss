/**
 * Task OpenAPI Schemas
 */

export const taskSchemas = {
  TaskEntity: {
    allOf: [
      { $ref: '#/components/schemas/BaseEntity' },
      {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            format: 'uuid',
            description: 'Associated project ID'
          },
          title: {
            type: 'string',
            minLength: 2,
            maxLength: 500,
            description: 'Task title'
          },
          description: {
            type: 'string',
            maxLength: 2000,
            description: 'Task description'
          },
          type: {
            type: 'string',
            enum: ['general', 'feature', 'bug', 'refactor', 'test', 'docs', 'devops'],
            description: 'Task type'
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
            description: 'Task status'
          },
          stage: {
            // OpenAPI 3.0 (generate.ts) — `nullable: true`, not the 3.1 `type: [..., 'null']`
            // form, which the codegen silently drops (the frontend then lost `| null`).
            type: 'string',
            nullable: true,
            enum: ['draft', 'ready', 'claimed', 'verifying', 'evidence', 'merged', 'deployed'],
            description: 'The Punch List lane (migration 101). SOURCE OF TRUTH over `status`, which is derived from it automatically. Null on a cancelled task or a legacy row.'
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Task priority'
          },
          assigned_to: {
            type: 'string',
            maxLength: 100,
            description: 'Assignee'
          },
          tags: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 50
            },
            maxItems: 10,
            description: 'Task tags'
          },
          due_date: {
            type: 'string',
            format: 'date-time',
            description: 'Task due date'
          },
          estimated_hours: {
            type: 'number',
            minimum: 0,
            description: 'Estimated hours to complete'
          },
          actual_hours: {
            type: 'number',
            minimum: 0,
            description: 'Actual hours spent'
          }
        },
        required: ['project_id', 'title', 'type', 'status', 'priority']
      }
    ]
  },

  CreateTaskRequest: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 2,
        maxLength: 500,
        description: 'Task title'
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'Task description'
      },
      type: {
        type: 'string',
        enum: ['general', 'feature', 'bug', 'refactor', 'test', 'docs', 'devops'],
        default: 'general',
        description: 'Task type'
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'urgent'],
        description: 'Task priority'
      },
      assigned_to: {
        type: 'string',
        maxLength: 100,
        description: 'Assignee'
      },
      project_id: {
        type: 'string',
        format: 'uuid',
        description: 'Associated project ID'
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 50
        },
        maxItems: 10,
        description: 'Task tags'
      },
      stage: {
        type: 'string',
        enum: ['draft', 'ready', 'claimed', 'verifying', 'evidence', 'merged', 'deployed'],
        description: 'The Punch List lane (migration 101). Setting stage:"ready" REQUIRES title + punch.doneWhen + punch.proofKind + a resolved project, or the write is refused (400, code PUNCH_INCOMPLETE).'
      },
      punch: {
        type: 'object',
        description: 'Shallow-merged into metadata.punch.',
        properties: {
          doneWhen: { type: 'string', minLength: 1, maxLength: 2000 },
          proofKind: { type: 'string', enum: ['test', 'browser', 'look'] },
          source: { type: 'string', enum: ['form', 'chat', 'machine'] }
        }
      }
    },
    required: ['title', 'priority', 'project_id']
  },

  UpdateTaskRequest: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 2,
        maxLength: 500,
        description: 'Task title'
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'Task description'
      },
      type: {
        type: 'string',
        enum: ['general', 'feature', 'bug', 'refactor', 'test', 'docs', 'devops'],
        description: 'Task type'
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
        description: 'Task status'
      },
      stage: {
        type: 'string',
        enum: ['draft', 'ready', 'claimed', 'verifying', 'evidence', 'merged', 'deployed'],
        description: 'The Punch List lane (migration 101). Setting stage:"ready" REQUIRES title + punch.doneWhen + punch.proofKind + a resolved project (evaluated against the MERGED existing+incoming state), or the write is refused (400, code PUNCH_INCOMPLETE).'
      },
      punch: {
        type: 'object',
        description: 'Shallow-merged into metadata.punch — an omitted field is untouched, an explicit null deletes it.',
        properties: {
          doneWhen: { type: 'string', nullable: true, minLength: 1, maxLength: 2000 },
          proofKind: { type: 'string', nullable: true, enum: ['test', 'browser', 'look'] },
          source: { type: 'string', nullable: true, enum: ['form', 'chat', 'machine'] }
        }
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'urgent'],
        description: 'Task priority'
      },
      assigned_to: {
        type: 'string',
        maxLength: 100,
        description: 'Assignee'
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 50
        },
        maxItems: 10,
        description: 'Task tags'
      }
    }
  }
};
