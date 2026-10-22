/**
 * Git service module - barrel export
 * 
 * Primary export is GitService façade for backward compatibility.
 * Domain services and utilities are also exported for direct use.
 */

// Main façade (preserves original API)
export { GitService } from './GitService';

// Domain services
export { CommitService } from './domain/commits';
export { BranchService } from './domain/branches';
export { FileChangeService } from './domain/changes';
export { CorrelationService } from './domain/correlation';

// Infrastructure
export { GitClient } from './infra/git';
export { CommitRepo, BranchRepo, ChangeRepo, CorrelationRepo } from './infra/db';

// Utilities
export * from './utils/fileAnalysis';
export * from './utils/messageAnalysis';
export * from './utils/branchAnalysis';
export * from './utils/errors';
