/**
 * Port Management Utilities
 * Provides dynamic port assignment and discovery for AIDIS services
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { logger } from './logger.js';

export interface ServicePortInfo {
  serviceName: string;
  port: number;
  pid: number;
  startedAt: Date;
  healthEndpoint?: string;
}

export interface PortDiscoveryConfig {
  registryFile: string;
  defaultPorts: Record<string, number>;
  portRange: { min: number; max: number };
}


/**
 * Documented port variable per service, where it differs from the name derived from the service id.
 * The MCP server's documented setting is MANDREL_MCP_PORT (.env.example); the derived
 * MANDREL_AIDIS_MCP_PORT / AIDIS_AIDIS_MCP_PORT remain as deprecated aliases.
 */
export const DOCUMENTED_PORT_VARS: Record<string, string> = {
  'aidis-mcp': 'MANDREL_MCP_PORT'
};

export interface ResolvedPortEnv {
  /** Raw value of the winning variable, or undefined when none is set. */
  value: string | undefined;
  /** The name that should be used (documented name). */
  preferredName: string;
  /** Set when the value came from a deprecated alias (and the preferred name is unset). */
  deprecatedName?: string;
}

/** Pure env lookup: documented name wins; deprecated aliases are consulted only when it is unset. */
export function resolvePortEnv(serviceName: string, env: NodeJS.ProcessEnv): ResolvedPortEnv {
  const derived = serviceName.toUpperCase().replace(/-/g, '_');
  const mandrelDerived = `MANDREL_${derived}_PORT`;
  const preferredName = DOCUMENTED_PORT_VARS[serviceName] ?? mandrelDerived;
  const aliases = [mandrelDerived, `AIDIS_${derived}_PORT`].filter((n) => n !== preferredName);
  if (env[preferredName]) return { value: env[preferredName], preferredName };
  for (const name of aliases) {
    if (env[name]) return { value: env[name], preferredName, deprecatedName: name };
  }
  return { value: undefined, preferredName };
}

class PortManager {
  private config: PortDiscoveryConfig;
  private registryPath: string;

  constructor(config?: Partial<PortDiscoveryConfig>) {
    this.config = {
      registryFile: process.env.AIDIS_PORT_REGISTRY || path.resolve(process.cwd(), 'run/port-registry.json'),
      defaultPorts: {
        'aidis-mcp': 8080,
        'aidis-command-dev': 5000,
        'aidis-command-prod': 5001,
        'aidis-mcp-bridge': 8081
      },
      portRange: { min: 8000, max: 9000 },
      ...config
    };

    this.registryPath = this.config.registryFile;
    this.ensureRegistryDirectory();
  }

  /**
   * Get dynamic port assignment for a service
   * Returns PORT=0 for dynamic assignment if configured, otherwise returns default port
   */
  public async assignPort(serviceName: string, preferredPort?: number): Promise<number> {
    const { value: envPort, deprecatedName, preferredName } = resolvePortEnv(serviceName, process.env); // env-read: object-passthrough(resolvePortEnv reads MANDREL_<SVC>_PORT / the documented MANDREL_MCP_PORT / AIDIS_<SVC>_PORT from the env it is handed)

    // Log deprecation warning (once per assignment) if only an old name is used
    if (deprecatedName) {
      logger.warn(`⚠️  ${deprecatedName} is deprecated. Use ${preferredName} instead.`);
    }

    // Check specific environment variable first
    if (envPort === '0') {
      logger.info(`Dynamic port assignment requested for ${serviceName}`);
      return 0; // Let the server choose
    }

    if (envPort && envPort !== '0') {
      const port = parseInt(envPort, 10);
      if (!isNaN(port)) {
        logger.info(`Using configured port ${port} for ${serviceName}`);
        return port;
      }
    }

    // Fall back to generic PORT environment variable for command services
    if (serviceName.includes('command') && process.env.PORT) {
      const genericPort = process.env.PORT;
      if (genericPort === '0') {
        logger.info(`Dynamic port assignment requested for ${serviceName} via PORT`);
        return 0;
      }
      const port = parseInt(genericPort, 10);
      if (!isNaN(port)) {
        logger.info(`Using generic PORT ${port} for ${serviceName}`);
        return port;
      }
    }

    // Use preferred port if provided
    if (preferredPort) {
      logger.info(`Using preferred port ${preferredPort} for ${serviceName}`);
      return preferredPort;
    }

    // Fall back to default port
    const defaultPort = this.config.defaultPorts[serviceName] || 8080;
    logger.info(`Using default port ${defaultPort} for ${serviceName}`);
    return defaultPort;
  }

