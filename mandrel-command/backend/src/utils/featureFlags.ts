import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger';

export interface FeatureFlagConfig {
  version: number;
  updatedAt?: string;
  flags: Record<string, boolean>;
  overrides?: Record<string, boolean>;
}

// Helper function to get environment variable with MANDREL_ prefix and AIDIS_ fallback
function getEnvVar(mandrelKey: string, aidisKey: string, defaultValue: string = ''): string {
  const value = process.env[mandrelKey] || process.env[aidisKey] || defaultValue; // env-read: via-callers

  // Log deprecation warning if old var is used
  if (process.env[aidisKey] && !process.env[mandrelKey]) { // env-read: via-callers
    logger.warn(`⚠️  ${aidisKey} is deprecated. Use ${mandrelKey} instead.`);
  }
  
  return value;
}

const DEFAULT_REFRESH_INTERVAL = parseInt(getEnvVar('MANDREL_FEATURE_FLAG_REFRESH_MS', 'AIDIS_FEATURE_FLAG_REFRESH_MS', '5000'), 10);
const DEFAULT_CONFIG_PATH = getEnvVar('MANDREL_FEATURE_FLAG_PATH', 'AIDIS_FEATURE_FLAG_PATH')
  ? path.resolve(getEnvVar('MANDREL_FEATURE_FLAG_PATH', 'AIDIS_FEATURE_FLAG_PATH'))
  : path.resolve(process.cwd(), '../..', 'config', 'feature-flags.json');

function loadOverridesFromEnv(): Record<string, boolean> {
  const raw = getEnvVar('MANDREL_FEATURE_FLAG_OVERRIDES', 'AIDIS_FEATURE_FLAG_OVERRIDES');
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return Object.entries(parsed).reduce<Record<string, boolean>>((acc, [key, value]) => {
      acc[String(key)] = Boolean(value);
      return acc;
    }, {});
  } catch (error) {
    logger.warn('[FeatureFlags] Failed to parse MANDREL_FEATURE_FLAG_OVERRIDES env var', { error });
    return {};
  }
}

async function readConfig(configPath: string): Promise<FeatureFlagConfig | null> {
  try {
    const file = await fs.promises.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(file) as FeatureFlagConfig;
    parsed.flags = parsed.flags || {};
    return parsed;
  } catch (error) {
    logger.warn(`[FeatureFlags] Unable to read config at ${configPath}`, { error });
    return null;
  }
}

class FeatureFlagStore {
  private configPath: string;
  private flags: Record<string, boolean> = {};
  private refreshInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private version: number | null = null;
  private updatedAt: string | null = null;

  constructor(configPath: string = DEFAULT_CONFIG_PATH, refreshInterval = DEFAULT_REFRESH_INTERVAL) {
    this.configPath = configPath;
    this.refreshInterval = refreshInterval;
  }

  async initialize(): Promise<void> {
    await this.refresh();
    if (this.refreshInterval > 0) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, this.refreshInterval);
      // .unref() — a 5s config-refresh poller must never be the reason a process stays
      // alive. `ensureFeatureFlags()` is called at module scope by server.ts, so ANY
      // short-lived process that imports the server graph inherited a permanent
      // event-loop hold. An unref'd interval still fires on schedule; the running
      // server's loop is held by app.listen.
      // Exercised by src/__tests__/idlePoolReleasesEventLoop.db.test.ts.
      this.timer.unref();
    }
  }

  async refresh(): Promise<void> {
    const config = await readConfig(this.configPath);
    if (!config) {
      return;
    }

    const envOverrides = loadOverridesFromEnv();
    const combined = {
      ...config.flags,
      ...(config.overrides || {}),
      ...envOverrides,
    };

    this.flags = combined;
    this.version = typeof config.version === 'number' ? config.version : null;
    this.updatedAt = config.updatedAt ?? null;
  }

  getFlag(name: string, defaultValue = false): boolean {
    return Object.prototype.hasOwnProperty.call(this.flags, name)
      ? this.flags[name]
      : defaultValue;
  }

  getAllFlags(): Record<string, boolean> {
    return { ...this.flags };
  }

  getMetadata(): { version: number | null; updatedAt: string | null } {
    return {
      version: this.version,
      updatedAt: this.updatedAt,
    };
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

const featureFlagStore = new FeatureFlagStore();
let initialized = false;

export async function ensureFeatureFlags(): Promise<FeatureFlagStore> {
  if (!initialized) {
    await featureFlagStore.initialize();
    initialized = true;
  }
  return featureFlagStore;
}

export default featureFlagStore;
