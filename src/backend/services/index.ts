/**
 * Services Index
 *
 * Central export point for all backend services.
 */

// Configuration service
export {
  type AgentProfile,
  ConfigService,
  configService,
  type PermissionMode,
  type SystemConfig,
} from './config.service.js';
// Crash recovery service
export {
  CrashRecoveryService,
  crashRecoveryService,
  type RecoveryResult,
  type SystemHealthStatus,
} from './crash-recovery.service.js';
// Logger service
export {
  createLogger,
  Logger,
  type LoggerConfig,
  type LogLevel,
  logger,
} from './logger.service.js';
// Notification service
export {
  type NotificationConfig,
  NotificationService,
  notificationService,
} from './notification.service.js';
// PR conflict service
export {
  type MergeConflictInfo,
  PrConflictService,
  type PrCreationResult,
  prConflictService,
  type RebaseResult,
} from './pr-conflict.service.js';
// Rate limiter service
export {
  type ApiUsageStats,
  type ConcurrencyStats,
  RateLimiter,
  type RateLimiterConfig,
  RequestPriority,
  rateLimiter,
} from './rate-limiter.service.js';
// Validation service
export {
  type BranchNameValidation,
  type EpicDesignValidation,
  type ValidationResult,
  ValidationService,
  validationService,
} from './validation.service.js';
// Worktree service
export {
  type CleanupResult,
  type OrphanedWorktree,
  type WorktreeInfo,
  WorktreeService,
  worktreeService,
} from './worktree.service.js';
