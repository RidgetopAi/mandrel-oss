/**
 * TS012 - Session-Project Switching Validation Framework
 * 
 * Comprehensive validation framework for session-project switching that ensures:
 * - Pre-switch validation (session state, project existence, compatibility)
 * - Atomic switch process with rollback capability
 * - Post-switch validation (state consistency, context operations)
 * - Integration with existing TS008-TS011 systems
 * 
 * This framework provides robust error handling, clear error messages,
 * and maintains data consistency during project switching operations.
 */

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { isValidUuid } from '../utils/uuid.js';
import type { ProjectInfo } from '../types/project.js';  // ← Import type from shared file
import { randomUUID } from 'crypto';

// Import projectHandler lazily to avoid circular dependency
let projectHandler: any;
async function getProjectHandler() {
  if (!projectHandler) {
    const module = await import('../handlers/project.js');
    projectHandler = module.projectHandler;
  }
  return projectHandler;
}

export interface ValidationError {
  code: string;
  message: string;
  details?: any;
  recoverable: boolean;
}

export interface SwitchValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: string[];
  metadata: Record<string, any>;
}

export interface SwitchContext {
  sessionId: string;
  sourceProjectId: string | null;
  targetProjectId: string;
  timestamp: Date;
  transactionId: string;
  rollbackData?: any;
}

/**
 * Pre-Switch Validation States
 */
export enum PreSwitchValidation {
  SESSION_STATE_VALID = 'SESSION_STATE_VALID',
  PROJECT_EXISTS = 'PROJECT_EXISTS',
  PROJECT_ACCESSIBLE = 'PROJECT_ACCESSIBLE',
  RECOVERY_COMPATIBLE = 'RECOVERY_COMPATIBLE',
  NO_PENDING_OPERATIONS = 'NO_PENDING_OPERATIONS',
  CONCURRENT_ACCESS_SAFE = 'CONCURRENT_ACCESS_SAFE'
}

/**
 * Post-Switch Validation States
 */
export enum PostSwitchValidation {
  SWITCH_COMPLETED = 'SWITCH_COMPLETED',
  STATE_CONSISTENT = 'STATE_CONSISTENT',
  CONTEXT_OPERATIONS_FUNCTIONAL = 'CONTEXT_OPERATIONS_FUNCTIONAL',
  UI_SYNCHRONIZED = 'UI_SYNCHRONIZED'
}

/**
 * Main ProjectSwitchValidator Class
 */
class ProjectSwitchValidator {
  private static activeSwitches = new Map<string, SwitchContext>();
  private static readonly MAX_CONCURRENT_SWITCHES = 5;
  private static readonly SWITCH_TIMEOUT_MS = 30000; // 30 seconds
  
  /**
   * Perform comprehensive pre-switch validation
   */
  static async validatePreSwitch(
    sessionId: string, 
    targetIdentifier: string
  ): Promise<SwitchValidationResult> {
    logger.info(`🔍 [TS012] Pre-switch validation for session ${sessionId.substring(0, 8)}... -> "${targetIdentifier}"`);
    
    const result: SwitchValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      metadata: {
        validationStartTime: new Date(),
        sessionId,
        targetIdentifier,
        validationChecks: {}
      }
    };

