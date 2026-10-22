/**
 * TR004-6: Schema Validation Routes
 * Dedicated endpoints for testing and validating schemas
 */

import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { validationStats } from '../middleware/validation';
import { SchemaRegistry, validateData } from '../validation/schemas';
import { logger } from '../config/logger';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';

const router = Router();

// Apply authentication to validation routes
router.use(authenticateToken);

// ================================
// SCHEMA VALIDATION ENDPOINTS
// ================================

/**
 * GET /validation/schemas - List all available schemas
 */
router.get('/schemas', (req: Request, res: Response) => {
  try {
    const schemas = Object.keys(SchemaRegistry).map(schemaName => ({
      name: schemaName,
      description: `Schema for ${schemaName.replace(/([A-Z])/g, ' $1').toLowerCase()}`,
      type: schemaName.startsWith('Create') ? 'create' :
            schemaName.startsWith('Update') ? 'update' :
            'other'
    }));

    logger.info('Schema list requested', {
      correlationId: req.correlationId,
      schemaCount: schemas.length
    });

    res.json({
      success: true,
      data: {
        schemas,
        totalCount: schemas.length
      },
      correlationId: req.correlationId
    });
  } catch (error) {
    logger.error('Error listing schemas', {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      error: {
        type: 'internal',
        message: 'Failed to list schemas'
      },
      correlationId: req.correlationId
    });
  }
});

/**
 * POST /validation/validate/:schemaName - Validate data against a specific schema
 */
