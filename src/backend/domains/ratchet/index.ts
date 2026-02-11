// Domain: ratchet
// Public API for the ratchet domain module.
// Consumers should import from '@/backend/domains/ratchet' only.

// Bridge interfaces for orchestration layer wiring
export type {
  RatchetGitHubBridge,
  RatchetPRFullDetails,
  RatchetPRStateSnapshot,
  RatchetReviewComment,
  RatchetSessionBridge,
  RatchetStatusCheckInput,
  RatchetWorkspaceBridge,
} from './bridges';

export type { CIFailureDetails, CIFixResult } from './ci-fixer.service';
// CI fixer
export { ciFixerService } from './ci-fixer.service';

// CI monitor (legacy, deprecated in favor of ratchet service)
export { ciMonitorService } from './ci-monitor.service';
export type {
  AcquireAndDispatchInput,
  AcquireAndDispatchResult,
  RunningIdleSessionAction,
} from './fixer-session.service';
// Shared fixer session acquisition
export { fixerSessionService } from './fixer-session.service';
export type {
  RatchetAction,
  RatchetCheckResult,
  RatchetStateChangedEvent,
  WorkspaceRatchetResult,
} from './ratchet.service';
// Core ratchet polling and dispatch
export { RATCHET_STATE_CHANGED, ratchetService } from './ratchet.service';

// Reconciliation (workspace/session cleanup)
export { reconciliationService } from './reconciliation.service';
