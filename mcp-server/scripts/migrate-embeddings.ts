#!/usr/bin/env node

/**
 * AIDIS Embeddings Migration Script
 *
 * This script generates embeddings for contexts that currently have NULL embeddings.
 * It processes contexts in batches to avoid overwhelming the system and includes
 * comprehensive error handling and progress tracking.
 *
 * Usage:
 *   npm run tsx scripts/migrate-embeddings.ts --dry-run    # Test run
 *   npm run tsx scripts/migrate-embeddings.ts             # Actual migration
 */

import { db, initializeDatabase } from '../src/config/database.js';
import { embeddingService } from '../src/services/embedding.js';

interface Context {
  id: string;
  content: string;
  context_type: string;
  project_id?: string;
  session_id?: string;
}

interface MigrationStats {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  skipped: number;
  errors: Array<{ contextId: string; error: string }>;
}

class EmbeddingMigration {
  private batchSize: number = 10;
  private dryRun: boolean = false;
  private stats: MigrationStats = {
    total: 0,
    processed: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: []
  };

  constructor(options: { dryRun?: boolean; batchSize?: number } = {}) {
    this.dryRun = options.dryRun || false;
    this.batchSize = options.batchSize || 10;
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
   * Generate embedding for a single context
   */
  private async processContext(context: Context): Promise<{ success: boolean; embedding?: number[]; error?: string }> {
    try {
      // Validate context
      if (!this.validateContext(context)) {
        return { success: false, error: 'Invalid or unsuitable content' };
      }

      console.log(`📝 Processing context ${context.id} (${context.context_type}): "${context.content.substring(0, 60)}..."`);

      // Truncate content if needed
      const textToEmbed = context.content.length > 8000 
        ? context.content.substring(0, 8000)
        : context.content;

      // Generate embedding
      const result = await embeddingService.generateEmbedding({
        text: textToEmbed,
      });

      if (!result || !result.embedding || result.embedding.length === 0) {
        return { success: false, error: 'Empty embedding returned' };
      }

      // Validate embedding dimensions
      if (result.embedding.length !== 1536) {
        return { success: false, error: `Invalid embedding dimensions: ${result.embedding.length} (expected 1536)` };
      }

      return { success: true, embedding: result.embedding };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to generate embedding for context ${context.id}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Update context with embedding in database
   */
  private async updateContextEmbedding(contextId: string, embedding: number[]): Promise<boolean> {
    if (this.dryRun) {
      console.log(`🔍 [DRY RUN] Would update context ${contextId} with embedding`);
      return true;
    }

    try {
      await db.query(
        'UPDATE contexts SET embedding = $1 WHERE id = $2',
        [JSON.stringify(embedding), contextId]
      );
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
          console.log(`✅ Successfully processed context ${context.id}`);
        } else {
          this.stats.failed++;
          this.stats.errors.push({
            contextId: context.id,
            error: 'Failed to update database'
          });
        }
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
    console.log('🏥 Testing embedding service health...');

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

      // Test with sample text
      const testResult = await embeddingService.generateEmbedding({
        text: 'This is a test embedding to verify the service works correctly.'
      });

      if (!testResult || !testResult.embedding || testResult.embedding.length === 0) {
        console.error('❌ Test embedding generation failed');
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
   * Print final migration results
   */
  private printResults(): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 MIGRATION RESULTS');
    console.log('='.repeat(60));

    if (this.dryRun) {
      console.log('🔍 DRY RUN - No actual changes made');
    }

    console.log(`Total contexts: ${this.stats.total}`);
    console.log(`Processed: ${this.stats.processed}`);
    console.log(`✅ Successful: ${this.stats.successful}`);
    console.log(`❌ Failed: ${this.stats.failed}`);
    console.log(`⏭️  Skipped: ${this.stats.skipped}`);

    if (this.stats.errors.length > 0) {
      console.log(`\n❌ ERRORS (${this.stats.errors.length}):`);
      this.stats.errors.forEach((error, index) => {
        console.log(`${index + 1}. Context ${error.contextId}: ${error.error}`);
      });
    }

    if (this.stats.successful > 0) {
      const successRate = Math.round((this.stats.successful / this.stats.processed) * 100);
      console.log(`\n🎉 Success rate: ${successRate}%`);

      if (!this.dryRun) {
        console.log(`✅ ${this.stats.successful} contexts now have embeddings!`);
      }
    }

    console.log('='.repeat(60));
  }

  /**
   * Run the embeddings migration
   */
  async runMigration(): Promise<void> {
    const startTime = Date.now();

    console.log('🚀 Starting AIDIS Embeddings Migration...');
    if (this.dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made to the database');
    }
    console.log(`📦 Batch size: ${this.batchSize}`);
    console.log('');

    try {
      // Initialize database connection
      await initializeDatabase();
      console.log('✅ Database connection established');

      // Test embedding service health
      const serviceHealthy = await this.testEmbeddingService();
      if (!serviceHealthy) {
        throw new Error('Embedding service is not ready');
      }

      // Get contexts needing embeddings
      const contexts = await getContextsNeedingEmbeddings();
      if (contexts.length === 0) {
        console.log('🎉 All contexts already have embeddings!');
        return;
      }

      this.stats.total = contexts.length;

      // Process contexts in batches
      for (let i = 0; i < contexts.length; i += this.batchSize) {
        const batch = contexts.slice(i, i + this.batchSize);
        console.log(`\n📦 Batch ${Math.floor(i / this.batchSize) + 1}/${Math.ceil(contexts.length / this.batchSize)}`);

        await this.processBatch(batch);

        // Add small delay between batches to be gentle on the system
        if (i + this.batchSize < contexts.length) {
          console.log('⏸️  Pausing 2 seconds between batches...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Print final results
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n⏱️  Total migration time: ${duration} seconds`);

      this.printResults();

      if (this.stats.failed === 0) {
        console.log('\n🎉 Migration completed successfully!');
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
const migration = new EmbeddingMigration({
  dryRun: isDryRun,
  batchSize: Math.max(1, Math.min(50, batchSize)) // Limit batch size between 1-50
});

// Fix the missing function
async function getContextsNeedingEmbeddings(): Promise<Context[]> {
  console.log('🔍 Finding contexts that need embeddings...');

  const query = `
    SELECT
      id,
      content,
      context_type,
      project_id,
      session_id
    FROM contexts
    WHERE embedding IS NULL
    ORDER BY created_at ASC
  `;

  const result = await db.query(query);
  console.log(`📊 Found ${result.rows.length} contexts needing embeddings`);

  return result.rows;
}

// Run migration if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migration.runMigration()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { EmbeddingMigration };