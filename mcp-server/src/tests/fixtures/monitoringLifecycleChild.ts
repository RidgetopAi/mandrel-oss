/**
 * Child fixture for monitoringLifecycle.contract.test.ts.
 *
 * A SEPARATE PROCESS is the only surface on which either property is observable. Both
 * "importing this module starts nothing" and "these timers do not hold the event loop open"
 * are statements about a process's exit behaviour and its live handle set, and a vitest
 * worker has neither a fresh registry nor an exit of its own to offer.
 *
 * Whatever this prints, it prints BEFORE it stops. It never calls process.exit(): the whole
 * question under test is whether Node returns on its own.
 *
 * argv[2] selects the mode:
 *   import-only     — import the module and do nothing else.
 *   explicit-start  — import it, then call startMonitoring(), then do nothing else.
 */

const mode = process.argv[2];

const monitoringModule = await import('../../utils/monitoring.js');

if (mode === 'explicit-start') {
  monitoringModule.startMonitoring();
} else if (mode !== 'import-only') {
  console.log(`UNKNOWN_MODE=${String(mode)}`);
  process.exitCode = 64;
}

/**
 * `getActiveResourcesInfo()` reports the handles that are KEEPING THE LOOP ALIVE. An unref'd
 * interval is deliberately absent from it while still being scheduled — that absence IS the
 * property under test, so the count is read here rather than inferred from the exit.
 */
const timeouts = process
  .getActiveResourcesInfo()
  .filter((r) => r === 'Timeout').length;

console.log(`MODE=${String(mode)}`);
console.log(`STARTED=${monitoringModule.isMonitoringStarted()}`);
console.log(`LOOP_HOLDING_TIMEOUTS=${timeouts}`);
console.log('BODY_COMPLETE');

export {};
