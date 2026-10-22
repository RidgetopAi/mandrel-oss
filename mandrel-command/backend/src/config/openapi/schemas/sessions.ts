/**
 * Session OpenAPI Schemas
 */

export const sessionSchemas = {
  SessionEntity: {
    allOf: [
      { $ref: '#/components/schemas/BaseEntity' },
      {
        type: 'object',
        properties: {
          display_id: { type: 'string', description: 'Human-readable session ID' },
          project_id: { type: 'string', format: 'uuid' },
          project_name: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          session_goal: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          started_at: { type: 'string', format: 'date-time' },
          ended_at: { type: 'string', format: 'date-time', nullable: true, description: 'Session end time - null means active' },
          duration_minutes: { type: 'string', description: 'Decimal string of duration in minutes' },
          last_activity_at: { type: 'string', format: 'date-time' },
          last_context_at: { type: 'string', format: 'date-time' },
          status: { type: 'string', description: 'Session status indicator' },
          session_type: { type: 'string' },
          agent_type: { type: 'string', description: 'Type of AI agent' },
          ai_model: { type: 'string', description: 'AI model used' },
          actor: {
            type: 'string',
            nullable: true,
            description:
              'The stable principal that owns the session — the "who" dimension ' +
              '(operator, coordinator, builder-<id8>, tick, deploy-smoke, anonymous…). ' +
              'Null for pre-actor / header-less sessions. Attribution, not an authz boundary.'
          },
          lines_added: { type: 'integer' },
          lines_deleted: { type: 'integer' },
          lines_net: { type: 'integer' },
          files_modified_count: { type: 'integer' },
          // Counts are DERIVED from the child tables (contexts / tasks /
          // technical_decisions by session_id), never from the denormalized
          // sessions.*_created columns, which SessionRepo.finish() zeroed on every
          // session end. Each `*_created` field and its `*_count`
          // sibling carry the SAME derived value, so a client's defensive
          // `contexts_created ?? context_count` can never be poisoned twice.
          tasks_created: { type: 'integer', description: 'Derived from tasks.session_id (not the denormalized counter)' },
          task_count: { type: 'integer', description: 'Alias of tasks_created — same derived source' },
          tasks_updated: { type: 'integer', description: 'Counter column: an update leaves no per-session child row, so this one is not derivable' },
          tasks_completed: { type: 'integer', description: 'Derived from tasks.session_id WHERE status = completed' },
          task_completion_rate: { type: 'string', description: 'Decimal string percentage' },
          contexts_created: { type: 'integer', description: 'Derived from contexts.session_id (not the denormalized counter)' },
          context_count: { type: 'integer', description: 'Alias of contexts_created — same derived source' },
          decisions_created: { type: 'integer', description: 'Derived from technical_decisions.session_id. The sessions.decisions_created column has no runtime writer and is permanently 0' },
          decision_count: { type: 'integer', description: 'Alias of decisions_created — same derived source' },
          input_tokens: { type: 'string', description: 'Input tokens consumed' },
          output_tokens: { type: 'string', description: 'Output tokens generated' },
          total_tokens: { type: 'string', description: 'Total tokens (input + output)' },
          productivity_score: { type: 'string', description: 'Decimal productivity score 0-100' },
          activity_count: { type: 'integer' },
          metadata: { type: 'object', additionalProperties: true }
        }
      }
    ]
  },

  UpdateSession: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        maxLength: 255,
        description: 'Session title'
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'Session description'
      }
    }
  },

  SessionStats: {
    type: 'object',
    properties: {
      total_sessions: { type: 'integer' },
      active_sessions: { type: 'integer' },
      sessions_last_24h: { type: 'integer' }
    }
  },

  SessionListResponse: {
    type: 'object',
    properties: {
      sessions: {
        type: 'array',
        items: { $ref: '#/components/schemas/SessionEntity' }
      },
      total: { type: 'integer' }
    },
    required: ['sessions', 'total']
  },

  SessionDetail: {
    allOf: [
      { $ref: '#/components/schemas/SessionEntity' },
      {
        type: 'object',
        properties: {
          contexts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                type: { type: 'string' },
                content: { type: 'string' },
                created_at: { type: 'string', format: 'date-time' },
                tags: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            }
          },
          duration: { type: 'number' },
          metadata: {
            type: 'object',
            additionalProperties: true
          }
        }
      }
    ]
  },

  SessionDetailResponse: {
    type: 'object',
    properties: {
      session: { $ref: '#/components/schemas/SessionDetail' }
    },
    required: ['session']
  },

  SessionCurrentResponse: {
    type: 'object',
    properties: {
      session: {
        oneOf: [
          { $ref: '#/components/schemas/SessionDetail' },
          { type: 'null' }
        ]
      }
    },
    required: ['session']
  }
};
