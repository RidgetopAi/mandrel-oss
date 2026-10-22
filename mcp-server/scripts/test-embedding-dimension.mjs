#!/usr/bin/env node

import { db, initializeDatabase } from '../dist/config/database.js';
import { embeddingService } from '../dist/services/embedding.js';

async function testDimensions() {
  try {
    await initializeDatabase();
    console.log('✅ Database initialized\n');
    
    // Test 1: Generate a new embedding
    console.log('🧪 Test 1: Generate new embedding');
    const result = await embeddingService.generateEmbedding({ 
      text: 'This is a test to verify embeddings are 1536 dimensions' 
    });
    console.log(`   ✅ Generated embedding: ${result.dimensions}D (expected 1536)`);
    console.log(`   ✅ Actual length: ${result.embedding.length}`);
    console.log(`   ✅ Model: ${result.model}\n`);
    
    // Test 2: Verify normalization (unit vector)
    const norm = Math.sqrt(result.embedding.reduce((sum, val) => sum + val * val, 0));
    console.log(`🧪 Test 2: Verify unit normalization`);
    console.log(`   ✅ Vector magnitude: ${norm.toFixed(6)} (should be ~1.0)`);
    console.log(`   ${Math.abs(norm - 1.0) < 0.0001 ? '✅' : '❌'} Unit normalization ${Math.abs(norm - 1.0) < 0.0001 ? 'PASSED' : 'FAILED'}\n`);
    
    // Test 3: Try to insert into database
    console.log(`🧪 Test 3: Insert into database`);
    const testId = '00000000-0000-0000-0000-000000000001';
    await db.query(
      `INSERT INTO contexts (id, context_type, content, embedding) 
       VALUES ($1, 'code', 'dimension test', $2::vector) 
       ON CONFLICT (id) DO UPDATE SET embedding = $2::vector`,
      [testId, JSON.stringify(result.embedding)]
    );
    console.log(`   ✅ Successfully inserted 1536D embedding\n`);
    
    // Test 4: Retrieve and verify
    console.log(`🧪 Test 4: Retrieve and verify`);
    const retrieved = await db.query(
      "SELECT (length(embedding::text) - length(replace(embedding::text, ',', ''))) + 1 as dims FROM contexts WHERE id = $1",
      [testId]
    );
    console.log(`   ✅ Retrieved embedding dimensions: ${retrieved.rows[0].dims}\n`);
    
    // Test 5: Check all embeddings in database
    console.log(`🧪 Test 5: Verify all database embeddings`);
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total_contexts,
        COUNT(embedding) as with_embeddings,
        COUNT(*) - COUNT(embedding) as null_embeddings,
        MIN((length(embedding::text) - length(replace(embedding::text, ',', ''))) + 1) as min_dims,
        MAX((length(embedding::text) - length(replace(embedding::text, ',', ''))) + 1) as max_dims
      FROM contexts
    `);
    console.log(`   Total contexts: ${stats.rows[0].total_contexts}`);
    console.log(`   With embeddings: ${stats.rows[0].with_embeddings}`);
    console.log(`   NULL embeddings: ${stats.rows[0].null_embeddings}`);
    console.log(`   Dimension range: ${stats.rows[0].min_dims} - ${stats.rows[0].max_dims}`);
    console.log(`   ${stats.rows[0].min_dims === '1536' && stats.rows[0].max_dims === '1536' ? '✅' : '❌'} All embeddings are 1536D\n`);
    
    // Cleanup test record
    await db.query('DELETE FROM contexts WHERE id = $1', [testId]);
    
    console.log('✅ All dimension tests PASSED!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testDimensions();
