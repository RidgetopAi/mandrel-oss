# AIDIS MCP HTTP Adapter

**Production-ready HTTP protocol adapter for AIDIS Core Service**

This adapter bridges Claude Code (MCP STDIO) to AIDIS Core Service (HTTP API), enabling Claude Code to access all 41 AIDIS tools through a clean HTTP interface.

## Architecture

```
Claude Code (MCP) → mcp-http-adapter (STDIO↔HTTP) → AIDIS Core Service (HTTP API)
```

## Features

✅ **Dynamic Tool Discovery** - Automatically discovers all available tools from core service  
✅ **Environment Configuration** - Configurable via environment variables  
✅ **Robust Error Handling** - Retry logic with exponential backoff  
✅ **Connection Management** - Health monitoring and circuit breaker patterns  
✅ **TypeScript Support** - Full type safety and validation  
✅ **Zero Configuration** - Works out of the box with sensible defaults  
✅ **Compatible** - Drop-in replacement for existing MCP bridges  

## Quick Start

### Installation

```bash
npm install @aidis/mcp-adapter-http
```

### Claude Code Configuration

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "aidis-http-adapter": {
      "command": "npx",
      "args": ["tsx", "/path/to/aidis/adapters/mcp-http-adapter.ts"],
      "env": {
        "MANDREL_URL": "http://localhost:8080",
        "MANDREL_DEBUG": "false"
      }
    }
  }
}
```

### Direct Usage

```bash
# Development mode
npx tsx mcp-http-adapter.ts

# Production mode
npm run build
npm start
```

## Configuration

Configure the adapter using environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MANDREL_URL` | `http://localhost:8080` | AIDIS Core Service URL |
| `MANDREL_TIMEOUT` | `30000` | Request timeout in milliseconds |
| `MANDREL_RETRIES` | `3` | Maximum retry attempts |
| `MANDREL_DEBUG` | `false` | Enable debug logging |

## Available Tools

The adapter dynamically discovers all tools from the AIDIS Core Service. Currently supports 41 tools across 8 categories:

### System Health (3 tools)
- `mandrel_ping` - Test connectivity 
- `mandrel_status` - Get system status
- `mandrel_help` - List all tools

### Navigation (2 tools)  
- `mandrel_explain` - Get detailed tool help
- `mandrel_examples` - Get usage examples

### Context Management (4 tools)
- `context_store` - Store development context
- `context_search` - Search contexts semantically  
- `context_get_recent` - Get recent contexts
- `context_stats` - Get storage statistics

### Project Management (6 tools)
- `project_list` - List all projects
- `project_create` - Create new project
- `project_switch` - Switch active project  
- `project_current` - Get current project
- `project_info` - Get project details
- `project_insights` - Get project analytics

### Naming Registry (4 tools)
- `naming_register` - Register names
- `naming_check` - Check conflicts
- `naming_suggest` - Get suggestions
- `naming_stats` - Get registry stats

### Decision Tracking (4 tools)
- `decision_record` - Record decisions
- `decision_search` - Search decisions
- `decision_update` - Update outcomes
- `decision_stats` - Get analytics

### Multi-Agent Coordination (11 tools)
- `agent_register`, `agent_list`, `agent_status`
- `agent_join`, `agent_leave`, `agent_sessions`
- `agent_message`, `agent_messages`
- `task_create`, `task_list`, `task_update`

### Code Analysis (5 tools)
- `code_analyze` - Analyze file structure
- `code_components` - List components
- `code_dependencies` - Analyze dependencies
- `code_impact` - Assess change impact
- `code_stats` - Get code statistics

### Smart Search & AI (2 tools)
- `smart_search` - Cross-system intelligent search
- `get_recommendations` - Get AI recommendations

## Error Handling

The adapter includes comprehensive error handling:

- **Connection Failures** - Automatic retry with exponential backoff
- **Timeout Management** - Configurable request timeouts
- **Health Monitoring** - Periodic health checks with circuit breaker
- **Graceful Degradation** - Cached tool lists during temporary failures
- **MCP Error Mapping** - HTTP errors converted to proper MCP error codes

## Development

### Testing

Run the comprehensive test suite:

```bash
npm test
```

Test individual components:

```bash
# Test adapter connection
npx tsx ../test-adapter-connection.ts

# Full integration test  
npx tsx ../test-http-adapter.ts
```

### Building

```bash
npm run build
```

### Type Checking

```bash
npm run type-check
```

## Architecture Details

### Connection Manager
- Maintains persistent connection to AIDIS Core Service
- Implements health checks and circuit breaker patterns
- Caches tool discovery results for performance
- Handles connection recovery and failover

### HTTP Client
- Robust HTTP client with retry logic
- Supports both HTTP and HTTPS protocols
- Configurable timeouts and retry policies
- Proper error handling and reporting

### MCP Integration  
- Full compatibility with MCP protocol specification
- Dynamic tool registration from core service
- Proper request/response mapping
- Error translation between HTTP and MCP domains

## Troubleshooting

### Connection Issues

Check AIDIS Core Service status:
```bash
curl http://localhost:8080/healthz
```

Verify tool discovery:
```bash
curl http://localhost:8080/mcp/tools
```

### Debug Mode

Enable detailed logging:
```bash
export MANDREL_DEBUG=true
npx tsx mcp-http-adapter.ts
```

### Common Issues

1. **"AIDIS Core Service is unavailable"**
   - Ensure AIDIS Core Service is running on configured port
   - Check firewall settings and network connectivity

2. **"Tool execution timeout"**  
   - Increase `MANDREL_TIMEOUT` environment variable
   - Check AIDIS Core Service performance

3. **"Circuit breaker is OPEN"**
   - Multiple failures detected, wait for recovery period
   - Check AIDIS Core Service health and logs

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Run the test suite
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

- **Issues**: Report bugs on GitHub Issues
- **Documentation**: See AIDIS documentation  
- **Community**: Join the AIDIS Discord server

---

**Part of Oracle's AIDIS Architecture Redesign - Week 2 Deliverable**
