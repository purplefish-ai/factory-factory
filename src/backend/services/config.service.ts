/**
 * Configuration Service
 *
 * Centralized configuration management for FactoryFactory.
 * Handles environment variables, and runtime configuration.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandEnvVars } from '@/backend/lib/env';
import { ConfigEnvSchema } from './env-schemas';
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
type ConfigEnv = ReturnType<typeof ConfigEnvSchema.parse>;

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
  reposDir: string;
  debugLogDir: string;
  acpTraceLogsPath: string;
  claudeConfigDir: string;
  wsLogsPath: string;
  frontendStaticPath?: string;

  // Server settings
  backendPort: number;
  nodeEnv: 'development' | 'production' | 'test';
  webConcurrency?: number;

  // Database (SQLite)
  databasePath: string;

  // Default session profile
  defaultSessionProfile: SessionProfile;

  // Health check settings
  healthCheckIntervalMs: number;

  // Session limits
  maxSessionsPerWorkspace: number;

  // Logger settings
  logger: LoggerConfig;

  // Rate limiter settings
  rateLimiter: RateLimiterConfig;

  // Notification settings
  notification: NotificationConfig;

  // CORS settings
  cors: CorsConfig;

  // Debug settings
  debug: DebugConfig;

  // ACP/runtime settings
  acpStartupTimeoutMs: number;
  acpTraceLogsEnabled: boolean;
  wsLogsEnabled: boolean;
  runScriptProxyEnabled: boolean;

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
 * Build default session profile from environment
 */
function buildDefaultSessionProfile(env: ConfigEnv): SessionProfile {
  const defaultModel = 'claude-sonnet-4-5-20250929';

  return {
    model: resolveModel(env.DEFAULT_MODEL, defaultModel),
    permissionMode: env.DEFAULT_PERMISSIONS,
    maxTokens: 8192,
    temperature: 1.0,
  };
}

/**
 * Build logger configuration from environment
 */
function buildLoggerConfig(nodeEnv: string, env: ConfigEnv): LoggerConfig {
  return {
    level: env.LOG_LEVEL,
    prettyPrint: nodeEnv !== 'production',
    serviceName: env.SERVICE_NAME,
  };
}

/**
 * Build rate limiter configuration from environment
 */
function buildRateLimiterConfig(env: ConfigEnv): RateLimiterConfig {
  return {
    claudeRequestsPerMinute: env.CLAUDE_RATE_LIMIT_PER_MINUTE,
    claudeRequestsPerHour: env.CLAUDE_RATE_LIMIT_PER_HOUR,
    maxQueueSize: env.RATE_LIMIT_QUEUE_SIZE,
    queueTimeoutMs: env.RATE_LIMIT_QUEUE_TIMEOUT_MS,
  };
}

/**
 * Build notification configuration from environment
 */
function buildNotificationConfig(env: ConfigEnv): NotificationConfig {
  return {
    soundEnabled: env.NOTIFICATION_SOUND_ENABLED,
    pushEnabled: env.NOTIFICATION_PUSH_ENABLED,
    soundFile: env.NOTIFICATION_SOUND_FILE,
    quietHoursStart: env.NOTIFICATION_QUIET_HOURS_START,
    quietHoursEnd: env.NOTIFICATION_QUIET_HOURS_END,
  };
}

/**
 * Build CORS configuration from environment
 */
