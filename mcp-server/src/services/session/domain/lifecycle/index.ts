/**
 * Lifecycle domain module
 */

export { SessionLifecycleService, type StartSessionOptions } from './SessionLifecycleService.js';
export { resolveProjectForSession } from './projectResolution.js';
export {
  resolveSession,
  defaultResolveSessionPorts,
  type ResolveSessionResult,
  type ResolveSessionPorts,
  type ResolveSource,
} from './resolveSession.js';
export { shadowCompareResolution, type ShadowComparison } from './shadowResolver.js';