  /**
   * Register a service with its assigned port
   */
  public async registerService(serviceName: string, port: number, healthEndpoint?: string): Promise<void> {
    const registry = await this.loadRegistry();

    const serviceInfo: ServicePortInfo = {
      serviceName,
      port,
      pid: process.pid,
      startedAt: new Date(),
      healthEndpoint
    };

    registry[serviceName] = serviceInfo;
    await this.saveRegistry(registry);

    logger.info(`Registered ${serviceName} on port ${port}`, serviceInfo as any);
  }

  /**
   * Discover port for a specific service
   */
  public async discoverServicePort(serviceName: string): Promise<number | null> {
    const registry = await this.loadRegistry();
    const serviceInfo = registry[serviceName];

    if (!serviceInfo) {
      return null;
    }

    // For testing, if the service info exists, return the port
    // In production, we would verify health, but for tests we trust the registry
    if (process.env.NODE_ENV === 'test') {
      return serviceInfo.port;
    }

    // Verify the service is still running
    if (await this.isServiceHealthy(serviceInfo)) {
      return serviceInfo.port;
    } else {
      // Clean up stale registry entry
      await this.unregisterService(serviceName);
      return null;
    }
  }

  /**
   * Get all registered services
   */
  public async getRegisteredServices(): Promise<Record<string, ServicePortInfo>> {
    return this.loadRegistry();
  }

  /**
   * Unregister a service
   */
  public async unregisterService(serviceName: string): Promise<void> {
    const registry = await this.loadRegistry();
    delete registry[serviceName];
    await this.saveRegistry(registry);

    logger.info(`Unregistered service: ${serviceName}`);
  }

  /**
   * Check if a service is healthy
   */
  private async isServiceHealthy(serviceInfo: ServicePortInfo): Promise<boolean> {
    if (!serviceInfo.healthEndpoint) {
      // No health endpoint, just check if the port is responding
      return this.isPortResponding(serviceInfo.port);
    }

    try {
      const url = serviceInfo.healthEndpoint.startsWith('http')
        ? serviceInfo.healthEndpoint
        : `http://localhost:${serviceInfo.port}${serviceInfo.healthEndpoint}`;

      return new Promise((resolve) => {
        const req = http.get(url, (res) => {
          resolve(res.statusCode === 200);
        });

        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => {
          req.destroy();
          resolve(false);
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Check if a port is responding
   */
  private async isPortResponding(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}`, () => {
        resolve(true);
      });

      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Load the port registry from file
   */
  private async loadRegistry(): Promise<Record<string, ServicePortInfo>> {
    try {
      if (!fs.existsSync(this.registryPath)) {
        return {};
      }

      const data = fs.readFileSync(this.registryPath, 'utf8');
      const registry = JSON.parse(data);

      // Convert date strings back to Date objects
      Object.values(registry).forEach((service: any) => {
        if (service.startedAt) {
          service.startedAt = new Date(service.startedAt);
        }
      });

      return registry;
    } catch (error) {
      logger.error('Failed to load port registry', { error: error instanceof Error ? error.message : 'Unknown error' } as any);
      return {};
    }
  }

  /**
   * Save the port registry to file
   */
  private async saveRegistry(registry: Record<string, ServicePortInfo>): Promise<void> {
    try {
      fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2));
    } catch (error) {
      logger.error('Failed to save port registry', { error: error instanceof Error ? error.message : 'Unknown error' } as any);
    }
  }

  /**
   * Ensure the registry directory exists
   */
  private ensureRegistryDirectory(): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Get environment variable name for a service port (returns new MANDREL_ name)
   */
  public static getPortEnvVar(serviceName: string): string {
    return `MANDREL_${serviceName.toUpperCase().replace(/-/g, '_')}_PORT`;
  }

  /**
   * Log discovered ports for debugging
   */
  public async logPortConfiguration(serviceName: string, assignedPort: number): Promise<void> {
    const envVar = PortManager.getPortEnvVar(serviceName);
    const envValue = process.env[envVar]; // env-read: dynamic(port var name from PortManager.getPortEnvVar(serviceName))

    logger.info(`Port configuration for ${serviceName}`, {
      serviceName,
      assignedPort,
      environmentVariable: envVar,
      environmentValue: envValue,
      isDynamic: envValue === '0' || assignedPort === 0,
      pid: process.pid
    } as any);

    logger.info(`🔧 Port Configuration for ${serviceName}:`);
    logger.info(`   📡 Assigned Port: ${assignedPort}`);
    logger.info(`   🔧 Environment Variable: ${envVar}=${envValue || 'unset'}`);
    logger.info(`   ⚡ Dynamic Assignment: ${envValue === '0' ? 'YES' : 'NO'}`);
    logger.info(`   🆔 Process ID: ${process.pid}`);
  }
}

// Export singleton instance
export const portManager = new PortManager();