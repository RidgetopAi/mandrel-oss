/**
 * generate.ts — GENERATION of the OpenAPI spec from the route sources.
 *
 * This is the swagger-jsdoc call, and it is the ONLY thing here that depends on the
 * process CWD (see the `apis` glob below). It is used at BUILD time — by
 * scripts/emit-openapi-artifact.cjs and by scripts/export-openapi.ts, both of which
 * run from mandrel-command/backend where src/routes/ exists.
 *
 * ⚠️ DO NOT import this from the serving path. ./index.ts is the serving path: it
 * loads the build artifact this produces, precisely so that a process whose CWD
 * cannot see src/ (every runner container) cannot end up serving an
 * empty document. Importing generate.ts from a request path would reintroduce the
 * defect; ./index.ts only falls back to it when the artifact is absent, which is the
 * ts-node/dev case where src/ is present by construction.
 */

import swaggerJSDoc from 'swagger-jsdoc';
import { schemas } from './schemas/index';
import { tags } from './tags';

const options: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AIDIS Command Backend API',
      version: '1.0.0',
      description: 'RESTful API for AIDIS Command Backend with MCP Bridge Integration',
      contact: {
        name: 'AIDIS Development Team',
        email: 'dev@aidis.local'
      }
    },
    servers: [
      {
        url: '/api',
        description: 'Same-origin API (relative base; the app overrides OpenAPI.BASE at runtime)'
      }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas
    },
    security: [
      {
        BearerAuth: []
      }
    ],
    tags
  },
  // CWD-RELATIVE BY DESIGN, and the reason index.ts does not call this at runtime.
  // swagger-jsdoc resolves this against process.cwd(); from a directory with no src/
  // it matches nothing and returns a valid document with zero paths.
  apis: [
    './src/routes/*.ts'
  ]
};

/**
 * Build the spec by globbing the route sources, relative to the CURRENT PROCESS CWD.
 * Call this only from a working directory that contains src/routes/ — i.e. the repo
 * checkout or the Docker builder stage, never the runner.
 */
export function generateSwaggerSpec(): Record<string, unknown> {
  return swaggerJSDoc(options) as Record<string, unknown>;
}

export default generateSwaggerSpec;
