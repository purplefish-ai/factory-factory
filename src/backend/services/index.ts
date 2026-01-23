/**
 * Services Index
 *
 * Central export point for all backend services.
 */

// Logger service
export { Logger, createLogger, logger, type LogLevel, type LoggerConfig } from './logger.service.js';

// Rate limiter service
export {
  RateLimiter,
  rateLimiter,
  RequestPriority,
  type RateLimiterConfig,
  type ApiUsageStats,
  type ConcurrencyStats,
} from './rate-limiter.service.js';

// Configuration service
export {
  ConfigService,
  configService,
  type PermissionMode,
  type AgentProfile,
  type SystemConfig,
} from './config.service.js';

// Validation service
export {
  ValidationService,
  validationService,
  type ValidationResult,
  type EpicDesignValidation,
  type BranchNameValidation,
} from './validation.service.js';

// Crash recovery service
export {
  CrashRecoveryService,
  crashRecoveryService,
  type RecoveryResult,
  type SystemHealthStatus,
} from './crash-recovery.service.js';

// Worktree service
export {
  WorktreeService,
  worktreeService,
  type WorktreeInfo,
  type OrphanedWorktree,
  type CleanupResult,
} from './worktree.service.js';

// Notification service
export {
  NotificationService,
  notificationService,
  type NotificationConfig,
} from './notification.service.js';

// PR conflict service
export {
  PrConflictService,
  prConflictService,
  type PrCreationResult,
  type RebaseResult,
  type MergeConflictInfo,
} from './pr-conflict.service.js';
