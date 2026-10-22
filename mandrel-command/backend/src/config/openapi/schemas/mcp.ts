/**
 * MCP Bridge OpenAPI Schemas
 */

export const mcpSchemas = {
  McpToolCall: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description: 'Name of the MCP tool to call'
      },
      arguments: {
        type: 'object',
        additionalProperties: true,
        description: 'Arguments to pass to the MCP tool'
      }
    },
    required: ['toolName']
  },

  McpToolResponse: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'Whether the tool call succeeded'
      },
      result: {
        type: 'object',
        description: 'Tool execution result'
      },
      error: {
        type: 'string',
        description: 'Error message if call failed'
      }
    },
    required: ['success']
  }
};
