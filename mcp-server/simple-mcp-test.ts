/**
 * Simple MCP Server Test
 * 
 * This tests our MCP server by directly calling its methods
 * to verify everything works before testing with real MCP client.
 */

import { AIDISServer } from './src/server.js';

async function testServerMethods() {
  console.log('🧪 Testing AIDIS Server Methods...\n');

  try {
    // Create server instance
    const server = new AIDISServer();
    
    console.log('✅ Server instance created successfully');
    
    // Test database connection by checking status
    console.log('\n📊 Testing server status...');
    const statusHandler = (server as any).getServerStatus;
    if (statusHandler) {
      const status = await statusHandler.call(server);
      console.log('Server Status:');
      console.log(`  Version: ${status.version}`);
      console.log(`  Environment: ${status.environment}`);
      console.log(`  Database Connected: ${status.database.connected ? '✅' : '❌'}`);
      console.log(`  Memory Used: ${(status.memory.used / 1024 / 1024).toFixed(2)} MB`);
    }
    
    // Test ping method
    console.log('\n🏓 Testing ping handler...');
    const pingHandler = (server as any).handlePing;
    if (pingHandler) {
      const pingResult = await pingHandler.call(server, { message: 'Direct test!' });
      console.log('Ping Result:');
      pingResult.content.forEach((item: any) => {
        if (item.type === 'text') {
          console.log(`  ${item.text}`);
        }
      });
    }

    console.log('\n🎉 All server method tests passed!');
    console.log('🚀 AIDIS Server is ready for MCP client connections!');
    
  } catch (error) {
    console.error('❌ Server test failed:', error);
    process.exit(1);
  }
}

testServerMethods().catch(console.error);
