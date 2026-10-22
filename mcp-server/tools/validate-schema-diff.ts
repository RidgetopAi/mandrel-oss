#!/usr/bin/env tsx
/**
 * ORACLE SCHEMA VALIDATION SCRIPT
 * Compares MCP JSON Schema definitions with Zod validation schemas
 * to identify parameter mapping mismatches
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface SchemaDiff {
  tool: string;
  missingInValidation: string[];
  extraneousInValidation: string[];
  enumMismatches: Record<string, { server: string[], validation: string[] }>;
}

// Extract server.ts inputSchema definitions
function extractServerSchemas(): Record<string, any> {
  const serverPath = join(__dirname, '../src/server.ts');
  const serverContent = readFileSync(serverPath, 'utf-8');
  
  const schemas: Record<string, any> = {};
  
  // Find all inputSchema definitions
  const inputSchemaRegex = /inputSchema:\s*{([^}]+)}/g;
  const toolNameRegex = /name:\s*["']([^"']+)["']/g;
  
  let match;
  const schemaMatches: string[] = [];
  
  while ((match = inputSchemaRegex.exec(serverContent)) !== null) {
    schemaMatches.push(match[1]);
  }
  
  // Find tool names
  const toolNames: string[] = [];
  let toolMatch;
  while ((toolMatch = toolNameRegex.exec(serverContent)) !== null) {
    toolNames.push(toolMatch[1]);
  }
  
  console.log(`Found ${toolNames.length} tools in server.ts`);
  console.log('Tools:', toolNames);
  
  return schemas;
}

// Extract validation.ts Zod schemas
function extractValidationSchemas(): Record<string, any> {
  const validationPath = join(__dirname, '../src/middleware/validation.ts');
  const validationContent = readFileSync(validationPath, 'utf-8');
  
  const schemas: Record<string, any> = {};
  
  // Look for schema definitions
  const schemaRegex = /(\w+):\s*z\.object\({([^}]+)}\)/g;
  
  let match;
  while ((match = schemaRegex.exec(validationContent)) !== null) {
    const schemaName = match[1];
    const schemaBody = match[2];
    schemas[schemaName] = schemaBody;
  }
  
  console.log('Validation schemas found:', Object.keys(schemas));
  return schemas;
}

// Main analysis function
function analyzeSchemas(): SchemaDiff[] {
  console.log('🔍 Analyzing AIDIS MCP Schema Differences...\n');
  
  const serverSchemas = extractServerSchemas();
  const validationSchemas = extractValidationSchemas();
  
  const diffs: SchemaDiff[] = [];
  
  // Known problematic tools from ORACLE.md
  const knownBrokenTools = [
    'naming_check', 'naming_suggest', 'decision_record', 'decision_update',
    'context_store', 'project_info', 'smart_search', 'get_recommendations',
    'project_insights', 'code_analyze', 'agent_register', 'agent_message'
  ];
  
  console.log('🚨 Known broken tools to investigate:');
  knownBrokenTools.forEach((tool, i) => {
    console.log(`   ${i + 1}. ${tool}`);
  });
  
  return diffs;
}

// Read actual validation schemas from file
function readValidationSchemas() {
  const validationPath = join(__dirname, '../src/middleware/validation.ts');
  const content = readFileSync(validationPath, 'utf-8');
  
  console.log('\n📋 Current validation.ts schemas:');
  console.log('─'.repeat(50));
  
  // Extract individual schema definitions
  const schemaBlocks = content.match(/\w+Schema:\s*z\.object\({[\s\S]*?}\)/g) || [];
  
  schemaBlocks.forEach(block => {
    const name = block.match(/(\w+)Schema:/)?.[1];
    console.log(`\n🔧 ${name}Schema:`);
    console.log(block.substring(0, 200) + '...');
  });
}

// Main execution
if (require.main === module) {
  try {
    const diffs = analyzeSchemas();
    readValidationSchemas();
    
    console.log('\n✅ Schema analysis complete');
    console.log(`Found ${diffs.length} schema differences`);
    
    process.exit(diffs.length === 0 ? 0 : 1);
  } catch (error) {
    console.error('❌ Schema analysis failed:', error);
    process.exit(1);
  }
}
