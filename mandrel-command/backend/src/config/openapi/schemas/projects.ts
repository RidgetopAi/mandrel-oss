/**
 * Project OpenAPI Schemas
 */

export const projectSchemas = {
  ProjectEntity: {
    allOf: [
      { $ref: '#/components/schemas/BaseEntity' },
      {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 2,
            maxLength: 100,
            description: 'Project name'
          },
          description: {
            type: 'string',
            maxLength: 500,
            description: 'Project description'
          },
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'archived'],
            description: 'Project status'
          },
          git_repo_url: {
            type: 'string',
            format: 'uri',
            description: 'Git repository URL'
          },
          root_directory: {
            type: 'string',
            maxLength: 255,
            description: 'Project root directory path'
          },
          metadata: {
            type: 'object',
            additionalProperties: true,
            description: 'Additional project metadata'
          },
          context_count: {
            type: 'integer',
            description: 'Number of contexts associated with the project'
          },
          session_count: {
            type: 'integer',
            description: 'Number of sessions associated with the project'
          },
          last_activity: {
            type: 'string',
            format: 'date-time',
            description: 'Timestamp of the last recorded activity'
          }
        },
        required: ['name', 'status']
      }
    ]
  },

  CreateProjectRequest: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 2,
        maxLength: 100,
        description: 'Project name'
      },
      description: {
        type: 'string',
        maxLength: 500,
        description: 'Project description'
      },
      git_repo_url: {
        type: 'string',
        format: 'uri',
        description: 'Git repository URL'
      },
      root_directory: {
        type: 'string',
        maxLength: 255,
        description: 'Project root directory path'
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description: 'Additional project metadata'
      }
    },
    required: ['name']
  },

  UpdateProjectRequest: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 2,
        maxLength: 100,
        description: 'Project name'
      },
      description: {
        type: 'string',
        maxLength: 500,
        description: 'Project description'
      },
      status: {
        type: 'string',
        enum: ['active', 'inactive', 'archived'],
        description: 'Project status'
      },
      git_repo_url: {
        type: 'string',
        format: 'uri',
        description: 'Git repository URL'
      },
      root_directory: {
        type: 'string',
        maxLength: 255,
        description: 'Project root directory path'
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description: 'Additional project metadata'
      }
    }
  },

  ProjectListResponse: {
    type: 'object',
    properties: {
      projects: {
        type: 'array',
        items: { $ref: '#/components/schemas/ProjectEntity' }
      },
      total: { type: 'integer' }
    },
    required: ['projects', 'total']
  },

  ProjectDetailResponse: {
    type: 'object',
    properties: {
      project: { $ref: '#/components/schemas/ProjectEntity' }
    },
    required: ['project']
  },

  ProjectSessionsResponse: {
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

  ProjectStats: {
    type: 'object',
    properties: {
      total_projects: { type: 'integer' },
      active_projects: { type: 'integer' },
      total_contexts: { type: 'integer' },
      total_sessions: { type: 'integer' },
      contexts_by_type: {
        type: 'object',
        additionalProperties: { type: 'integer' }
      },
      recent_activity: {
        type: 'object',
        properties: {
          contexts_last_week: { type: 'integer' },
          sessions_last_week: { type: 'integer' }
        }
      }
    }
  }
};
