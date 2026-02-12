/**
 * Configuration Service
 *
 * Centralized configuration management for FactoryFactory.
 * Handles environment variables, and runtime configuration.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandEnvVars } from '@/backend/lib/env';
import { SERVICE_TIMEOUT_MS } from './constants';
import { createLogger } from './logger.service';

const logger = createLogger('config');

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
 * Log levels for the logger service
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Logger configuration
 */
export interface LoggerConfig {
  level: LogLevel;
  prettyPrint: boolean;
  serviceName: string;
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  claudeRequestsPerMinute: number;
  claudeRequestsPerHour: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

/**
 * Notification configuration
 */
export interface NotificationConfig {
  soundEnabled: boolean;
  pushEnabled: boolean;
  soundFile?: string;
  quietHoursStart?: number;
  quietHoursEnd?: number;
}

/**
 * Claude process configuration
 */
export interface ClaudeProcessConfig {
  hungTimeoutMs: number;
}

/**
 * Codex app-server process configuration
 */
export interface CodexAppServerConfig {
  command: string;
  args: string[];
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  requestUserInputEnabled: boolean;
}

/**
 * CORS configuration
 */
export interface CorsConfig {
  allowedOrigins: string[];
}

/**
 * Debug configuration
 */
export interface DebugConfig {
  chatWebSocket: boolean;
}

/**
 * Event compression configuration for replay optimization
 */
export interface CompressionConfig {
  enabled: boolean;
}

/**
 * System configuration
 */
interface SystemConfig {
  // Directory paths
  baseDir: string;
  worktreeBaseDir: string;
  debugLogDir: string;
  wsLogsPath: string;
  frontendStaticPath?: string;

  // Server settings
  backendPort: number;
  nodeEnv: 'development' | 'production' | 'test';

  // Database (SQLite)
  databasePath: string;

  // Default session profile
  defaultSessionProfile: SessionProfile;

  // Health check settings
  healthCheckIntervalMs: number;

  // Session limits
  maxSessionsPerWorkspace: number;

  // Feature flags
  features: {
    authentication: boolean;
    metrics: boolean;
    errorTracking: boolean;
  };

  // Logger settings
  logger: LoggerConfig;

  // Rate limiter settings
  rateLimiter: RateLimiterConfig;

  // Notification settings
  notification: NotificationConfig;

  // Claude process settings
  claudeProcess: ClaudeProcessConfig;

  // Codex app-server settings
  codexAppServer: CodexAppServerConfig;

  // CORS settings
  cors: CorsConfig;

  // Debug settings
  debug: DebugConfig;

  // Event compression settings
  compression: CompressionConfig;

  // Conversation rename settings
  branchRenameMessageThreshold: number;

  // App version
  appVersion: string;
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
 * Build logger configuration from environment
 */
function buildLoggerConfig(nodeEnv: string): LoggerConfig {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  const validLevels: LogLevel[] = ['error', 'warn', 'info', 'debug'];

  return {
    level: validLevels.includes(envLevel as LogLevel) ? (envLevel as LogLevel) : 'info',
    prettyPrint: nodeEnv !== 'production',
    serviceName: process.env.SERVICE_NAME || 'factoryfactory',
  };
}

/**
 * Build rate limiter configuration from environment
 */
function buildRateLimiterConfig(): RateLimiterConfig {
  return {
    claudeRequestsPerMinute: Number.parseInt(process.env.CLAUDE_RATE_LIMIT_PER_MINUTE || '60', 10),
    claudeRequestsPerHour: Number.parseInt(process.env.CLAUDE_RATE_LIMIT_PER_HOUR || '1000', 10),
    maxQueueSize: Number.parseInt(process.env.RATE_LIMIT_QUEUE_SIZE || '100', 10),
    queueTimeoutMs: Number.parseInt(process.env.RATE_LIMIT_QUEUE_TIMEOUT_MS || '30000', 10),
  };
}

/**
 * Build notification configuration from environment
 */
function buildNotificationConfig(): NotificationConfig {
  return {
    soundEnabled: process.env.NOTIFICATION_SOUND_ENABLED !== 'false',
    pushEnabled: process.env.NOTIFICATION_PUSH_ENABLED !== 'false',
    soundFile: process.env.NOTIFICATION_SOUND_FILE,
    quietHoursStart: process.env.NOTIFICATION_QUIET_HOURS_START
      ? Number.parseInt(process.env.NOTIFICATION_QUIET_HOURS_START, 10)
      : undefined,
    quietHoursEnd: process.env.NOTIFICATION_QUIET_HOURS_END
      ? Number.parseInt(process.env.NOTIFICATION_QUIET_HOURS_END, 10)
      : undefined,
  };
}

/**
 * Build CORS configuration from environment
 */
function buildCorsConfig(): CorsConfig {
  const originsEnv = process.env.CORS_ALLOWED_ORIGINS;
  const defaultOrigins = ['http://localhost:3000', 'http://localhost:3001'];

  return {
    allowedOrigins: originsEnv ? originsEnv.split(',').map((o) => o.trim()) : defaultOrigins,
  };
}

/**
 * Build Claude process configuration from environment with validation
 */
function buildClaudeProcessConfig(): ClaudeProcessConfig {
  const envValue = process.env.CLAUDE_HUNG_TIMEOUT_MS;

  if (!envValue) {
    return { hungTimeoutMs: SERVICE_TIMEOUT_MS.configDefaultClaudeHung };
  }

  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn(`Invalid CLAUDE_HUNG_TIMEOUT_MS value: ${envValue}, using default (60 minutes)`);
    return { hungTimeoutMs: SERVICE_TIMEOUT_MS.configDefaultClaudeHung };
  }

