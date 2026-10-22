/**
 * Task Attachment OpenAPI Schemas (Lane B)
 */

export const taskAttachmentSchemas = {
  TaskAttachment: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      taskId: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['before', 'evidence'] },
      filename: { type: 'string', maxLength: 255 },
      mime: { type: 'string', maxLength: 100 },
      byteSize: { type: 'integer', minimum: 1, maximum: 5242880 },
      createdBy: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      url: { type: 'string', description: 'Path to GET the raw bytes' }
    },
    required: ['id', 'taskId', 'kind', 'filename', 'mime', 'byteSize', 'createdAt', 'url']
  },
  TaskAttachmentTooLargeError: {
    type: 'object',
    properties: {
      code: { type: 'string', enum: ['ATTACHMENT_TOO_LARGE'] },
      maxBytes: { type: 'integer' }
    }
  },
  TaskAttachmentTypeRejectedError: {
    type: 'object',
    properties: {
      code: { type: 'string', enum: ['ATTACHMENT_TYPE_REJECTED'] },
      allowed: { type: 'array', items: { type: 'string' } }
    }
  }
};
