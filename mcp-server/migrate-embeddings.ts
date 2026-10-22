#!/usr/bin/env node

/**
 * Phase 3: Embeddings Migration Script - 1536D Migration
 *
 * This script migrates all contexts from 384D embeddings to 1536D embeddings.
 * It processes contexts in batches to handle memory efficiently and includes
 * comprehensive error handling and progress logging.
 *
 * Usage:
 *   npx tsx migrate-embeddings.ts --dry-run    # Test run
 *   npx tsx migrate-embeddings.ts              # Actual migration
 */

import { db, initializeDatabase } from './src/config/database.js';
import { embeddingService } from './src/services/embedding.js';

interface Context {
  id: string;
  content: string;
  context_type: string;
  project_id?: string;
  session_id?: string;
  embedding_migrated: boolean;
  embedding_1536?: string;
}

interface MigrationStats {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  skipped: number;
  alreadyMigrated: number;
  errors: Array<{ contextId: string; error: string }>;
}

class EmbeddingMigration1536 {
  private batchSize: number = 10;
  private dryRun: boolean = false;
  private stats: MigrationStats = {
    total: 0,
    processed: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    alreadyMigrated: 0,
    errors: []
  };

  constructor(options: { dryRun?: boolean; batchSize?: number } = {}) {
    this.dryRun = options.dryRun || false;
    this.batchSize = options.batchSize || 10;
  }

  /**
   * Get all contexts that need 1536D embedding migration
   */
  private async getContextsNeedingMigration(): Promise<Context[]> {
    console.log('🔍 Finding contexts that need 1536D embedding migration...');

    const query = `
      SELECT
        id,
        content,
        context_type,
        project_id,
        session_id,
        embedding_migrated,
        embedding_1536
      FROM contexts
      WHERE embedding_migrated = false
      ORDER BY created_at ASC
    `;

    const result = await db.query(query);
    console.log(`📊 Found ${result.rows.length} contexts needing 1536D migration`);

    return result.rows;
  }

