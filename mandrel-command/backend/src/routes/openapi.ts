/**
 * OpenAPI Documentation Routes
 * Addresses QA Finding #1: OpenAPI specification and documentation
 */

import { Router, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec, { specResolution } from '../config/openapi';
import { logger } from '../config/logger';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * A VACUOUS SPEC IS NEVER SERVED.
 *
 * Until 2026-08-31 every containerized instance served this endpoint as HTTP 200 with
 * `paths: {}` — a well-formed document describing zero endpoints — because
 * swagger-jsdoc's cwd-relative glob found no src/ in the runner image. Measured on all
 * 7 running command-backend containers, prod included. A customer reading it got a
 * contract that documented nothing, and it was indistinguishable from an API that
 * genuinely had no routes.
 *
 * config/openapi now loads a build artifact and flags `degraded` when the resolved spec
 * falls below the path floor. When that happens we return 503 rather than a 200: the
 * consumer gets an error it can act on instead of a plausible empty answer. This is the
 * runtime backstop — the hard fail-closed is in scripts/emit-openapi-artifact.cjs,
 * which makes such an image unbuildable in the first place.
 */
function refuseIfDegraded(req: Request, res: Response): boolean {
  if (!specResolution.degraded) {
    return false;
  }
  logger.error('Refusing to serve a vacuous OpenAPI specification', {
    correlationId: req.correlationId,
    pathCount: specResolution.pathCount,
    source: specResolution.source,
    finding: specResolution.finding
  });
  res.status(503).json({
    success: false,
    error: {
      type: 'unavailable',
      message:
        'OpenAPI specification is unavailable on this instance: the build artifact is ' +
        'missing or documents no paths. This is a deployment fault, not an empty API.'
    },
    correlationId: req.correlationId
  });
  return true;
}

/**
 * AUTHENTICATED — the WHOLE family (2026-08-25).
 *
 * `/api/openapi/`, `/api/openapi/openapi.json`, `/api/openapi/postman.json` and
 * `/api/openapi/docs` were 200-with-no-credential on prod and all 7 tenants. The spec is
 * the complete map of our API: every path, every parameter, every schema. It is genuinely
 * useful to an authenticated customer and it is pure reconnaissance to everybody else, so
 * the call is to AUTHENTICATE rather than remove — the customer keeps the artifact, the
 * anonymous prober loses it.
 *
 * ONE `router.use` rather than four route-level guards on purpose: `swaggerUi.serve` below
 * is a `router.use`, not a route, so it mounts static asset handlers that no per-route
 * guard would cover. Registered FIRST, so it runs before every layer beneath it.
 *
 * KNOWN CONSEQUENCE, stated rather than discovered later: the interactive Swagger UI at
 * /api/openapi/docs loads its own assets via plain browser requests that cannot carry an
 * Authorization header, so that page no longer works from a browser address bar. The JSON
 * spec — the part tooling consumes — works fine with a Bearer token.
 */
router.use(authenticateToken);

/**
 * @swagger
 * /openapi.json:
 *   get:
 *     summary: Get OpenAPI specification
 *     tags: [Documentation]
 *     responses:
 *       200:
 *         description: OpenAPI specification in JSON format
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
router.get('/openapi.json', (req: Request, res: Response) => {
  try {
    if (refuseIfDegraded(req, res)) {
      return;
    }

    logger.info('OpenAPI specification requested', {
      correlationId: req.correlationId,
      userAgent: req.get('User-Agent')
    });

    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
  } catch (error) {
    logger.error('Failed to serve OpenAPI specification', {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      error: {
        type: 'internal',
        message: 'Failed to generate OpenAPI specification'
      },
      correlationId: req.correlationId
    });
  }
});

/**
 * Swagger UI Documentation
 * Serves interactive API documentation
 */
router.use('/docs', swaggerUi.serve);
router.get('/docs', swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customSiteTitle: 'AIDIS Command Backend API Documentation',
  customCss: '.swagger-ui .topbar { display: none }',
  swaggerOptions: {
    docExpansion: 'list',
    filter: true,
    showRequestHeaders: true,
    showCommonExtensions: true,
    tryItOutEnabled: true
  }
}));

