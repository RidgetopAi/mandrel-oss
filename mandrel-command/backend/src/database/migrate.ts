import fs from 'fs';
import path from 'path';
import { db as pool } from './connection';
import { logger } from '../config/logger';

async function runMigration(migrationFile: string): Promise<void> {
  const migrationPath = path.join(__dirname, 'migrations', migrationFile);
  
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found: ${migrationFile}`);
  }
  
  const sql = fs.readFileSync(migrationPath, 'utf8');
  
  try {
    logger.info(`Running migration: ${migrationFile}`);
    await pool.query(sql);
    logger.info(`✅ Migration completed: ${migrationFile}`);
  } catch (error) {
    logger.error(`❌ Migration failed: ${migrationFile}`, { error });
    throw error;
  }
}

async function runAllMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();
  
  for (const file of migrationFiles) {
    await runMigration(file);
  }
}

// CLI usage
if (require.main === module) {
  const migrationFile = process.argv[2];
  
  if (migrationFile) {
    runMigration(migrationFile).catch((error) => logger.error('Migration failed', { error }));
  } else {
    runAllMigrations().catch((error) => logger.error('Migration failed', { error }));
  }
}
