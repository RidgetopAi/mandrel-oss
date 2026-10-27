#!/usr/bin/env node
/**
 * beliefCost.ts — dev/host shim. The report itself is compiled code in src/cli/ (shipped in the
 * image as dist/cli/beliefCostMain.js); this only lets `npx tsx scripts/beliefCost.ts` keep working
 * for a host-side notifier.
 */
import '../src/cli/beliefCostMain.js';