  return { hungTimeoutMs: parsed };
}

/**
 * Build Codex app-server configuration from environment with validation.
 */
function buildCodexAppServerConfig(): CodexAppServerConfig {
  const command = process.env.CODEX_APP_SERVER_COMMAND || 'codex';
  const argsEnv = process.env.CODEX_APP_SERVER_ARGS?.trim();
  const args = argsEnv && argsEnv.length > 0 ? argsEnv.split(/\s+/) : ['app-server'];

  const requestTimeoutMs = Number.parseInt(
    process.env.CODEX_APP_SERVER_REQUEST_TIMEOUT_MS ||
      String(SERVICE_TIMEOUT_MS.codexAppServerRequest),
    10
  );
  const handshakeTimeoutMs = Number.parseInt(
    process.env.CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS ||
      String(SERVICE_TIMEOUT_MS.codexAppServerHandshake),
    10
  );

  return {
    command,
    args,
    requestTimeoutMs:
      Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? requestTimeoutMs
        : SERVICE_TIMEOUT_MS.codexAppServerRequest,
    handshakeTimeoutMs:
      Number.isFinite(handshakeTimeoutMs) && handshakeTimeoutMs > 0
        ? handshakeTimeoutMs
        : SERVICE_TIMEOUT_MS.codexAppServerHandshake,
    requestUserInputEnabled: process.env.CODEX_REQUEST_USER_INPUT_ENABLED === 'true',
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

  const nodeEnv = (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development';

  const config: SystemConfig = {
    // Directory paths
    baseDir,
    worktreeBaseDir,
    debugLogDir: join(baseDir, 'debug'),
    wsLogsPath: process.env.WS_LOGS_PATH || join(process.cwd(), '.context', 'ws-logs'),
    frontendStaticPath: process.env.FRONTEND_STATIC_PATH,

    // Server settings
    backendPort: Number.parseInt(process.env.BACKEND_PORT || '3001', 10),
    nodeEnv,

    // Database (SQLite - defaults to ~/factory-factory/data.db)
    databasePath: process.env.DATABASE_PATH || join(baseDir, 'data.db'),

    // Default session profile
    defaultSessionProfile: buildDefaultSessionProfile(),

    // Health check settings
    healthCheckIntervalMs: Number.parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '300000', 10), // 5 minutes

    // Session limits
    maxSessionsPerWorkspace: Number.parseInt(process.env.MAX_SESSIONS_PER_WORKSPACE || '5', 10),

    // Feature flags
    features: {
      authentication: process.env.FEATURE_AUTHENTICATION === 'true',
      metrics: process.env.FEATURE_METRICS === 'true',
      errorTracking: process.env.FEATURE_ERROR_TRACKING === 'true',
    },

    // Logger settings
    logger: buildLoggerConfig(nodeEnv),

    // Rate limiter settings
    rateLimiter: buildRateLimiterConfig(),

    // Notification settings
    notification: buildNotificationConfig(),

    // Claude process settings
    claudeProcess: buildClaudeProcessConfig(),

    // Codex app-server settings
    codexAppServer: buildCodexAppServerConfig(),

    // CORS settings
    cors: buildCorsConfig(),

    // Debug settings
    debug: {
      chatWebSocket: process.env.DEBUG_CHAT_WS === 'true',
    },

    // Event compression settings
    compression: {
      enabled: process.env.EVENT_COMPRESSION_ENABLED !== 'false',
    },

    // Conversation rename settings
    branchRenameMessageThreshold: Number.parseInt(
      process.env.BRANCH_RENAME_MESSAGE_THRESHOLD || '2',
      10
    ),

    // App version
    appVersion: process.env.npm_package_version || '0.1.0',
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
   * Get max sessions per workspace
   */
  getMaxSessionsPerWorkspace(): number {
    return this.config.maxSessionsPerWorkspace;
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
   * Get rate limiter configuration
   */
  getRateLimiterConfig(): RateLimiterConfig {
    return { ...this.config.rateLimiter };
  }

  /**
   * Get notification configuration
   */
  getNotificationConfig(): NotificationConfig {
    return { ...this.config.notification };
  }

  /**
   * Get Claude process configuration
   */
  getClaudeProcessConfig(): ClaudeProcessConfig {
    return { ...this.config.claudeProcess };
  }

  /**
   * Get Codex app-server configuration
   */
  getCodexAppServerConfig(): CodexAppServerConfig {
    return {
      ...this.config.codexAppServer,
      args: [...this.config.codexAppServer.args],
    };
  }

  /**
   * Get CORS configuration
   */
  getCorsConfig(): CorsConfig {
    return { ...this.config.cors };
  }

  /**
   * Get debug configuration
   */
  getDebugConfig(): DebugConfig {
    return { ...this.config.debug };
  }

  /**
   * Get WebSocket logs path
   */
  getWsLogsPath(): string {
    return this.config.wsLogsPath;
  }

  /**
   * Get frontend static path (if configured)
   */
  getFrontendStaticPath(): string | undefined {
    return this.config.frontendStaticPath;
  }

  /**
   * Get branch rename message threshold
   */
  getBranchRenameMessageThreshold(): number {
    return this.config.branchRenameMessageThreshold;
  }

  /**
   * Get app version
   */
  getAppVersion(): string {
    return this.config.appVersion;
  }

  /**
   * Get event compression configuration for replay optimization
   */
  getCompressionConfig(): CompressionConfig {
    return { ...this.config.compression };
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
