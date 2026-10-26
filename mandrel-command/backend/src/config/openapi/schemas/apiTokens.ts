/**
 * API token schemas (Settings → API tokens). The listed shape carries NO
 * token and NO hash — the plaintext appears only in the create response, beside this object.
 */
export const apiTokenSchemas = {
  ApiToken: {
    type: 'object',
    required: ['id', 'name', 'prefix', 'createdAt', 'lastUsedAt', 'expiresAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      prefix: { type: 'string', description: 'Non-secret display prefix, e.g. mdl_AbCd1234' },
      createdAt: { type: 'string', format: 'date-time' },
      lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
      expiresAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
};