function buildCorsConfig(env: ConfigEnv): CorsConfig {
  const originsEnv = env.CORS_ALLOWED_ORIGINS;
  const defaultOrigins = ['http://localhost:3000', 'http://localhost:3001'];

  return {
    allowedOrigins: originsEnv ? originsEnv.split(',').map((o) => o.trim()) : defaultOrigins,
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
  const env = ConfigEnvSchema.parse(process.env);
  // Expand any environment variables in BASE_DIR (e.g., $USER, $HOME)
  const rawBaseDir = env.BASE_DIR;
  const baseDir = rawBaseDir ? expandEnvVars(rawBaseDir) : getDefaultBaseDir();

  // Expand any environment variables in WORKTREE_BASE_DIR
  const rawWorktreeDir = env.WORKTREE_BASE_DIR;
  const worktreeBaseDir = rawWorktreeDir
    ? expandEnvVars(rawWorktreeDir)
    : join(baseDir, 'worktrees');

  const nodeEnv = env.NODE_ENV;
  const debugLogDir = join(baseDir, 'debug');
  const acpTraceLogsEnabled = env.ACP_TRACE_LOGS_ENABLED ?? nodeEnv === 'development';

  const config: SystemConfig = {
    // Directory paths
    baseDir,
    worktreeBaseDir,
    reposDir: env.REPOS_DIR ? expandEnvVars(env.REPOS_DIR) : join(baseDir, 'repos'),
    debugLogDir,
    acpTraceLogsPath: env.ACP_TRACE_LOGS_PATH ?? join(debugLogDir, 'acp-events'),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    wsLogsPath: env.WS_LOGS_PATH ?? join(process.cwd(), '.context', 'ws-logs'),
    frontendStaticPath: env.FRONTEND_STATIC_PATH,

    // Server settings
    backendPort: env.BACKEND_PORT,
    nodeEnv,
    webConcurrency: env.WEB_CONCURRENCY,

    // Database (SQLite - defaults to ~/factory-factory/data.db)
    databasePath: env.DATABASE_PATH ?? join(baseDir, 'data.db'),

    // Default session profile
    defaultSessionProfile: buildDefaultSessionProfile(env),

    // Health check settings
    healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL_MS, // 5 minutes

    // Session limits
    maxSessionsPerWorkspace: env.MAX_SESSIONS_PER_WORKSPACE,

    // Logger settings
    logger: buildLoggerConfig(nodeEnv, env),

    // Rate limiter settings
    rateLimiter: buildRateLimiterConfig(env),

    // Notification settings
    notification: buildNotificationConfig(env),

    // CORS settings
    cors: buildCorsConfig(env),

    // Debug settings
    debug: {
      chatWebSocket: env.DEBUG_CHAT_WS,
    },

    // ACP/runtime settings
    acpStartupTimeoutMs: env.ACP_STARTUP_TIMEOUT_MS,
    acpTraceLogsEnabled,
    wsLogsEnabled: env.WS_LOGS_ENABLED,
    runScriptProxyEnabled: env.FF_RUN_SCRIPT_PROXY_ENABLED,

    // Event compression settings
    compression: {
      enabled: env.EVENT_COMPRESSION_ENABLED,
    },

    // Conversation rename settings
    branchRenameMessageThreshold: env.BRANCH_RENAME_MESSAGE_THRESHOLD,

    // App version
    appVersion: env.npm_package_version ?? '0.1.0',
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
   * Get repos directory for cloned GitHub repositories
   */
  getReposDir(): string {
    return this.config.reposDir;
  }

  /**
   * Get debug log directory
   */
  getDebugLogDir(): string {
    return this.config.debugLogDir;
  }

  /**
   * Get ACP startup timeout in milliseconds
   */
  getAcpStartupTimeoutMs(): number {
    return this.config.acpStartupTimeoutMs;
  }

  /**
   * Check if ACP trace logging is enabled
   */
  isAcpTraceLoggingEnabled(): boolean {
    return this.config.acpTraceLogsEnabled;
  }

  /**
   * Get ACP trace logs path
   */
  getAcpTraceLogsPath(): string {
    return this.config.acpTraceLogsPath;
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
   * Check if session WebSocket file logging is enabled
   */
  isWsLogsEnabled(): boolean {
    return this.config.wsLogsEnabled;
  }

  /**
   * Get runtime WEB_CONCURRENCY hint if configured
   */
  getWebConcurrency(): number | undefined {
    return this.config.webConcurrency;
  }

  /**
   * Check if run-script proxy is enabled
   */
  isRunScriptProxyEnabled(): boolean {
    return this.config.runScriptProxyEnabled;
  }

  /**
   * Get Claude config directory path
   */
  getClaudeConfigDir(): string {
    return this.config.claudeConfigDir;
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
