/**
 * Git Service - Re-export from modular structure
 * 
 * This file is kept for backward compatibility.
 * The service has been refactored into modules under ./git/
 * 
 * @deprecated Import from './git' instead:
 *   import { GitService } from './git';
 */

export { GitService } from './git';

// Re-export everything for backward compatibility
export * from './git';