router.post(
  '/validate/:schemaName',
  declareAnyAuthenticatedMayWrite('validates a payload against a schema; persists nothing'),
  (req: Request, res: Response) => {
  try {
    const { schemaName } = req.params;
    const dataToValidate = req.body;

    // Check if schema exists
    if (!(schemaName in SchemaRegistry)) {
      return res.status(400).json({
        success: false,
        error: {
          type: 'validation',
          message: `Schema '${schemaName}' not found`,
          availableSchemas: Object.keys(SchemaRegistry)
        },
        correlationId: req.correlationId
      });
    }

    const schema = SchemaRegistry[schemaName as keyof typeof SchemaRegistry];
    const result = validateData(schema as any, dataToValidate);

    // Record validation statistics
    validationStats.recordValidation(result.success, req.path, result.errors);

    logger.info('Schema validation performed', {
      correlationId: req.correlationId,
      schemaName,
      success: result.success,
      errorCount: result.errors?.length || 0
    });

    if (result.success) {
      return res.json({
        success: true,
        data: {
          valid: true,
          validatedData: result.data,
          schemaName
        },
        correlationId: req.correlationId
      });
    } else {
      return res.status(400).json({
        success: false,
        error: {
          type: 'validation',
          message: 'Validation failed',
          details: result.errors,
          schemaName
        },
        correlationId: req.correlationId
      });
    }
  } catch (error) {
    logger.error('Error validating data', {
      correlationId: req.correlationId,
      schemaName: req.params.schemaName,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    return res.status(500).json({
      success: false,
      error: {
        type: 'internal',
        message: 'Validation service error'
      },
      correlationId: req.correlationId
    });
  }
});

/**
 * GET /validation/stats - Get validation statistics
 */
router.get('/stats', (req: Request, res: Response) => {
  try {
    const stats = validationStats.getStats();

    logger.info('Validation stats requested', {
      correlationId: req.correlationId,
      totalValidations: stats.totalValidations
    });

    res.json({
      success: true,
      data: {
        statistics: stats,
        generatedAt: new Date().toISOString()
      },
      correlationId: req.correlationId
    });
  } catch (error) {
    logger.error('Error getting validation stats', {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      error: {
        type: 'internal',
        message: 'Failed to get validation statistics'
      },
      correlationId: req.correlationId
    });
  }
});

/**
 * POST /validation/stats/reset - Reset validation statistics
 */
router.post(
  '/stats/reset',
  declareAnyAuthenticatedMayWrite('resets in-memory validation counters — FLAGGED as a plausible admin-only control, unchanged here'),
  (req: Request, res: Response) => {
  try {
    const oldStats = validationStats.getStats();
    validationStats.reset();

    logger.info('Validation stats reset', {
      correlationId: req.correlationId,
      previousStats: oldStats
    });

    res.json({
      success: true,
      data: {
        message: 'Validation statistics reset successfully',
        previousStats: oldStats
      },
      correlationId: req.correlationId
    });
  } catch (error) {
    logger.error('Error resetting validation stats', {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      error: {
        type: 'internal',
        message: 'Failed to reset validation statistics'
      },
      correlationId: req.correlationId
    });
  }
});

// ================================
// SCHEMA TESTING ENDPOINTS
// ================================

/**
 * GET /validation/test/projects - Test project schema validation
 */
router.get('/test/projects', (req: Request, res: Response) => {
  const testData = {
    valid: {
      name: 'Test Project',
      description: 'A test project for validation',
      git_repo_url: 'https://github.com/test/repo.git',
      root_directory: '/home/user/projects/test'
    },
    invalid: {
      name: 'T', // Too short
      description: 'A'.repeat(501), // Too long
      git_repo_url: 'not-a-url',
      root_directory: '/'.repeat(300) // Too long
    }
  };

  const createProjectSchema = SchemaRegistry.CreateProject;

  const validResult = validateData(createProjectSchema, testData.valid);
  const invalidResult = validateData(createProjectSchema, testData.invalid);

  res.json({
    success: true,
    data: {
      schemaName: 'CreateProject',
      tests: {
        validData: {
          input: testData.valid,
          result: validResult
        },
        invalidData: {
          input: testData.invalid,
          result: invalidResult
        }
      }
    },
    correlationId: req.correlationId
  });
});

/**
 * GET /validation/test/tasks - Test task schema validation
 */
router.get('/test/tasks', (req: Request, res: Response) => {
  const testData = {
    valid: {
      title: 'Test Task',
      description: 'A test task for validation',
      type: 'feature',
      priority: 'medium',
      assigned_to: 'developer',
      project_id: '123e4567-e89b-12d3-a456-426614174000',
      tags: ['test', 'validation']
    },
    invalid: {
      title: 'T', // Too short
      type: 'invalid-type',
      priority: 'invalid-priority',
      project_id: 'not-a-uuid',
      tags: Array(11).fill('tag') // Too many tags
    }
  };

  const createTaskSchema = SchemaRegistry.CreateTask;

  const validResult = validateData(createTaskSchema, testData.valid);
  const invalidResult = validateData(createTaskSchema, testData.invalid);

  res.json({
    success: true,
    data: {
      schemaName: 'CreateTask',
      tests: {
        validData: {
          input: testData.valid,
          result: validResult
        },
        invalidData: {
          input: testData.invalid,
          result: invalidResult
        }
      }
    },
    correlationId: req.correlationId
  });
});

// ================================
// CONTRACT HEALTH CHECK
// ================================

/**
 * GET /validation/health - Validation system health check
 */
router.get('/health', (req: Request, res: Response) => {
  try {
    const schemaCount = Object.keys(SchemaRegistry).length;
    const stats = validationStats.getStats();

    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      schemas: {
        count: schemaCount,
        available: Object.keys(SchemaRegistry)
      },
      statistics: stats,
      features: {
        schemaValidation: true,
        errorFormatting: true,
        statisticsCollection: true,
        contractEnforcement: true
      }
    };

    logger.info('Validation health check', {
      correlationId: req.correlationId,
      status: health.status,
      schemaCount
    });

    res.json({
      success: true,
      data: health,
      correlationId: req.correlationId
    });
  } catch (error) {
    logger.error('Validation health check failed', {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      error: {
        type: 'internal',
        message: 'Validation system unhealthy'
      },
      correlationId: req.correlationId
    });
  }
});

export default router;