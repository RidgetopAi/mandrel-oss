#!/usr/bin/env node

// Redirect console to stderr in MCP mode - FIRST PRIORITY
if (process.env.AMP_CONNECTING === 'true' || process.env.AIDIS_FORCE_STDIO === 'true') {
  const toStderr = (...args: any[]) => {
    try {
      const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
      process.stderr.write(line);
    } catch {}
  };
  console.log = toStderr as any;
  console.info = toStderr as any;
  console.warn = toStderr as any;
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

// Create server exactly like successful ones
const server = new Server(
  {
    name: 'aidis-simple',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {
        listChanged: false
      },
    },
  }
);

// Add simple tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log('[DEBUG] ListTools requested - SUCCESS!');
  return {
    tools: [
      {
        name: 'aidis_ping',
        description: 'Test AIDIS connectivity',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Test message' }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'aidis_ping') {
    return {
      content: [
        { type: 'text' as const, text: `AIDIS Simple: ${request.params.arguments?.message || 'Connected!'}` }
      ]
    };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Connect transport immediately
const transport = new StdioServerTransport();
server.connect(transport);

console.log('AIDIS Simple server ready');
