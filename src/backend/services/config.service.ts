/**
 * Configuration Service
 *
 * Centralized configuration management for FactoryFactory.
 * Handles environment variables, and runtime configuration.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.service';

const logger = createLogger('config');

/**
 * Expand environment variables in a string.
 * Handles $VAR and ${VAR} syntax, including $USER and other common variables.
 */
function expandEnvVars(value: string): string {
  // Replace $USER with actual home directory username
  let result = value.replace(/\$USER|\$\{USER\}/g, homedir().split('/').pop() || 'user');

  // Replace other environment variables
  result = result.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      // Recursively expand in case env vars reference other env vars
      return expandEnvVars(envValue);
    }
    return match; // Leave unexpanded if not found
  });

  return result;
}

/**
 * Permission modes for sessions
 */
type PermissionMode = 'strict' | 'relaxed' | 'yolo';

/**
 * Session execution profile
 */
export interface SessionProfile {
  model: string;
  permissionMode: PermissionMode;
  maxTokens: number;
  temperature: number;
}

/**
 * System configuration
 */
interface SystemConfig {
  // Directory paths
  baseDir: string;
  worktreeBaseDir: string;
  debugLogDir: string;

  // Server settings
  backendPort: number;
  frontendPort: number;
  nodeEnv: 'development' | 'production' | 'test';

  // Database (SQLite)
  databasePath: string;

  // Inngest
  inngestEventKey?: string;
  inngestSigningKey?: string;

  // Default session profile
  defaultSessionProfile: SessionProfile;

  // Health check settings
  healthCheckIntervalMs: number;

  // Feature flags
  features: {
    authentication: boolean;
    metrics: boolean;
    errorTracking: boolean;
  };
}

/**
 * Model name mapping for environment variable values
 */
const MODEL_MAPPING: Record<string, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-5-20251101',
  haiku: 'claude-3-5-haiku-20241022',
};

/**
 * Resolve model name from environment variable or use default
 */
function resolveModel(envVar: string | undefined, defaultModel: string): string {
  if (!envVar) {
    return defaultModel;
  }

  // Check if it's a known alias
  const mapped = MODEL_MAPPING[envVar.toLowerCase()];
  if (mapped) {
    return mapped;
  }

  // If it looks like a full model name, use it directly
  if (envVar.startsWith('claude-')) {
    return envVar;
  }

  logger.warn(`Unknown model alias: ${envVar}, using default`);
  return defaultModel;
}

/**
 * Resolve permission mode from environment variable
 */
function resolvePermissionMode(
  envVar: string | undefined,
  defaultMode: PermissionMode
): PermissionMode {
  if (!envVar) {
    return defaultMode;
  }

  const normalized = envVar.toLowerCase();
  if (['strict', 'relaxed', 'yolo'].includes(normalized)) {
    return normalized as PermissionMode;
  }

  logger.warn(`Unknown permission mode: ${envVar}, using default`);
  return defaultMode;
}

/**
 * Build default session profile from environment
 */
function buildDefaultSessionProfile(): SessionProfile {
  const defaultModel = 'claude-sonnet-4-5-20250929';

  return {
    model: resolveModel(process.env.DEFAULT_MODEL, defaultModel),
    permissionMode: resolvePermissionMode(process.env.DEFAULT_PERMISSIONS, 'yolo'),
    maxTokens: 8192,
    temperature: 1.0,
  };
}

/**
 * Get default base directory
 */
function getDefaultBaseDir(): string {
  return join(homedir(), 'factory-factory');
}

/**
 * Load system configuration from environment
 */