/**
 * API Documentation Root
 */
router.get('/', (req: Request, res: Response) => {
  if (refuseIfDegraded(req, res)) {
    return;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;

  res.json({
    success: true,
    data: {
      message: 'AIDIS Command Backend API Documentation',
      version: (swaggerSpec as any).info?.version || '1.0.0',
      documentation: {
        interactive: `${baseUrl}/docs`,
        openapi_spec: `${baseUrl}/openapi.json`,
        postman_collection: `${baseUrl}/postman.json`
      },
      endpoints: {
        total: Object.keys((swaggerSpec as any).paths || {}).length,
        tags: (swaggerSpec as any).tags?.map((tag: any) => tag.name) || []
      }
    },
    correlationId: req.correlationId
  });
});

/**
 * Generate Postman Collection
 */
router.get('/postman.json', (req: Request, res: Response) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}/api`;

    // Convert OpenAPI spec to basic Postman collection format
    const postmanCollection = {
      info: {
        name: (swaggerSpec as any).info?.title || 'AIDIS Command Backend API',
        description: (swaggerSpec as any).info?.description || '',
        version: (swaggerSpec as any).info?.version || '1.0.0',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      variable: [
        {
          key: 'baseUrl',
          value: baseUrl,
          type: 'string'
        }
      ],
      auth: {
        type: 'bearer',
        bearer: [
          {
            key: 'token',
            value: '{{authToken}}',
            type: 'string'
          }
        ]
      },
      item: [
        {
          name: 'Projects',
          item: [
            {
              name: 'Get All Projects',
              request: {
                method: 'GET',
                header: [],
                url: {
                  raw: '{{baseUrl}}/projects',
                  host: ['{{baseUrl}}'],
                  path: ['projects']
                }
              }
            },
            {
              name: 'Create Project',
              request: {
                method: 'POST',
                header: [
                  {
                    key: 'Content-Type',
                    value: 'application/json'
                  }
                ],
                body: {
                  mode: 'raw',
                  raw: JSON.stringify({
                    name: 'Sample Project',
                    description: 'A sample project for testing',
                    git_repo_url: 'https://github.com/example/repo.git',
                    root_directory: '/path/to/project'
                  }, null, 2)
                },
                url: {
                  raw: '{{baseUrl}}/projects',
                  host: ['{{baseUrl}}'],
                  path: ['projects']
                }
              }
            }
          ]
        },
        {
          name: 'Tasks',
          item: [
            {
              name: 'Get All Tasks',
              request: {
                method: 'GET',
                header: [],
                url: {
                  raw: '{{baseUrl}}/tasks',
                  host: ['{{baseUrl}}'],
                  path: ['tasks']
                }
              }
            },
            {
              name: 'Create Task',
              request: {
                method: 'POST',
                header: [
                  {
                    key: 'Content-Type',
                    value: 'application/json'
                  }
                ],
                body: {
                  mode: 'raw',
                  raw: JSON.stringify({
                    title: 'Sample Task',
                    description: 'A sample task for testing',
                    type: 'feature',
                    priority: 'medium',
                    project_id: '123e4567-e89b-12d3-a456-426614174000',
                    tags: ['sample', 'test']
                  }, null, 2)
                },
                url: {
                  raw: '{{baseUrl}}/tasks',
                  host: ['{{baseUrl}}'],
                  path: ['tasks']
                }
              }
            }
          ]
        }
      ]
    };

    logger.info('Postman collection requested', {
      correlationId: req.correlationId,
      userAgent: req.get('User-Agent')
    });

    res.setHeader('Content-Type', 'application/json');
    res.json(postmanCollection);
  } catch (error) {
    logger.error('Failed to generate Postman collection', {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      error: {
        type: 'internal',
        message: 'Failed to generate Postman collection'
      },
      correlationId: req.correlationId
    });
  }
});

export default router;