  /**
   * Get migration progress stats
   */
  private async getMigrationProgress(): Promise<void> {
    console.log('📊 Checking migration progress...');

    const query = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN embedding_migrated THEN 1 ELSE 0 END) as migrated,
        SUM(CASE WHEN embedding_1536 IS NOT NULL THEN 1 ELSE 0 END) as has_1536_embedding
      FROM contexts
    `;

    const result = await db.query(query);
    const stats = result.rows[0];

    console.log(`📈 Migration Progress:`);
    console.log(`   Total contexts: ${stats.total}`);
    console.log(`   Already migrated: ${stats.migrated}`);
    console.log(`   Has 1536D embeddings: ${stats.has_1536_embedding}`);
    console.log(`   Remaining: ${stats.total - stats.migrated}`);
  }

  /**
   * Validate that content is suitable for embedding generation
   */
  private validateContext(context: Context): boolean {
    if (!context.content || typeof context.content !== 'string') {
      return false;
    }

    const trimmed = context.content.trim();
    if (trimmed.length === 0) {
      return false;
    }

    // Skip very short content that might not be meaningful
    if (trimmed.length < 10) {
      return false;
    }

    // Skip very long content that might cause issues
    if (trimmed.length > 8000) {
      console.warn(`⚠️  Context ${context.id} has very long content (${trimmed.length} chars), skipping`);
      return false;
    }

    return true;
  }

  /**
   * Generate 1536D embedding for a single context
   */
  private async processContext(context: Context): Promise<{ success: boolean; embedding?: number[]; error?: string }> {
    try {
      // Skip if already migrated
      if (context.embedding_migrated) {
        this.stats.alreadyMigrated++;
        return { success: true, error: 'Already migrated' };
      }

      // Validate context
      if (!this.validateContext(context)) {
        return { success: false, error: 'Invalid or unsuitable content' };
      }

      console.log(`📝 Processing context ${context.id} (${context.context_type}): "${context.content.substring(0, 60)}..."`);

      // Generate 1536D embedding using the EmbeddingService
      const result = await embeddingService.generateEmbedding({
        text: context.content,
      });

      if (!result || !result.embedding || result.embedding.length === 0) {
        return { success: false, error: 'Empty embedding returned' };
      }

      // Validate embedding dimensions - should be 1536D
      if (result.embedding.length !== 1536) {
        return { success: false, error: `Invalid embedding dimensions: ${result.embedding.length} (expected 1536)` };
      }

      // Validate embedding values
      const hasInvalidValues = result.embedding.some(val => !isFinite(val));
      if (hasInvalidValues) {
        return { success: false, error: 'Embedding contains invalid values (NaN/Infinity)' };
      }

      console.log(`✅ Generated 1536D embedding for context ${context.id}`);
      return { success: true, embedding: result.embedding };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to generate 1536D embedding for context ${context.id}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Update context with 1536D embedding in database
   */
  private async updateContextEmbedding(contextId: string, embedding: number[]): Promise<boolean> {
    if (this.dryRun) {
      console.log(`🔍 [DRY RUN] Would update context ${contextId} with 1536D embedding`);
      return true;
    }

    try {
      const query = `
        UPDATE contexts 
        SET 
          embedding_1536 = $1,
          embedding_migrated = true
        WHERE id = $2
      `;

      await db.query(query, [JSON.stringify(embedding), contextId]);
      return true;
    } catch (error) {
      console.error(`❌ Failed to update context ${contextId} in database:`, error);
      return false;
    }
  }

  /**
   * Process a batch of contexts
   */
  private async processBatch(contexts: Context[]): Promise<void> {
    console.log(`\n🔄 Processing batch of ${contexts.length} contexts...`);

    for (const context of contexts) {
      this.stats.processed++;

      const result = await this.processContext(context);

      if (result.success && result.embedding) {
        const updateSuccess = await this.updateContextEmbedding(context.id, result.embedding);

        if (updateSuccess) {
          this.stats.successful++;
          console.log(`✅ Successfully migrated context ${context.id} to 1536D`);
        } else {
          this.stats.failed++;
          this.stats.errors.push({
            contextId: context.id,
            error: 'Failed to update database'
          });
        }
      } else if (result.error === 'Already migrated') {
        // Context was already migrated, skip
        console.log(`⏭️  Context ${context.id} already migrated`);
      } else {
        this.stats.failed++;
        this.stats.errors.push({
          contextId: context.id,
          error: result.error || 'Unknown error'
        });

        if (result.error === 'Invalid or unsuitable content') {
          this.stats.skipped++;
          console.log(`⏭️  Skipped context ${context.id}: ${result.error}`);
        } else {
          console.error(`❌ Failed to process context ${context.id}: ${result.error}`);
        }
      }

      // Show progress
      const progressPercent = Math.round((this.stats.processed / this.stats.total) * 100);
      console.log(`📊 Progress: ${this.stats.processed}/${this.stats.total} (${progressPercent}%) - ✅ ${this.stats.successful} success, ❌ ${this.stats.failed} failed`);
    }
  }

  /**
   * Test embedding service health before migration
   */
  private async testEmbeddingService(): Promise<boolean> {
    console.log('🏥 Testing embedding service health for 1536D migration...');

    try {
      const health = await embeddingService.getHealthStatus();
      console.log(`🏥 Service health:`, {
        healthy: health.healthy,
        localModelReady: health.localModelReady,
        openAiAvailable: health.openAiAvailable
      });

      if (!health.healthy) {
        console.error('❌ Embedding service is not healthy');
        return false;
      }

      // Test with sample text to verify 1536D output
      const testResult = await embeddingService.generateEmbedding({
        text: 'This is a test embedding to verify 1536D dimensions work correctly.'
      });

      if (!testResult || !testResult.embedding || testResult.embedding.length !== 1536) {
        console.error(`❌ Test embedding generation failed or wrong dimensions (got ${testResult?.embedding?.length}, expected 1536)`);
        return false;
      }

      console.log(`✅ Embedding service is healthy and ready (test embedding: ${testResult.embedding.length}D)`);
      return true;
    } catch (error) {
      console.error('❌ Embedding service health check failed:', error);
      return false;
    }
  }

  /**
   * Verify migration results
   */
  private async verifyMigration(): Promise<void> {
    console.log('\n🔍 Verifying migration results...');

    const query = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN embedding_migrated THEN 1 ELSE 0 END) as migrated,
        SUM(CASE WHEN embedding_1536 IS NOT NULL THEN 1 ELSE 0 END) as has_1536_embedding
      FROM contexts
    `;

    const result = await db.query(query);
    const stats = result.rows[0];

    console.log(`📈 Final Migration Stats:`);
    console.log(`   Total contexts: ${stats.total}`);
    console.log(`   Migrated: ${stats.migrated}`);
    console.log(`   Has 1536D embeddings: ${stats.has_1536_embedding}`);

