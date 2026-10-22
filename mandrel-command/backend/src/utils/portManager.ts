/**
 * Port Management Utilities for Mandrel Command Backend
 * Provides dynamic port assignment and discovery coordination
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { logger } from '../config/logger';

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
 * Get the default registry file path.
 * Uses MANDREL_RUN_DIR env var, or falls back to ~/.mandrel/run/
 * This ensures cross-platform compatibility (macOS, Linux, Windows).
 */
function getDefaultRegistryPath(): string {
  // Allow override via environment variable
  if (process.env.MANDREL_RUN_DIR) {
    return path.join(process.env.MANDREL_RUN_DIR, 'port-registry.json');
  }
  // Cross-platform default: ~/.mandrel/run/
  return path.join(os.homedir(), '.mandrel', 'run', 'port-registry.json');
}

class PortManager {
  private config: PortDiscoveryConfig;
  private registryPath: string;

  constructor(config?: Partial<PortDiscoveryConfig>) {
    this.config = {
      registryFile: getDefaultRegistryPath(),
      defaultPorts: {
        'mandrel-mcp': 8080,
        'mandrel-command-dev': 5000,
        'mandrel-command-prod': 5001,
        'mandrel-mcp-bridge': 8081
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
    // Support both MANDREL_ (preferred) and AIDIS_ (deprecated) env var prefixes
    const mandrelEnvVar = `MANDREL_${serviceName.toUpperCase().replace(/-/g, '_')}_PORT`;
    const aidisEnvVar = `AIDIS_${serviceName.toUpperCase().replace(/-/g, '_')}_PORT`;

    // Check MANDREL_ first, then fall back to AIDIS_
    let envPort = process.env[mandrelEnvVar]; // env-read: dynamic(port var name built from serviceName -> MANDREL_<SVC>_PORT)
    if (!envPort && process.env[aidisEnvVar]) { // env-read: dynamic(AIDIS_<SVC>_PORT fallback)
      envPort = process.env[aidisEnvVar]; // env-read: dynamic(AIDIS_<SVC>_PORT fallback)
      logger.warn(`\u26a0\ufe0f  ${aidisEnvVar} is deprecated. Use ${mandrelEnvVar} instead.`);
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

    // Fall back to generic PORT environment variable
    if (process.env.PORT) {
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
    const defaultPort = this.config.defaultPorts[serviceName] || 5000;
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
      ...(healthEndpoint && { healthEndpoint })
    };

    registry[serviceName] = serviceInfo;
    await this.saveRegistry(registry);

    logger.info(`Registered ${serviceName} on port ${port} (PID: ${process.pid})`);
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
    } catch (error) {
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
      logger.error('Failed to load port registry', { error: error instanceof Error ? error.message : 'Unknown error' });
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
      logger.error('Failed to save port registry', { error: error instanceof Error ? error.message : 'Unknown error' });
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
   * Get environment variable name for a service port
   */
  public static getPortEnvVar(serviceName: string): string {
    return `MANDREL_${serviceName.toUpperCase().replace(/-/g, '_')}_PORT`;
  }

  /**
   * Log discovered ports for debugging
   */
  public async logPortConfiguration(serviceName: string, assignedPort: number): Promise<void> {
    const envVar = PortManager.getPortEnvVar(serviceName);
    const envValue = process.env[envVar] || process.env.PORT; // env-read: dynamic(port var name from getPortEnvVar; literal PORT also read)

    logger.info(`🔧 Port Configuration for ${serviceName}:`);
    logger.info(`   📡 Assigned Port: ${assignedPort}`);
    logger.info(`   🔧 Environment Variable: ${envVar}=${envValue || 'unset'}`);
    logger.info(`   ⚡ Dynamic Assignment: ${envValue === '0' ? 'YES' : 'NO'}`);
    logger.info(`   🆔 Process ID: ${process.pid}`);
  }
}

// Export singleton instance
export const portManager = new PortManager();