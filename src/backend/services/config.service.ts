/**
 * Configuration Service
 *
 * Centralized configuration management for FactoryFactory.
 * Handles agent profiles, environment variables, and runtime configuration.
 */

import type { AgentType } from '@prisma-gen/client';
import { createLogger } from './logger.service.js';

const logger = createLogger('config');

/**
 * Permission modes for agents
 */
export type PermissionMode = 'strict' | 'relaxed' | 'yolo';

/**
 * Agent execution profile
 */
export interface AgentProfile {
  model: string;
  permissionMode: PermissionMode;
  maxTokens: number;
  temperature: number;
}

/**
 * System configuration
 */
export interface SystemConfig {
  // Server settings
  backendPort: number;
  frontendPort: number;
  nodeEnv: 'development' | 'production' | 'test';

  // Database
  databaseUrl: string;

  // Inngest
  inngestEventKey?: string;
  inngestSigningKey?: string;

  // Claude API
  anthropicApiKey: string;

  // Agent defaults
  defaultAgentProfiles: Record<AgentType, AgentProfile>;

  // Health check settings
  healthCheckIntervalMs: number;
  agentHeartbeatThresholdMinutes: number;

  // Crash recovery settings
  maxWorkerAttempts: number;
  crashLoopThresholdMs: number;
  maxRapidCrashes: number;

  // PR review settings
  prReviewTimeoutMinutes: number;

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
 * Build default agent profiles from environment
 */
function buildDefaultAgentProfiles(): Record<AgentType, AgentProfile> {
  const defaultModel = 'claude-sonnet-4-5-20250929';

  return {
    ORCHESTRATOR: {
      model: resolveModel(process.env.ORCHESTRATOR_MODEL, defaultModel),
      permissionMode: resolvePermissionMode(process.env.ORCHESTRATOR_PERMISSIONS, 'strict'),
      maxTokens: 8192,
      temperature: 1.0,
    },
    SUPERVISOR: {
      model: resolveModel(process.env.SUPERVISOR_MODEL, defaultModel),
      permissionMode: resolvePermissionMode(process.env.SUPERVISOR_PERMISSIONS, 'relaxed'),
      maxTokens: 8192,
      temperature: 1.0,
    },
    WORKER: {
      model: resolveModel(process.env.WORKER_MODEL, defaultModel),
      permissionMode: resolvePermissionMode(process.env.WORKER_PERMISSIONS, 'yolo'),
      maxTokens: 8192,
      temperature: 1.0,
    },
  };
}

/**
 * Load system configuration from environment
 */
function loadSystemConfig(): SystemConfig {
  const config: SystemConfig = {
    // Server settings
    backendPort: parseInt(process.env.BACKEND_PORT || '3001', 10),
    frontendPort: parseInt(process.env.FRONTEND_PORT || '3000', 10),
    nodeEnv: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',

    // Database
    databaseUrl: process.env.DATABASE_URL || '',

    // Inngest
    inngestEventKey: process.env.INNGEST_EVENT_KEY,
    inngestSigningKey: process.env.INNGEST_SIGNING_KEY,

    // Claude API
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

    // Agent defaults
    defaultAgentProfiles: buildDefaultAgentProfiles(),

    // Health check settings
    healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '300000', 10), // 5 minutes
    agentHeartbeatThresholdMinutes: parseInt(
      process.env.AGENT_HEARTBEAT_THRESHOLD_MINUTES || '7',
      10
    ),

    // Crash recovery settings
    maxWorkerAttempts: parseInt(process.env.MAX_WORKER_ATTEMPTS || '5', 10),
    crashLoopThresholdMs: parseInt(process.env.CRASH_LOOP_THRESHOLD_MS || '60000', 10), // 1 minute
    maxRapidCrashes: parseInt(process.env.MAX_RAPID_CRASHES || '3', 10),

    // PR review settings
    prReviewTimeoutMinutes: parseInt(process.env.PR_REVIEW_TIMEOUT_MINUTES || '60', 10),

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
export class ConfigService {
  private config: SystemConfig;
  private agentProfileOverrides: Map<string, Partial<AgentProfile>> = new Map();

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

    if (!this.config.anthropicApiKey) {
      errors.push('ANTHROPIC_API_KEY is not set');
    }

    if (!this.config.databaseUrl) {
      errors.push('DATABASE_URL is not set');
    }

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
   * Get agent profile for a given agent type
   */
  getAgentProfile(type: AgentType): AgentProfile {
    return { ...this.config.defaultAgentProfiles[type] };
  }

  /**
   * Get agent profile with optional overrides for a specific agent
   */
  getAgentProfileForId(agentId: string, type: AgentType): AgentProfile {
    const baseProfile = this.getAgentProfile(type);
    const overrides = this.agentProfileOverrides.get(agentId);

    if (overrides) {
      return { ...baseProfile, ...overrides };
    }

    return baseProfile;
  }

  /**
   * Set agent profile override for a specific agent
   */
  setAgentProfileOverride(agentId: string, override: Partial<AgentProfile>): void {
    this.agentProfileOverrides.set(agentId, override);
    logger.info('Agent profile override set', { agentId, override });
  }

  /**
   * Remove agent profile override
   */
  removeAgentProfileOverride(agentId: string): void {
    this.agentProfileOverrides.delete(agentId);
    logger.info('Agent profile override removed', { agentId });
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
