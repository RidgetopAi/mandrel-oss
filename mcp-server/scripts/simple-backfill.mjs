#!/usr/bin/env node

import { db, initializeDatabase } from '../dist/config/database.js';
import { embeddingService } from '../dist/services/embedding.js';

async function backfill() {
  try {
    await initializeDatabase();
    console.log('✅ Database initialized');
    
    const result = await db.query('SELECT id, content FROM contexts WHERE embedding IS NULL');
    console.log(`📊 Found ${result.rows.length} contexts with NULL embeddings`);
    
    for (const row of result.rows) {
      try {
        const textToEmbed = row.content.substring(0, 8000);
        console.log(`\n🔄 Processing ${row.id}...`);
        console.log(`   Content length: ${row.content.length} -> ${textToEmbed.length} (truncated)`);
        
        const embedding = await embeddingService.generateEmbedding({ text: textToEmbed });
        console.log(`   Generated ${embedding.dimensions}D embedding`);
        
        await db.query('UPDATE contexts SET embedding = $1 WHERE id = $2',
          [JSON.stringify(embedding.embedding), row.id]);
        
        console.log(`   ✅ Updated context ${row.id}`);
      } catch (error) {
        console.error(`   ❌ Failed to process ${row.id}:`, error.message);
      }
    }
    
    console.log('\n✅ Backfill complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  }
}

backfill();