    try {
      // 1. Validate current session state consistency
      const sessionValidation = await this.validateSessionState(sessionId);
      result.metadata.validationChecks.sessionState = sessionValidation;
      if (!sessionValidation.isValid) {
        result.isValid = false;
        result.errors.push(...sessionValidation.errors);
      }
      result.warnings.push(...sessionValidation.warnings);

      // 2. Verify target project existence and accessibility
      const projectValidation = await this.validateTargetProject(targetIdentifier);
      result.metadata.validationChecks.targetProject = projectValidation;
      if (!projectValidation.isValid) {
        result.isValid = false;
        result.errors.push(...projectValidation.errors);
      }
      result.warnings.push(...projectValidation.warnings);

      // 3. Check session recovery compatibility
      const recoveryValidation = await this.validateRecoveryCompatibility(sessionId, targetIdentifier);
      result.metadata.validationChecks.recoveryCompatibility = recoveryValidation;
      if (!recoveryValidation.isValid) {
        result.isValid = false;
        result.errors.push(...recoveryValidation.errors);
      }
      result.warnings.push(...recoveryValidation.warnings);

      // 4. Validate no pending operations that might conflict
      const operationsValidation = await this.validatePendingOperations(sessionId);
      result.metadata.validationChecks.pendingOperations = operationsValidation;
      if (!operationsValidation.isValid) {
        result.isValid = false;
        result.errors.push(...operationsValidation.errors);
      }
      result.warnings.push(...operationsValidation.warnings);

      // 5. Check concurrent switching safety
      const concurrencyValidation = await this.validateConcurrentAccess(sessionId);
      result.metadata.validationChecks.concurrentAccess = concurrencyValidation;
      if (!concurrencyValidation.isValid) {
        result.isValid = false;
        result.errors.push(...concurrencyValidation.errors);
      }
      result.warnings.push(...concurrencyValidation.warnings);

      result.metadata.validationEndTime = new Date();
      result.metadata.validationDurationMs = 
        result.metadata.validationEndTime.getTime() - result.metadata.validationStartTime.getTime();

      if (result.isValid) {
        logger.info(`✅ [TS012] Pre-switch validation passed (${result.metadata.validationDurationMs}ms)`);
      } else {
        logger.info(`❌ [TS012] Pre-switch validation failed: ${result.errors.length} errors`);
      }

      return result;

    } catch (error) {
      logger.error('❌ [TS012] Pre-switch validation error', error as Error);
      result.isValid = false;
      result.errors.push({
        code: 'PRE_SWITCH_VALIDATION_ERROR',
        message: `Pre-switch validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        details: { error: error instanceof Error ? error.stack : String(error) },
        recoverable: false
      });
      return result;
    }
  }

  /**
   * Perform atomic project switch with rollback capability
   */
  static async performAtomicSwitch(
    sessionId: string,
    targetProjectId: string,
    _preValidationResult: SwitchValidationResult
  ): Promise<{ success: boolean; project?: ProjectInfo; error?: ValidationError; rollbackData?: any }> {
    const transactionId = randomUUID();
    const handler = await getProjectHandler();
    const switchContext: SwitchContext = {
      sessionId,
      // PROJECT-SCOPE: rung3 — the switch machinery operates on the INTERACTIVE slot: this
      // records which rung-3 value is being replaced. Reading the effective scope would make
      // a bound client's "source" the binding, which the switch never touches.
      sourceProjectId: await handler.getInteractiveProjectId(sessionId),
      targetProjectId,
      timestamp: new Date(),
      transactionId
    };

    logger.info(`⚛️  [TS012] Starting atomic switch (transaction: ${transactionId.substring(0, 8)}...)`);

    // Check if we're already at capacity for concurrent switches
    if (this.activeSwitches.size >= this.MAX_CONCURRENT_SWITCHES) {
      return {
        success: false,
        error: {
          code: 'CONCURRENT_SWITCH_LIMIT_EXCEEDED',
          message: `Too many concurrent switches (${this.activeSwitches.size}/${this.MAX_CONCURRENT_SWITCHES})`,
          recoverable: true
        }
      };
    }

    // Register this switch as active
    this.activeSwitches.set(sessionId, switchContext);

    try {
      // Prepare rollback data BEFORE making changes
      const rollbackData = await this.prepareRollbackData(sessionId);
      switchContext.rollbackData = rollbackData;

      // Set timeout for the switch operation
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Switch operation timed out')), this.SWITCH_TIMEOUT_MS);
      });

      // Perform the actual switch with timeout
      const switchPromise = this.executeSwitch(sessionId, targetProjectId, switchContext);
      const switchResult = await Promise.race([switchPromise, timeoutPromise]) as any;

      if (switchResult.success) {
        logger.info(`✅ [TS012] Atomic switch completed successfully`);
        return switchResult;
      } else {
        logger.info(`❌ [TS012] Switch failed, attempting rollback`);
        await this.performRollback(switchContext);
        return switchResult;
      }

    } catch (error) {
      logger.error('❌ [TS012] Atomic switch error, performing rollback', error as Error);
      await this.performRollback(switchContext);
      
      return {
        success: false,
        error: {
          code: 'ATOMIC_SWITCH_ERROR',
          message: `Atomic switch failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          details: { error: error instanceof Error ? error.stack : String(error) },
          recoverable: true
        }
      };
    } finally {
      // Clean up active switch tracking
      this.activeSwitches.delete(sessionId);
    }
  }

  /**
   * Perform comprehensive post-switch validation
   */
  static async validatePostSwitch(
    sessionId: string,
    targetProjectId: string,
    switchContext: SwitchContext
  ): Promise<SwitchValidationResult> {
    logger.info(`🔍 [TS012] Post-switch validation for transaction ${switchContext.transactionId.substring(0, 8)}...`);
    
    const result: SwitchValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      metadata: {
        validationStartTime: new Date(),
        sessionId,
        targetProjectId,
        transactionId: switchContext.transactionId,
        validationChecks: {}
      }
    };

    try {
      // 1. Verify switch completion
      const completionValidation = await this.validateSwitchCompletion(sessionId, targetProjectId);
      result.metadata.validationChecks.switchCompletion = completionValidation;
      if (!completionValidation.isValid) {
        result.isValid = false;
        result.errors.push(...completionValidation.errors);
      }

      // 2. Validate state consistency
      const consistencyValidation = await this.validateStateConsistency(sessionId, targetProjectId);
      result.metadata.validationChecks.stateConsistency = consistencyValidation;
      if (!consistencyValidation.isValid) {
        result.isValid = false;
        result.errors.push(...consistencyValidation.errors);
      }

      // 3. Test context operations functionality
      const contextValidation = await this.validateContextOperations(sessionId, targetProjectId);
      result.metadata.validationChecks.contextOperations = contextValidation;
      if (!contextValidation.isValid) {
        result.isValid = false;
        result.errors.push(...contextValidation.errors);
      }

      // 4. Verify UI synchronization hooks
      const uiValidation = await this.validateUISynchronization(sessionId, targetProjectId);
      result.metadata.validationChecks.uiSynchronization = uiValidation;
      if (!uiValidation.isValid) {
        // UI sync failures are warnings, not errors
        result.warnings.push(...uiValidation.errors.map(e => e.message));
      }

      result.metadata.validationEndTime = new Date();
      result.metadata.validationDurationMs = 
        result.metadata.validationEndTime.getTime() - result.metadata.validationStartTime.getTime();

      if (result.isValid) {
        logger.info(`✅ [TS012] Post-switch validation passed (${result.metadata.validationDurationMs}ms)`);
      } else {
        logger.info(`❌ [TS012] Post-switch validation failed: ${result.errors.length} errors`);
      }

      return result;

    } catch (error) {
      logger.error('❌ [TS012] Post-switch validation error', error as Error);
      result.isValid = false;
      result.errors.push({
        code: 'POST_SWITCH_VALIDATION_ERROR',
        message: `Post-switch validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        details: { error: error instanceof Error ? error.stack : String(error) },
        recoverable: false
      });
      return result;
    }
  }

  // ===========================================
  // Private Validation Helper Methods
  // ===========================================

  private static async validateSessionState(sessionId: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      // Check if sessionId is a UUID format - if not, skip database check
      const isUUID = isValidUuid(sessionId);
      
      if (!isUUID) {
        // For non-UUID session IDs, check if it exists in ProjectHandler's in-memory store
        const handler = await getProjectHandler();
        const sessionInfo = handler.getSessionInfo(sessionId);
        if (sessionInfo && (sessionInfo.currentProjectId || sessionInfo.sessionId)) {
          // Session exists in memory, this is valid
          result.warnings.push(`Session ${sessionId} is in-memory session (not stored in database)`);
          result.metadata.sessionType = 'in-memory';
          result.metadata.sessionInfo = sessionInfo;
          return result;
        }
        
        // Session doesn't exist, but we can still allow switching as this will create the session state
        result.warnings.push(`Session ${sessionId} will be created as new in-memory session`);
        result.metadata.sessionType = 'new-in-memory';
        return result;
      }

      // For UUID session IDs, check the database
      const sessionQuery = `
        SELECT id, project_id, started_at, ended_at, agent_type, title, description
        FROM sessions 
        WHERE id = $1
      `;
      const sessionResult = await db.query(sessionQuery, [sessionId]);

      if (sessionResult.rows.length === 0) {
        // If session doesn't exist in database, check if it exists in ProjectHandler's in-memory store
        const handler = await getProjectHandler();
        const sessionInfo = handler.getSessionInfo(sessionId);
        if (sessionInfo && sessionInfo.currentProjectId) {
          // Session exists in memory, this is valid (probably a temporary/in-memory session)
          result.warnings.push(`Session ${sessionId} exists in memory but not in database (temporary session)`);
          result.metadata.sessionType = 'in-memory';
          result.metadata.sessionInfo = sessionInfo;
          return result;
        }
        
        // Session doesn't exist anywhere, but we can still allow switching as this will create the session state
        result.warnings.push(`Session ${sessionId} not found in database or memory (will be created)`);
        result.metadata.sessionType = 'new';
        return result;
      }

      const session = sessionResult.rows[0];
      if (session.ended_at) {
        result.isValid = false;
        result.errors.push({
          code: 'SESSION_ALREADY_ENDED',
          message: `Session ${sessionId} has already ended at ${session.ended_at}`,
          recoverable: false
        });
        return result;
      }

      // Session is active if it hasn't ended yet
      const isActive = !session.ended_at;
      result.metadata.session = session;
      result.metadata.sessionActive = isActive;
      result.metadata.sessionType = 'database';
      
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'SESSION_STATE_VALIDATION_ERROR',
        message: `Failed to validate session state: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: false
      });
      return result;
    }
  }

  private static async validateTargetProject(targetIdentifier: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      const handler = await getProjectHandler();
      const project = await handler.getProject(targetIdentifier);
      if (!project) {
        result.isValid = false;
        result.errors.push({
          code: 'PROJECT_NOT_FOUND',
          message: `Project "${targetIdentifier}" not found`,
          recoverable: false
        });
        return result;
      }

      if (project.status !== 'active') {
        result.warnings.push(`Target project status is '${project.status}' (expected 'active'). This may affect functionality.`);
      }

      result.metadata.targetProject = project;
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'PROJECT_VALIDATION_ERROR',
        message: `Failed to validate target project: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: false
      });
      return result;
    }
  }

  private static async validateRecoveryCompatibility(sessionId: string, targetIdentifier: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      // Check if there are any recovery-incompatible operations
      // This would integrate with the session recovery system from TS008-TS010

      // For now, we'll do a basic check for consistency
      const handler = await getProjectHandler();
      // PROJECT-SCOPE: rung3 — "is the target the same as what project_switch already set?"
      // is a question about the interactive slot, not about the effective scope.
      const currentProjectId = await handler.getInteractiveProjectId(sessionId);
      const targetProject = await handler.getProject(targetIdentifier);

      if (currentProjectId && targetProject && currentProjectId === targetProject.id) {
        result.warnings.push('Target project is the same as current project');
      }

      result.metadata.recoveryCompatible = true;
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'RECOVERY_COMPATIBILITY_ERROR',
        message: `Failed to validate recovery compatibility: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true
      });
      return result;
    }
  }

  private static async validatePendingOperations(_sessionId: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      // Check for any pending operations that might conflict with project switching
      // This could include database transactions, file operations, etc.
      
      // For now, we'll check if there are any ongoing database transactions
      const transactionQuery = `
        SELECT COUNT(*) as transaction_count 
        FROM pg_stat_activity 
        WHERE state = 'active' 
        AND query NOT LIKE '%pg_stat_activity%'
        AND application_name LIKE '%aidis%'
      `;
      
      const transactionResult = await db.query(transactionQuery);
      const transactionCount = parseInt(transactionResult.rows[0].transaction_count);
      
      if (transactionCount > 2) { // Allow for normal connection pool activity
        result.warnings.push(`${transactionCount} database transactions currently active`);
      }

      result.metadata.pendingOperationsCount = transactionCount;
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'PENDING_OPERATIONS_ERROR',
        message: `Failed to validate pending operations: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true
      });
      return result;
    }
  }

  private static async validateConcurrentAccess(sessionId: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      // Check if this session is already involved in an active switch
      if (this.activeSwitches.has(sessionId)) {
        result.isValid = false;
        result.errors.push({
          code: 'CONCURRENT_SWITCH_IN_PROGRESS',
          message: `Session ${sessionId} already has an active project switch in progress`,
          recoverable: true
        });
        return result;
      }

      // Check if we're near the concurrent switch limit
      if (this.activeSwitches.size >= this.MAX_CONCURRENT_SWITCHES - 1) {
        result.warnings.push(`Approaching concurrent switch limit (${this.activeSwitches.size + 1}/${this.MAX_CONCURRENT_SWITCHES})`);
      }

      result.metadata.activeSwitchCount = this.activeSwitches.size;
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'CONCURRENT_ACCESS_ERROR',
        message: `Failed to validate concurrent access: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true
      });
      return result;
    }
  }

  private static async validateSwitchCompletion(sessionId: string, targetProjectId: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      const handler = await getProjectHandler();
      // PROJECT-SCOPE: rung3 — this asserts the SWITCH LANDED, i.e. that rung 3 now holds the
      // target. Reading the effective scope here would let a binding satisfy the assertion
      // while the interactive slot silently failed to update (a guard passing by luck).
      const currentProjectId = await handler.getInteractiveProjectId(sessionId);
      if (currentProjectId !== targetProjectId) {
        result.isValid = false;
        result.errors.push({
          code: 'SWITCH_NOT_COMPLETED',
          message: `Switch not completed: current project is ${currentProjectId}, expected ${targetProjectId}`,
          recoverable: true
        });
      }

      result.metadata.switchCompleted = currentProjectId === targetProjectId;
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'SWITCH_COMPLETION_ERROR',
        message: `Failed to validate switch completion: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true
      });
      return result;
    }
  }

  private static async validateStateConsistency(sessionId: string, targetProjectId: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      // Validate that the session state is consistent across all systems
      const handler = await getProjectHandler();
      // const _sessionInfo = handler.getSessionInfo(sessionId);
      // PROJECT-SCOPE: rung3 — same reason as validateSwitchCompletion: the post-switch state
      // being validated IS the interactive slot.
      const currentProject = await handler.getInteractiveProject(sessionId);

      if (!currentProject || currentProject.id !== targetProjectId) {
        result.isValid = false;
        result.errors.push({
          code: 'STATE_INCONSISTENCY',
          message: `State inconsistency detected: session info and current project mismatch`,
          recoverable: true
        });
      }

      result.metadata.stateConsistent = currentProject?.id === targetProjectId;
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'STATE_CONSISTENCY_ERROR',
        message: `Failed to validate state consistency: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true
      });
      return result;
    }
  }

  private static async validateContextOperations(_sessionId: string, targetProjectId: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      // Test that context operations work with the new project
      // We'll do a simple read test to ensure database connectivity and project access
      // SOFT-DELETE-EXEMPT: this is a CONNECTIVITY PROBE, not a reported population — it
      // answers "can this session read the contexts table for the target project" and the
      // number lands only in validation metadata, never on a tool surface a user reads.
      // Filtering archived rows here would narrow what the probe touches without making any
      // reported number more honest.
      const testQuery = `
        SELECT COUNT(*) as context_count 
        FROM contexts 
        WHERE project_id = $1
      `;
      
      const testResult = await db.query(testQuery, [targetProjectId]);
      const contextCount = parseInt(testResult.rows[0].context_count);
      
      result.metadata.contextOperationsFunctional = true;
      result.metadata.targetProjectContextCount = contextCount;
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'CONTEXT_OPERATIONS_ERROR',
        message: `Context operations validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true
      });
      return result;
    }
  }

  private static async validateUISynchronization(_sessionId: string, _targetProjectId: string): Promise<SwitchValidationResult> {
    const result: SwitchValidationResult = { isValid: true, errors: [], warnings: [], metadata: {} };

    try {
      // Validate that UI synchronization hooks would work
      // This is mostly a placeholder for future UI integration
      result.metadata.uiSynchronized = true;
      result.metadata.synchronizationHooks = ['project-switch-notification'];
      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        code: 'UI_SYNCHRONIZATION_ERROR',
        message: `UI synchronization validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true
      });
      return result;
    }
  }

  // ===========================================
  // Private Switch Operation Methods
  // ===========================================

  private static async prepareRollbackData(sessionId: string): Promise<any> {
    const handler = await getProjectHandler();
    return {
      // PROJECT-SCOPE: rung3 — rollback restores the INTERACTIVE slot, so it must capture the
      // interactive value; restoring a binding-derived id would write the binding into rung 3.
      previousProjectId: await handler.getInteractiveProjectId(sessionId),
      sessionState: handler.getSessionInfo(sessionId),
      timestamp: new Date()
    };
  }

  private static async executeSwitch(
    sessionId: string,
    targetProjectId: string,
    _switchContext: SwitchContext
  ): Promise<{ success: boolean; project?: ProjectInfo; error?: ValidationError }> {
    try {
      // Use the existing switchProject method from projectHandler
      const handler = await getProjectHandler();
      const project = await handler.switchProject(targetProjectId, sessionId);
      return { success: true, project };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SWITCH_EXECUTION_ERROR',
          message: `Switch execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          recoverable: true
        }
      };
    }
  }

  private static async performRollback(switchContext: SwitchContext): Promise<void> {
    try {
      logger.info(`🔄 [TS012] Performing rollback for transaction ${switchContext.transactionId.substring(0, 8)}...`);

      if (switchContext.rollbackData?.previousProjectId) {
        const handler = await getProjectHandler();
        handler.setCurrentProject(switchContext.rollbackData.previousProjectId, switchContext.sessionId);
        logger.info(`✅ [TS012] Rollback completed: restored project ${switchContext.rollbackData.previousProjectId}`);
      } else {
        logger.info(`⚠️  [TS012] No previous project to rollback to`);
      }
    } catch (error) {
      logger.error('❌ [TS012] Rollback failed', error as Error);
      // Rollback failures are logged but not thrown to avoid masking the original error
    }
  }

  /**
   * Get active switches information (for debugging/monitoring)
   */
  static getActiveSwitches(): Map<string, SwitchContext> {
    return new Map(this.activeSwitches);
  }

  /**
   * Clean up timed-out switches
   */
  static cleanupTimedOutSwitches(): void {
    const now = new Date();
    for (const [sessionId, context] of this.activeSwitches.entries()) {
      const elapsedMs = now.getTime() - context.timestamp.getTime();
      if (elapsedMs > this.SWITCH_TIMEOUT_MS) {
        logger.info(`🧹 [TS012] Cleaning up timed-out switch for session ${sessionId}`);
        this.activeSwitches.delete(sessionId);
      }
    }
  }
}

/**
 * Enhanced switch with comprehensive TS012 validation
 * Moved here from ProjectHandler to avoid circular dependency
 */
export async function switchProjectWithValidation(
  identifier: string,
  sessionId: string = 'default-session'
): Promise<ProjectInfo> {
  const handler = await getProjectHandler();

  logger.info(`🔄 [TS012] Enhanced switching to project: "${identifier}" (session: ${sessionId.substring(0, 8)}...)`);

  try {
    // Step 1: Pre-switch validation
    const preValidation = await ProjectSwitchValidator.validatePreSwitch(sessionId, identifier);
    if (!preValidation.isValid) {
      const errorMessages = preValidation.errors.map(e => e.message).join('; ');
      throw new Error(`Pre-switch validation failed: ${errorMessages}`);
    }

    if (preValidation.warnings.length > 0) {
      logger.info(`⚠️  [TS012] Pre-switch warnings: ${preValidation.warnings.join('; ')}`);
    }

    // Step 2: Get target project info for atomic switch
    const targetProject = await handler.getProject(identifier);
    if (!targetProject) {
      throw new Error(`Project "${identifier}" not found`);
    }

    // Step 3: Perform atomic switch with rollback capability
    const switchResult = await ProjectSwitchValidator.performAtomicSwitch(
      sessionId,
      targetProject.id,
      preValidation
    );

    if (!switchResult.success) {
      if (switchResult.error) {
        throw new Error(switchResult.error.message);
      }
      throw new Error('Atomic switch failed for unknown reason');
    }

    // Step 4: Post-switch validation
    const postValidation = await ProjectSwitchValidator.validatePostSwitch(
      sessionId,
      targetProject.id,
      {
        sessionId,
        // PROJECT-SCOPE: rung3 — post-switch context describing the rung-3 transition.
        sourceProjectId: await handler.getInteractiveProjectId(sessionId),
        targetProjectId: targetProject.id,
        timestamp: new Date(),
        transactionId: 'post-validation'
      }
    );

    if (!postValidation.isValid) {
      logger.error(`❌ [TS012] Post-switch validation failed`, undefined, { metadata: { errors: postValidation.errors } });
      // Don't throw here - log the issues but return the project since switch completed
    }

    if (postValidation.warnings.length > 0) {
      logger.info(`⚠️  [TS012] Post-switch warnings: ${postValidation.warnings.join('; ')}`);
    }

    const resultProject = switchResult.project || { ...targetProject, isActive: true };
    logger.info(`✅ [TS012] Enhanced switch completed: ${resultProject.name}`);
    return resultProject;

  } catch (error) {
    logger.error('❌ [TS012] Enhanced switch failed', error as Error);
    throw new Error(`Enhanced project switch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
