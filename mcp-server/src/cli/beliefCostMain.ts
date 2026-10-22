#!/usr/bin/env node
/**
 * beliefCostMain — process entry for the cost report (compiled to dist/cli/beliefCostMain.js).
 *
 *   node dist/cli/beliefCostMain.js              # human summary, default window
 *   node dist/cli/beliefCostMain.js --days 30    # 30-day window
 *   node dist/cli/beliefCostMain.js --json       # machine-readable
 *
 * Connects with the standard DATABASE_* env. NOTHING here mutates.
 */

import { db, initializeDatabase, closeDatabase } from '../config/database.js';
import { runBeliefCost } from './beliefCost.js';

async function main(): Promise<void> {
  await initializeDatabase();
  await runBeliefCost(process.argv.slice(2), db, (t) => process.stdout.write(t));
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('belief-cost report failed:', err);
    try {
      await closeDatabase();
    } catch { /* ignore */ }
    process.exit(1);
  });
