/**
 * OpenAPI Schemas - Barrel Export
 * Combines all schema modules into a single schemas object
 */

import { baseSchemas } from './base';
import { projectSchemas } from './projects';
import { taskSchemas } from './tasks';
import { mcpSchemas } from './mcp';
import { contextSchemas } from './contexts';
import { decisionSchemas } from './decisions';
import { namingSchemas } from './naming';
import { sessionSchemas } from './sessions';
import { monitoringSchemas } from './monitoring';
import { embeddingSchemas } from './embeddings';
import { taskAttachmentSchemas } from './taskAttachments';

export const schemas = {
  ...baseSchemas,
  ...projectSchemas,
  ...taskSchemas,
  ...mcpSchemas,
  ...contextSchemas,
  ...decisionSchemas,
  ...namingSchemas,
  ...sessionSchemas,
  ...monitoringSchemas,
  ...embeddingSchemas,
  ...taskAttachmentSchemas
};

export {
  baseSchemas,
  projectSchemas,
  taskSchemas,
  mcpSchemas,
  contextSchemas,
  decisionSchemas,
  namingSchemas,
  sessionSchemas,
  monitoringSchemas,
  embeddingSchemas,
  taskAttachmentSchemas
};