    // Verify dimensions
    if (!this.dryRun) {
      const dimQuery = `
        SELECT 
          array_length(string_to_array(trim(both '[]' from embedding_1536::text), ','), 1) as dims,
          COUNT(*)
        FROM contexts 
        WHERE embedding_1536 IS NOT NULL 
        GROUP BY dims
      `;

      const dimResult = await db.query(dimQuery);
      console.log(`📏 Embedding dimensions verification:`);
      dimResult.rows.forEach(row => {
        console.log(`   ${row.dims}D: ${row.count} contexts`);
      });
    }
  }

  /**
   * Print final migration results
   */
  private printResults(): void {
    console.log('\n' + '='.repeat(70));
    console.log('📊 1536D EMBEDDING MIGRATION RESULTS');
    console.log('='.repeat(70));

    if (this.dryRun) {
      console.log('🔍 DRY RUN - No actual changes made');
    }

    console.log(`Total contexts: ${this.stats.total}`);
    console.log(`Processed: ${this.stats.processed}`);
    console.log(`✅ Successfully migrated: ${this.stats.successful}`);
    console.log(`❌ Failed: ${this.stats.failed}`);
    console.log(`⏭️  Skipped (invalid content): ${this.stats.skipped}`);
    console.log(`📝 Already migrated: ${this.stats.alreadyMigrated}`);

    if (this.stats.errors.length > 0) {
      console.log(`\n❌ ERRORS (${this.stats.errors.length}):`);
      this.stats.errors.slice(0, 10).forEach((error, index) => {
        console.log(`${index + 1}. Context ${error.contextId}: ${error.error}`);
      });
      if (this.stats.errors.length > 10) {
        console.log(`... and ${this.stats.errors.length - 10} more errors`);
      }
    }

    if (this.stats.successful > 0) {
      const successRate = Math.round((this.stats.successful / this.stats.processed) * 100);
      console.log(`\n🎉 Success rate: ${successRate}%`);

      if (!this.dryRun) {
        console.log(`✅ ${this.stats.successful} contexts now have 1536D embeddings!`);
      }
    }

    console.log('='.repeat(70));
  }

  /**
   * Run the 1536D embeddings migration
   */
  async runMigration(): Promise<void> {
    const startTime = Date.now();

    console.log('🚀 Starting AIDIS 1536D Embeddings Migration...');
    console.log('📝 This migrates contexts from 384D to 1536D embeddings');
    if (this.dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made to the database');
    }
    console.log(`📦 Batch size: ${this.batchSize}`);
    console.log('');

    try {
      // Initialize database connection
      await initializeDatabase();
      console.log('✅ Database connection established');

      // Check migration progress
      await this.getMigrationProgress();

      // Test embedding service health
      const serviceHealthy = await this.testEmbeddingService();
      if (!serviceHealthy) {
        throw new Error('Embedding service is not ready for 1536D migration');
      }

      // Get contexts needing migration
      const contexts = await this.getContextsNeedingMigration();
      if (contexts.length === 0) {
        console.log('🎉 All contexts already migrated to 1536D embeddings!');
        await this.verifyMigration();
        return;
      }

      this.stats.total = contexts.length;

      // Process contexts in batches
      for (let i = 0; i < contexts.length; i += this.batchSize) {
        const batch = contexts.slice(i, i + this.batchSize);
        console.log(`\n📦 Batch ${Math.floor(i / this.batchSize) + 1}/${Math.ceil(contexts.length / this.batchSize)}`);

        await this.processBatch(batch);

        // Add delay between batches to be gentle on the system
        if (i + this.batchSize < contexts.length) {
          console.log('⏸️  Pausing 2 seconds between batches...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Verify migration results
      await this.verifyMigration();

      // Print final results
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n⏱️  Total migration time: ${duration} seconds`);

      this.printResults();

      if (this.stats.failed === 0) {
        console.log('\n🎉 1536D Migration completed successfully!');
      } else {
        console.log('\n⚠️  Migration completed with some failures. See error details above.');
      }

    } catch (error) {
      console.error('\n❌ Migration failed:', error);
      this.printResults();
      throw error;
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='));
const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1]) : 10;

// Create and run migration
const migration = new EmbeddingMigration1536({
  dryRun: isDryRun,
  batchSize: Math.max(1, Math.min(50, batchSize)) // Limit batch size between 1-50
});

// Run migration if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migration.runMigration()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { EmbeddingMigration1536 };
