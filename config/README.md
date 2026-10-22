# AIDIS Configuration Management

This directory contains centralized configuration files for the AIDIS system following Phase 3 of the Oracle refactor.

## Configuration Load Order

The configuration system uses a hierarchical load order:

1. **Environment-specific file** (highest priority): `/config/environments/.env.{NODE_ENV}`
2. **Environment variables** (overrides everything)
3. **Fallback defaults** (lowest priority)

## Environment Files

### `/config/environments/.env.development`
- Used when `NODE_ENV=development` (default)
- Contains development-friendly defaults
- Fixed ports for easier debugging
- Verbose logging enabled
- All feature flags disabled for stability

### `/config/environments/.env.staging`
- Used when `NODE_ENV=staging`
- Mix of fixed and dynamic ports for testing
- Moderate logging levels
- Feature flags enabled for testing

### `/config/environments/.env.production`
- Used when `NODE_ENV=production`
- Dynamic port assignment (PORT=0)
- Minimal logging for performance
- Conservative feature flag settings

## Required Secrets (Set via Environment Variables)

The following sensitive values MUST be set as environment variables and are NOT included in the config files:

```bash
# Database password (REQUIRED in production)
export MANDREL_DATABASE_PASSWORD="your-secure-password"

# JWT secret for authentication (REQUIRED in production)
export MANDREL_JWT_SECRET="your-randomly-generated-jwt-secret"

# Optional: Database URL (overrides individual components)
export MANDREL_DATABASE_URL="postgresql://user:pass@host:port/db"
```

## Environment Variable Naming Convention

All AIDIS-specific variables use the `MANDREL_` prefix:

- `MANDREL_DATABASE_*` - Database configuration
- `MANDREL_HTTP_PORT` - Main HTTP service port
- `MANDREL_MCP_*` - MCP protocol configuration
- `MANDREL_LOG_*` - Logging configuration
- `MANDREL_FEATURE_FLAG_*` - Feature flag overrides

Legacy variables (without MANDREL_ prefix) are supported as fallbacks for backward compatibility.

## Migration from Local .env Files

### Services Still Using Local .env Files

The following services should be migrated to use centralized config:

1. **`/aidis-command/backend/.env`** - Contains hardcoded credentials (MIGRATED)
2. **`/mcp-server/.env`** - MCP server configuration (MIGRATED)
3. **`/.env`** - Root configuration (MIGRATED)

### Migration Process

1. **Backup existing .env files** before migration
2. **Verify centralized config** loads correctly
3. **Set secrets as environment variables** (not in files)
4. **Test service startup** with centralized config
5. **Remove or rename local .env files** once verified

### Legacy Compatibility

The configuration system maintains backward compatibility:

- Old variable names are checked as fallbacks
- Existing hardcoded defaults are preserved
- Services can gradually migrate without breaking

## Service Integration

### AIDIS Command Backend
- Uses `/config/environments/.env.{NODE_ENV}`
- Implements full hierarchical loading
- Supports both MANDREL_ and legacy variable names

### MCP Server
- Uses centralized configuration for database connection
- Maintains environment variable fallbacks
- Supports MANDREL_ naming convention

## Security Best Practices

1. **Never commit secrets** to version control
2. **Use environment variables** for sensitive data
3. **Rotate secrets regularly** using the procedures in ORACLE_REFACTOR.md
4. **Validate required variables** on startup
5. **Use different secrets** for different environments

## Validation

Services will validate required environment variables on startup and exit if critical variables are missing in production.

## Troubleshooting

### Service Won't Start
1. Check that required secrets are set as environment variables
2. Verify the correct environment file exists for your NODE_ENV
3. Check for typos in variable names (case-sensitive)
4. Review startup logs for validation errors

### Port Conflicts
1. Set `MANDREL_*_PORT=0` for dynamic assignment
2. Check the port registry at `/run/port-registry.json`
3. Ensure no other services are using fixed ports

### Configuration Not Loading
1. Verify file paths in service configuration loaders
2. Check file permissions on config directory
3. Ensure NODE_ENV is set correctly
4. Review hierarchical load order in service logs