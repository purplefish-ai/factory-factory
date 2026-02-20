import { z } from 'zod';

const PermissionModeSchema = z.enum(['strict', 'relaxed', 'yolo']);
const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);
const NodeEnvSchema = z.enum(['development', 'production', 'test']);

function parseInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toLowerString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

const PositiveIntEnvSchema = z.preprocess(parseInteger, z.number().int().positive());
const HourEnvSchema = z.preprocess(parseInteger, z.number().int().min(0).max(23));

export const LoggerEnvSchema = z.object({
  LOG_LEVEL: z.preprocess(toLowerString, LogLevelSchema).catch('info'),
  SERVICE_NAME: z.preprocess(toTrimmedString, z.string().min(1)).catch('factoryfactory'),
  NODE_ENV: z.preprocess(toLowerString, NodeEnvSchema).catch('development'),
});

export const ConfigEnvSchema = z.object({
  DEFAULT_MODEL: z.preprocess(toTrimmedString, z.string()).optional(),
  DEFAULT_PERMISSIONS: z.preprocess(toLowerString, PermissionModeSchema).catch('yolo'),
  LOG_LEVEL: z.preprocess(toLowerString, LogLevelSchema).catch('info'),
  SERVICE_NAME: z.preprocess(toTrimmedString, z.string().min(1)).catch('factoryfactory'),
  CLAUDE_RATE_LIMIT_PER_MINUTE: PositiveIntEnvSchema.catch(60),
  CLAUDE_RATE_LIMIT_PER_HOUR: PositiveIntEnvSchema.catch(1000),
  RATE_LIMIT_QUEUE_SIZE: PositiveIntEnvSchema.catch(100),
  RATE_LIMIT_QUEUE_TIMEOUT_MS: PositiveIntEnvSchema.catch(30_000),
  NOTIFICATION_SOUND_ENABLED: z.preprocess(parseBoolean, z.boolean()).catch(true),
  NOTIFICATION_PUSH_ENABLED: z.preprocess(parseBoolean, z.boolean()).catch(true),
  NOTIFICATION_SOUND_FILE: z.preprocess(toTrimmedString, z.string()).optional(),
  NOTIFICATION_QUIET_HOURS_START: HourEnvSchema.optional().catch(undefined),
  NOTIFICATION_QUIET_HOURS_END: HourEnvSchema.optional().catch(undefined),
  CORS_ALLOWED_ORIGINS: z.preprocess(toTrimmedString, z.string()).optional(),
  BASE_DIR: z.preprocess(toTrimmedString, z.string()).optional(),
  WORKTREE_BASE_DIR: z.preprocess(toTrimmedString, z.string()).optional(),
  REPOS_DIR: z.preprocess(toTrimmedString, z.string()).optional(),
  NODE_ENV: z.preprocess(toLowerString, NodeEnvSchema).catch('development'),
  WS_LOGS_PATH: z.preprocess(toTrimmedString, z.string()).optional(),
  FRONTEND_STATIC_PATH: z.preprocess(toTrimmedString, z.string()).optional(),
  BACKEND_PORT: PositiveIntEnvSchema.catch(3001),
  DATABASE_PATH: z.preprocess(toTrimmedString, z.string()).optional(),
  HEALTH_CHECK_INTERVAL_MS: PositiveIntEnvSchema.catch(300_000),
  MAX_SESSIONS_PER_WORKSPACE: PositiveIntEnvSchema.catch(5),
  FEATURE_AUTHENTICATION: z.preprocess(parseBoolean, z.boolean()).catch(false),
  FEATURE_METRICS: z.preprocess(parseBoolean, z.boolean()).catch(false),
  FEATURE_ERROR_TRACKING: z.preprocess(parseBoolean, z.boolean()).catch(false),
  DEBUG_CHAT_WS: z.preprocess(parseBoolean, z.boolean()).catch(false),
  EVENT_COMPRESSION_ENABLED: z.preprocess(parseBoolean, z.boolean()).catch(true),
  BRANCH_RENAME_MESSAGE_THRESHOLD: PositiveIntEnvSchema.catch(2),
  npm_package_version: z.preprocess(toTrimmedString, z.string()).optional(),
});

export type LogLevel = z.infer<typeof LogLevelSchema>;