function loadSystemConfig(): SystemConfig {
  // Expand any environment variables in BASE_DIR (e.g., $USER, $HOME)
  const rawBaseDir = process.env.BASE_DIR;
  const baseDir = rawBaseDir ? expandEnvVars(rawBaseDir) : getDefaultBaseDir();

  // Expand any environment variables in WORKTREE_BASE_DIR
  const rawWorktreeDir = process.env.WORKTREE_BASE_DIR;
  const worktreeBaseDir = rawWorktreeDir
    ? expandEnvVars(rawWorktreeDir)
    : join(baseDir, 'worktrees');

  const config: SystemConfig = {
    // Directory paths
    baseDir,
    worktreeBaseDir,
    debugLogDir: join(baseDir, 'debug'),

    // Server settings
    backendPort: Number.parseInt(process.env.BACKEND_PORT || '3001', 10),
    frontendPort: Number.parseInt(process.env.FRONTEND_PORT || '3000', 10),
    nodeEnv: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',

    // Database (SQLite - defaults to ~/factory-factory/data.db)
    databasePath: process.env.DATABASE_PATH || join(baseDir, 'data.db'),

    // Inngest
    inngestEventKey: process.env.INNGEST_EVENT_KEY,
    inngestSigningKey: process.env.INNGEST_SIGNING_KEY,

    // Default session profile
    defaultSessionProfile: buildDefaultSessionProfile(),

    // Health check settings
    healthCheckIntervalMs: Number.parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '300000', 10), // 5 minutes

    // Feature flags
    features: {
      authentication: process.env.FEATURE_AUTHENTICATION === 'true',
      metrics: process.env.FEATURE_METRICS === 'true',
      errorTracking: process.env.FEATURE_ERROR_TRACKING === 'true',
    },
  };

  return config;
}

/**
 * Configuration Service class
 */
class ConfigService {
  private config: SystemConfig;

  constructor() {
    this.config = loadSystemConfig();
    this.validateConfig();
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    const warnings: string[] = [];
    const errors: string[] = [];

    // SQLite database path is always set (has default), no validation needed

    if (this.config.nodeEnv === 'production') {
      if (!this.config.inngestEventKey) {
        warnings.push('INNGEST_EVENT_KEY is not set (required for production)');
      }
      if (!this.config.inngestSigningKey) {
        warnings.push('INNGEST_SIGNING_KEY is not set (required for production)');
      }
    }

    // Log warnings
    warnings.forEach((w) => logger.warn(w));

    // Throw on errors
    if (errors.length > 0) {
      errors.forEach((e) => logger.error(e));
      if (this.config.nodeEnv === 'production') {
        throw new Error(`Configuration errors: ${errors.join(', ')}`);
      }
    }
  }

  /**
   * Get the full system configuration
   */
  getSystemConfig(): SystemConfig {
    return { ...this.config };
  }

  /**
   * Get the default session profile
   */
  getDefaultSessionProfile(): SessionProfile {
    return { ...this.config.defaultSessionProfile };
  }

  /**
   * Check if a feature is enabled
   */
  isFeatureEnabled(feature: keyof SystemConfig['features']): boolean {
    return this.config.features[feature];
  }

  /**
   * Get environment (development/production/test)
   */
  getEnvironment(): 'development' | 'production' | 'test' {
    return this.config.nodeEnv;
  }

  /**
   * Check if running in production
   */
  isProduction(): boolean {
    return this.config.nodeEnv === 'production';
  }

  /**
   * Check if running in development
   */
  isDevelopment(): boolean {
    return this.config.nodeEnv === 'development';
  }

  /**
   * Get backend server port
   */
  getBackendPort(): number {
    return this.config.backendPort;
  }

  /**
   * Get base directory for all FactoryFactory data
   */
  getBaseDir(): string {
    return this.config.baseDir;
  }

  /**
   * Get worktree base directory
   */
  getWorktreeBaseDir(): string {
    return this.config.worktreeBaseDir;
  }

  /**
   * Get debug log directory
   */
  getDebugLogDir(): string {
    return this.config.debugLogDir;
  }

  /**
   * Get database file path (SQLite)
   */
  getDatabasePath(): string {
    return this.config.databasePath;
  }

  /**
   * Get available model options
   */
  getAvailableModels(): { alias: string; model: string }[] {
    return Object.entries(MODEL_MAPPING).map(([alias, model]) => ({ alias, model }));
  }

  /**
   * Get available permission modes
   */
  getAvailablePermissionModes(): PermissionMode[] {
    return ['strict', 'relaxed', 'yolo'];
  }

  /**
   * Reload configuration from environment
   */
  reload(): void {
    this.config = loadSystemConfig();
    this.validateConfig();
    logger.info('Configuration reloaded');
  }
}

// Export singleton instance
export const configService = new ConfigService();
