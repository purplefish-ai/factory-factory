/**
 * Services Index
 *
 * Central export point for all backend services.
 */

// Configuration service
export { configService } from './config.service.js';
// Crash recovery service
export { crashRecoveryService } from './crash-recovery.service.js';
// Logger service
export { createLogger } from './logger.service.js';
// Notification service
export { notificationService } from './notification.service.js';
// Rate limiter service
export { rateLimiter } from './rate-limiter.service.js';
// Worktree service
export {
  type CleanupResult,
  type OrphanedWorktree,
  type WorktreeInfo,
  WorktreeService,
  worktreeService,
} from './worktree.service.js';
